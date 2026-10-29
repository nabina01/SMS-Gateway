import prisma from "../config/prisma.js";
import { tableExists } from "../utils/db-introspection.js";
import { createHttpError } from "../utils/errors.js";
import { normalizeNepaliPhone } from "../utils/phone.utils.js";
import { calculateSmsParts } from "../utils/sms.utils.js";
import { attemptProviderSend } from "./provider.service.js";

const MAX_RECIPIENTS = 100;

function getCreditCostPerPart() {
  const envCost = Number(process.env.SMS_CREDIT_COST_PER_PART || 1);
  return Number.isFinite(envCost) && envCost > 0 ? envCost : 1;
}

function toMoney(value) {
  return Number(value).toFixed(2);
}

export function validateSendPayload(to, message) {
  if (!Array.isArray(to) || to.length === 0) {
    throw createHttpError("'to' must be a non-empty array of phone numbers", 400);
  }

  if (to.length > MAX_RECIPIENTS) {
    throw createHttpError(
      `A maximum of ${MAX_RECIPIENTS} recipients is allowed per request`,
      400
    );
  }

  if (typeof message !== "string" || !message.trim()) {
    throw createHttpError("Message must be a non-empty string", 400);
  }

  const normalizedRecipients = to.map((phone, index) => {
    try {
      return normalizeNepaliPhone(phone);
    } catch (error) {
      throw createHttpError(
        `Invalid recipient at index ${index} ('${String(phone)}'): ${error.message}`,
        400,
        { index, recipient: phone }
      );
    }
  });

  const sms = calculateSmsParts(message);
  const creditCostPerPart = getCreditCostPerPart();
  const costPerRecipient = Number((creditCostPerPart * sms.parts).toFixed(2));
  const totalCost = Number((costPerRecipient * normalizedRecipients.length).toFixed(2));

  return {
    normalizedRecipients,
    sms,
    creditCostPerPart,
    costPerRecipient,
    totalCost,
    totalCostString: toMoney(totalCost),
  };
}

async function reserveCreditsAndCreateLogs({
  userId,
  recipients,
  message,
  sms,
  costPerRecipient,
  totalCostString,
}) {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.credit_wallets.findUnique({
      where: { user_id: BigInt(userId) },
    });

    if (!wallet) {
      throw createHttpError("Credit wallet not found", 404);
    }

    // Conditional atomic decrement: PostgreSQL evaluates the predicate and the
    // decrement in a single UPDATE, so concurrent requests cannot overspend.
    const deduction = await tx.credit_wallets.updateMany({
      where: {
        user_id: BigInt(userId),
        balance: { gte: totalCostString },
      },
      data: {
        balance: { decrement: totalCostString },
        updated_at: new Date(),
      },
    });

    if (deduction.count !== 1) {
      throw createHttpError("Insufficient credits", 402);
    }

    return Promise.all(
      recipients.map((recipient) =>
        tx.sms_logs.create({
          data: {
            user_id: BigInt(userId),
            recipient,
            message,
            parts: sms.parts,
            cost: toMoney(costPerRecipient),
            status: "pending",
          },
        })
      )
    );
  });
}

async function recordAttempt(logId, providerId, status, errorMessage = null) {
  try {
    await prisma.sms_provider_attempts.create({
      data: {
        sms_log_id: logId,
        provider_id: providerId,
        status,
        error_message: errorMessage,
      },
    });
  } catch (error) {
    console.error(`[SMS] Could not record provider attempt for log ${logId}:`, error.message);
  }
}

async function tryProvider({ log, provider, costPerRecipient, options }) {
  let simulation;
  try {
    simulation = await attemptProviderSend(provider, log.id, options);
  } catch (error) {
    return { status: "failed", error: error.message };
  }

  if (!simulation.success) {
    return {
      status: "failed",
      error: simulation.error || "Simulated provider failure",
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Debit the provider first, conditionally, so concurrent sends cannot
      // take a provider below zero.
      const debit = await tx.sms_providers.updateMany({
        where: {
          id: provider.id,
          is_active: true,
          balance: { gte: toMoney(costPerRecipient) },
        },
        data: {
          balance: { decrement: toMoney(costPerRecipient) },
          updated_at: new Date(),
        },
      });

      if (debit.count !== 1) {
        return { status: "failed", error: "Provider balance is insufficient" };
      }

      // Guard against duplicate processing: only a pending log may become sent.
      const logUpdate = await tx.sms_logs.updateMany({
        where: { id: log.id, status: "pending" },
        data: {
          status: "sent",
          provider_id: provider.id,
          failure_reason: null,
          updated_at: new Date(),
        },
      });

      if (logUpdate.count !== 1) {
        // Roll back the provider debit; another worker already handled this log.
        throw new Error("SMS_LOG_ALREADY_PROCESSED");
      }

      await tx.sms_provider_attempts.create({
        data: {
          sms_log_id: log.id,
          provider_id: provider.id,
          status: "sent",
          error_message: null,
        },
      });

      return { status: "sent" };
    });
  } catch (error) {
    if (error.message === "SMS_LOG_ALREADY_PROCESSED") {
      return { status: "already_processed" };
    }
    return { status: "failed", error: error.message };
  }
}

