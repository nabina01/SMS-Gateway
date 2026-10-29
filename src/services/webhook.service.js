import { createHmac, timingSafeEqual } from "node:crypto";
import prisma from "../config/prisma.js";
import { createHttpError } from "../utils/errors.js";
import { tableExists } from "../utils/db-introspection.js";

function getHeader(headers, names) {
  for (const name of names) {
    const value = headers?.[name];
    if (value !== undefined) {
      const first = Array.isArray(value) ? value[0] : value;
      return String(first).trim();
    }
  }
  return "";
}

export function computeWebhookSignature({ timestamp, rawBody, secret }) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export function verifyWebhookSignature({
  headers,
  rawBody,
  secret = process.env.SMS_WEBHOOK_SECRET,
  toleranceSeconds = Number(process.env.SMS_WEBHOOK_TOLERANCE_SECONDS || 300),
} = {}) {
  if (!secret) {
    throw createHttpError(
      "Delivery webhook is disabled because SMS_WEBHOOK_SECRET is not configured",
      503
    );
  }

  const timestamp = getHeader(headers, ["x-sms-timestamp", "x-provider-timestamp"]);
  const signatureHeader = getHeader(headers, [
    "x-sms-signature",
    "x-provider-signature",
  ]);

  if (!timestamp || !signatureHeader) {
    throw createHttpError(
      "Missing webhook timestamp or signature header",
      401
    );
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    throw createHttpError("Invalid webhook timestamp", 401);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    Number.isFinite(toleranceSeconds) &&
    toleranceSeconds > 0 &&
    Math.abs(nowSeconds - timestampNumber) > toleranceSeconds
  ) {
    throw createHttpError("Webhook timestamp is outside the allowed window", 401);
  }

  if (typeof rawBody !== "string" || rawBody.length === 0) {
    throw createHttpError("Raw webhook body is required for signature validation", 400);
  }

  const expected = computeWebhookSignature({ timestamp, rawBody, secret });
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw createHttpError("Invalid webhook signature", 401);
  }

  return { timestamp, signature: expected };
}

/**
 * Process a signed delivery report for one of our sent SMS logs.
 *
 * Contract:
 *   POST /webhooks/sms/delivery
 *   Headers: x-sms-signature: sha256=<hmac>, x-sms-timestamp: <unix seconds>
 *   Body: { messageId, provider, status: "delivered"|"failed",
 *           providerMessageId?, error? }
 */
export async function processDeliveryReport({ headers, rawBody, payload }) {
  const { timestamp } = verifyWebhookSignature({ headers, rawBody });

  if (!(await tableExists("sms_delivery_reports"))) {
    throw createHttpError(
      "Delivery reports are not available until the additive bonus migration is applied",
      503
    );
  }

  if (!payload || typeof payload !== "object") {
    throw createHttpError("Invalid webhook payload", 400);
  }

  const providerName =
    typeof payload.provider === "string" ? payload.provider.trim() : "";
  const messageId = payload.messageId ?? payload.logId;
  const status = typeof payload.status === "string" ? payload.status : "";

  if (!providerName) {
    throw createHttpError("Webhook payload must include 'provider'", 400);
  }
  if (messageId === undefined || messageId === null || messageId === "") {
    throw createHttpError("Webhook payload must include 'messageId'", 400);
  }
  if (!["delivered", "failed"].includes(status)) {
    throw createHttpError(
      "Webhook status must be either 'delivered' or 'failed'",
      400
    );
  }

  let logId;
  try {
    logId = BigInt(String(messageId));
  } catch {
    throw createHttpError("messageId must be a numeric SMS log id", 400);
  }

  const provider = await prisma.sms_providers.findUnique({
    where: { name: providerName },
  });
  if (!provider) {
    throw createHttpError("Unknown webhook provider", 401);
  }

  const log = await prisma.sms_logs.findUnique({
    where: { id: logId },
    select: { id: true, status: true, provider_id: true, user_id: true },
  });

  if (!log) {
    throw createHttpError("SMS log not found", 404);
  }

  const existing = await prisma.sms_delivery_reports.findUnique({
    where: { sms_log_id: logId },
  });

  if (existing) {
    if (existing.status === status) {
      return {
        duplicate: true,
        logId: logId.toString(),
        deliveryStatus: existing.status,
        receivedAt: existing.received_at.toISOString(),
      };
    }
    throw createHttpError(
      `Conflicting delivery report: message is already '${existing.status}'`,
      409
    );
  }

  if (log.status !== "sent") {
    throw createHttpError(
      `Delivery report rejected: SMS log status is '${log.status}', expected 'sent'`,
      409
    );
  }

  if (log.provider_id === null || log.provider_id.toString() !== provider.id.toString()) {
    throw createHttpError(
      "Provider does not match the provider that routed this message",
      401
    );
  }

  try {
    const report = await prisma.sms_delivery_reports.create({
      data: {
        sms_log_id: logId,
        provider_id: provider.id,
        provider_message_id:
          typeof payload.providerMessageId === "string"
            ? payload.providerMessageId.slice(0, 200)
            : null,
        status,
        error_message:
          typeof payload.error === "string" ? payload.error : null,
        payload,
        received_at: new Date(),
      },
    });

    return {
      duplicate: false,
      logId: logId.toString(),
      deliveryStatus: report.status,
      receivedAt: report.received_at.toISOString(),
    };
  } catch (error) {
    if (error.code === "P2002") {
      const duplicate = await prisma.sms_delivery_reports.findUnique({
        where: { sms_log_id: logId },
      });
      if (duplicate?.status === status) {
        return {
          duplicate: true,
          logId: logId.toString(),
          deliveryStatus: duplicate.status,
          receivedAt: duplicate.received_at.toISOString(),
        };
      }
      throw createHttpError("Conflicting delivery report", 409);
    }
    throw error;
  }
}
