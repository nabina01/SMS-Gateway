import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import app from "../src/server.js";
import prisma from "../src/config/prisma.js";
import { sendSms } from "../src/services/sms.service.js";
import { createTestProvider, createTestUser } from "./helpers.js";
import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from "../src/services/webhook.service.js";

const WEBHOOK_SECRET = "test-webhook-secret-not-for-production";

describe("Delivery-report webhook", () => {
  let server;
  let baseUrl;
  let user;
  let provider;
  let secondProvider;
  let sentLogId;

  before(async () => {
    process.env.SMS_WEBHOOK_SECRET = WEBHOOK_SECRET;
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    const createdUser = await createTestUser({ balance: "5.00" });
    user = createdUser;
    provider = await createTestProvider({
      namePrefix: "WebhookRoute",
      priority: 960,
      balance: "50.00",
      failureRate: "0.00",
    });
    secondProvider = await createTestProvider({
      namePrefix: "OtherRoute",
      priority: 961,
      balance: "50.00",
      failureRate: "0.00",
    });

    const result = await sendSms({
      userId: user.user.id,
      to: ["9841234567"],
      message: "Webhook delivery test",
    });
    sentLogId = result.results[0].logId;
  });

  after(async () => {
    await user.cleanup();
    await provider.cleanup();
    await secondProvider.cleanup();
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  async function postWebhook(payload, { signature, timestamp } = {}) {
    const rawBody = JSON.stringify(payload);
    const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
    const sig =
      signature ??
      `sha256=${computeWebhookSignature({
        timestamp: ts,
        rawBody,
        secret: WEBHOOK_SECRET,
      })}`;

    const res = await fetch(`${baseUrl}/webhooks/sms/delivery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sms-timestamp": ts,
        "x-sms-signature": sig,
      },
      body: rawBody,
    });
    return { res, body: await res.json() };
  }

  it("rejects an invalid signature with 401", async () => {
    const { res, body } = await postWebhook(
      {
        messageId: sentLogId,
        provider: provider.provider.name,
        status: "delivered",
      },
      { signature: "sha256=deadbeef" }
    );
    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.match(body.message, /Invalid webhook signature/);
  });

  it("rejects an unknown message with 404", async () => {
    const { res } = await postWebhook({
      messageId: "999999999",
      provider: provider.provider.name,
      status: "delivered",
    });
    assert.equal(res.status, 404);
  });

  it("rejects an unknown provider with 401", async () => {
    const { res } = await postWebhook({
      messageId: sentLogId,
      provider: "DOES_NOT_EXIST",
      status: "delivered",
    });
    assert.equal(res.status, 401);
  });

  it("processes a valid delivery report and is idempotent", async () => {
    const payload = {
      messageId: sentLogId,
      provider: provider.provider.name,
      providerMessageId: "mock-provider-123",
      status: "delivered",
    };

    const first = await postWebhook(payload);
    assert.equal(first.res.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.data.duplicate, false);
    assert.equal(first.body.data.deliveryStatus, "delivered");

    const duplicate = await postWebhook(payload);
    assert.equal(duplicate.res.status, 200);
    assert.equal(duplicate.body.data.duplicate, true);

    const reportCount = await prisma.sms_delivery_reports.count({
      where: { sms_log_id: BigInt(sentLogId) },
    });
    assert.equal(reportCount, 1);
  });

  it("rejects a conflicting final delivery state with 409", async () => {
    const { res } = await postWebhook({
      messageId: sentLogId,
      provider: provider.provider.name,
      status: "failed",
      error: "late failure",
    });
    assert.equal(res.status, 409);
  });

  it("rejects a provider that did not route the message", async () => {
    const result = await sendSms({
      userId: user.user.id,
      to: ["9841234568"],
      message: "Second webhook delivery test",
    });
    const logId = result.results[0].logId;

    const { res } = await postWebhook({
      messageId: logId,
      provider: secondProvider.provider.name,
      status: "delivered",
    });
    assert.equal(res.status, 401);
  });

  it("rejects delivery reports for logs that are not sent", async () => {
    const pending = await prisma.sms_logs.create({
      data: {
        user_id: user.user.id,
        recipient: "9841234569",
        message: "Pending log",
        parts: 1,
        cost: "1.00",
        status: "pending",
      },
    });

    const { res } = await postWebhook({
      messageId: pending.id.toString(),
      provider: provider.provider.name,
      status: "delivered",
    });
    assert.equal(res.status, 409);
  });

  it("requires a configured webhook secret", () => {
    assert.throws(
      () =>
        verifyWebhookSignature({
          headers: { "x-sms-timestamp": "1", "x-sms-signature": "x" },
          rawBody: "{}",
          secret: "",
        }),
      /disabled/
    );
  });
});