async function refundFailedLog({ logId, userId, costPerRecipient, reason }) {
  return prisma.$transaction(async (tx) => {
    // The conditional transition is the idempotency guard: only the caller that
    // moves pending -> failed may issue the refund.
    const updated = await tx.sms_logs.updateMany({
      where: { id: logId, status: "pending" },
      data: {
        status: "failed",
        failure_reason: reason,
        updated_at: new Date(),
      },
    });

    if (updated.count !== 1) {
      return false;
    }

    await tx.credit_wallets.update({
      where: { user_id: BigInt(userId) },
      data: {
        balance: { increment: toMoney(costPerRecipient) },
        updated_at: new Date(),
      },
    });

    return true;
  });
}

async function processOneLog({ log, userId, costPerRecipient, options }) {
  let lastError = "No active SMS provider has sufficient balance";

  try {
    const providers = await prisma.sms_providers.findMany({
      where: {
        is_active: true,
        balance: { gte: toMoney(costPerRecipient) },
      },
      orderBy: { priority: "asc" },
    });

    for (const provider of providers) {
      const outcome = await tryProvider({
        log,
        provider,
        costPerRecipient,
        options,
      });

      if (outcome.status === "sent") {
        return {
          logId: log.id.toString(),
          recipient: log.recipient,
          status: "sent",
          parts: log.parts,
          cost: toMoney(costPerRecipient),
          provider: {
            id: provider.id.toString(),
            name: provider.name,
            priority: provider.priority,
          },
        };
      }

      if (outcome.status === "already_processed") {
        return {
          logId: log.id.toString(),
          recipient: log.recipient,
          status: "already_processed",
          parts: log.parts,
          cost: toMoney(costPerRecipient),
          provider: null,
        };
      }

      lastError = outcome.error || "Provider send failed";
      await recordAttempt(log.id, provider.id, "failed", lastError);
    }
  } catch (error) {
    lastError = error.message || "Provider processing failed";
    console.error(`[SMS] Log ${log.id} provider processing error:`, error.message);
  }

  const refunded = await refundFailedLog({
    logId: log.id,
    userId,
    costPerRecipient,
    reason: lastError,
  });

  return {
    logId: log.id.toString(),
    recipient: log.recipient,
    status: "failed",
    parts: log.parts,
    cost: toMoney(costPerRecipient),
    provider: null,
    refunded,
    failureReason: lastError,
    ...(refunded ? {} : { note: "Log was already handled; no duplicate refund issued" }),
  };
}

async function runIdempotent({ userId, idempotencyKey, operation }) {
  if (!idempotencyKey) {
    return operation();
  }

  const key = String(idempotencyKey).slice(0, 200);
  let request;

  try {
    request = await prisma.sms_requests.create({
      data: {
        user_id: BigInt(userId),
        idempotency_key: key,
        status: "processing",
      },
    });
  } catch (error) {
    if (error.code === "P2002") {
      const existing = await prisma.sms_requests.findUnique({
        where: {
          user_id_idempotency_key: {
            user_id: BigInt(userId),
            idempotency_key: key,
          },
        },
      });

      if (existing?.status === "completed" && existing.response) {
        return existing.response;
      }

      throw createHttpError(
        "A request with this Idempotency-Key is already being processed",
        409
      );
    }
    throw error;
  }

  try {
    const result = await operation();
    await prisma.sms_requests.update({
      where: { id: request.id },
      data: {
        status: "completed",
        response: result,
        total_reserved: result.totalReserved,
        total_refunded: result.totalRefunded,
        last_error: null,
        updated_at: new Date(),
      },
    });
    return result;
  } catch (error) {
    await prisma.sms_requests
      .update({
        where: { id: request.id },
        data: {
          status: "failed",
          last_error: error.message,
          updated_at: new Date(),
        },
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * Send SMS to one or more recipients with atomic credit reservation, priority
 * routing, failover, and exactly-once refunds for recipients that fail on every
 * eligible provider.
 */
export async function sendSms({ userId, to, message, options = {}, idempotencyKey }) {
  const payload = validateSendPayload(to, message);

  return runIdempotent({
    userId,
    idempotencyKey,
    operation: async () => {
      const logs = await reserveCreditsAndCreateLogs({
        userId,
        recipients: payload.normalizedRecipients,
        message,
        sms: payload.sms,
        costPerRecipient: payload.costPerRecipient,
        totalCostString: payload.totalCostString,
      });

      const results = [];
      let totalRefunded = 0;

      for (const log of logs) {
        const result = await processOneLog({
          log,
          userId,
          costPerRecipient: payload.costPerRecipient,
          options,
        });
        if (result.refunded) {
          totalRefunded = Number(
            (totalRefunded + payload.costPerRecipient).toFixed(2)
          );
        }
        results.push(result);
      }

      const sent = results.filter((item) => item.status === "sent").length;
      const failed = results.filter((item) => item.status === "failed").length;

      return {
        encoding: payload.sms.encoding,
        partsPerMessage: payload.sms.parts,
        characters: payload.sms.characters,
        units: payload.sms.units,
        costPerPart: toMoney(payload.creditCostPerPart),
        costPerRecipient: toMoney(payload.costPerRecipient),
        totalReserved: toMoney(payload.totalCost),
        totalRefunded: toMoney(totalRefunded),
        totalCharged: toMoney(payload.totalCost - totalRefunded),
        sent,
        failed,
        results,
      };
    },
  });
}

function parseFilterDate(value, { endOfDay = false } = {}) {
  const isDateOnly =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

  if (isDateOnly) {
    const [year, month, day] = value.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      throw createHttpError("Invalid calendar date", 400);
    }
  }

  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(
      "Invalid date format. Use ISO 8601 or YYYY-MM-DD",
      400
    );
  }
  if (isDateOnly && endOfDay) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
}

/**
 * Fetch paginated SMS logs for a user with optional filters.
 */
export async function getSmsLogs({
  userId,
  page = 1,
  limit = 10,
  status,
  recipient,
  startDate,
  endDate,
}) {
  const pageNum = Number(page);
  const limitNum = Number(limit);

  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw createHttpError("Page must be a positive integer", 400);
  }

  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
    throw createHttpError("Limit must be an integer between 1 and 100", 400);
  }

  const where = {
    user_id: BigInt(userId),
  };

  if (status) {
    const validStatuses = ["pending", "sent", "failed"];
    if (!validStatuses.includes(status)) {
      throw createHttpError(
        `Invalid status '${status}'. Must be one of: ${validStatuses.join(", ")}`,
        400
      );
    }
    where.status = status;
  }

  if (recipient && typeof recipient === "string" && recipient.trim()) {
    const trimmed = recipient.trim();
    try {
      where.recipient = normalizeNepaliPhone(trimmed);
    } catch {
      where.recipient = { contains: trimmed };
    }
  }

  const range = {};
  if (startDate) {
    range.gte = parseFilterDate(startDate);
  }
  if (endDate) {
    range.lte = parseFilterDate(endDate, { endOfDay: true });
  }
  if (range.gte && range.lte && range.gte > range.lte) {
    throw createHttpError("startDate must be before or equal to endDate", 400);
  }
  if (Object.keys(range).length > 0) {
    where.created_at = range;
  }

  const skip = (pageNum - 1) * limitNum;
  const includeDelivery = await tableExists("sms_delivery_reports");

  const [totalCount, logs] = await Promise.all([
    prisma.sms_logs.count({ where }),
    prisma.sms_logs.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      include: {
        sms_providers: {
          select: { id: true, name: true, priority: true },
        },
        sms_provider_attempts: {
          orderBy: { attempted_at: "asc" },
          include: {
            sms_providers: { select: { id: true, name: true } },
          },
        },
        ...(includeDelivery ? { sms_delivery_reports: true } : {}),
      },
    }),
  ]);

  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limitNum);

  const formattedLogs = logs.map((log) => {
    const delivery = includeDelivery ? log.sms_delivery_reports : null;
    return {
      id: log.id.toString(),
      recipient: log.recipient,
      message: log.message,
      parts: log.parts,
      cost: Number(log.cost).toFixed(2),
      status: log.status,
      failureReason: log.failure_reason,
      provider: log.sms_providers
        ? {
            id: log.sms_providers.id.toString(),
            name: log.sms_providers.name,
            priority: log.sms_providers.priority,
          }
        : null,
      deliveryStatus: delivery?.status ?? null,
      delivery: delivery
        ? {
            status: delivery.status,
            providerMessageId: delivery.provider_message_id,
            errorMessage: delivery.error_message,
            receivedAt: delivery.received_at.toISOString(),
          }
        : null,
      createdAt: log.created_at.toISOString(),
      updatedAt: log.updated_at.toISOString(),
      attempts: log.sms_provider_attempts.map((attempt) => ({
        id: attempt.id.toString(),
        providerId: attempt.provider_id.toString(),
        providerName: attempt.sms_providers?.name || null,
        status: attempt.status,
        errorMessage: attempt.error_message,
        attemptedAt: attempt.attempted_at.toISOString(),
      })),
    };
  });

  return {
    logs: formattedLogs,
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalCount,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1 && totalCount > 0,
    },
  };
}
