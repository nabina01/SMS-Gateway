import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/config/prisma.js";
import { sendSms, getSmsLogs } from "../src/services/sms.service.js";
import { createTestUser, createTestProvider } from "./helpers.js";

describe("SMS Service & Routing", () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it("rejects request with 402 when wallet has insufficient credits", async () => {
    const { user, cleanup } = await createTestUser({ balance: "0.00" });
    try {
      await assert.rejects(
        async () => {
          await sendSms({
            userId: user.id,
            to: ["9841234567"],
            message: "Test insufficient credit",
          });
        },
        (err) => {
          assert.equal(err.statusCode, 402);
          assert.match(err.message, /Insufficient credits/);
          return true;
        }
      );

      const logCount = await prisma.sms_logs.count({
        where: { user_id: user.id },
      });
      assert.equal(logCount, 0);
    } finally {
      await cleanup();
    }
  });

  it("routes through priority order, fails over on failure, and debits winning provider", async () => {
    // Provider 1: high priority (901), 100% failure rate
    const p1 = await createTestProvider({
      priority: 901,
      balance: "50.00",
      failureRate: "1.00",
    });
    // Provider 2: lower priority (902), 0% failure rate (reliable)
    const p2 = await createTestProvider({
      priority: 902,
      balance: "50.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "10.00" });

    try {
      const sendResult = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "Priority failover test",
      });

      assert.equal(sendResult.sent, 1);
      assert.equal(sendResult.failed, 0);
      assert.equal(sendResult.results[0].status, "sent");
      assert.equal(sendResult.results[0].provider.id, p2.provider.id.toString());

      // Verify Provider 1 was attempted and failed
      const p1Attempts = await prisma.sms_provider_attempts.findMany({
        where: { provider_id: p1.provider.id },
      });
      assert.equal(p1Attempts.length, 1);
      assert.equal(p1Attempts[0].status, "failed");

      // Verify Provider 1 balance was NOT deducted
      const p1Fresh = await prisma.sms_providers.findUnique({
        where: { id: p1.provider.id },
      });
      assert.equal(Number(p1Fresh.balance), 50.0);

      // Verify Provider 2 was attempted and sent
      const p2Attempts = await prisma.sms_provider_attempts.findMany({
        where: { provider_id: p2.provider.id },
      });
      assert.equal(p2Attempts.length, 1);
      assert.equal(p2Attempts[0].status, "sent");

      // Verify Provider 2 balance WAS deducted by 1.00 credit
      const p2Fresh = await prisma.sms_providers.findUnique({
        where: { id: p2.provider.id },
      });
      assert.equal(Number(p2Fresh.balance), 49.0);

      // Verify user wallet balance was deducted (10.00 - 1.00 = 9.00)
      const freshWallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(freshWallet.balance), 9.0);
    } finally {
      await cleanupUser();
      await p1.cleanup();
      await p2.cleanup();
    }
  });

  it("refunds credits when all available providers fail", async () => {
    // Only Provider: 100% failure rate
    const pFail = await createTestProvider({
      priority: 910,
      balance: "50.00",
      failureRate: "1.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "5.00" });

    try {
      // Pass options.simulatedFailure = true to ensure deterministic failure across all providers
      const sendResult = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "All providers fail refund test",
        options: { simulatedFailure: true },
      });

      assert.equal(sendResult.sent, 0);
      assert.equal(sendResult.failed, 1);
      assert.equal(sendResult.totalRefunded, "1.00");
      assert.equal(sendResult.results[0].status, "failed");

      // Verify user wallet was fully refunded back to 5.00
      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(wallet.balance), 5.0);

      // Verify SMS log is marked as failed
      const log = await prisma.sms_logs.findFirst({
        where: { user_id: user.id },
      });
      assert.equal(log.status, "failed");
      assert.ok(log.failure_reason);
    } finally {
      await cleanupUser();
      await pFail.cleanup();
    }
  });

  it("refunds only failed recipients in multi-recipient request", async () => {
    // Provider has balance for exactly 1 SMS (1.00)
    const pLimited = await createTestProvider({
      priority: 915,
      balance: "1.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "5.00" });

    try {
      // Request with 2 recipients: recipient 1 will use the 1.00 balance,
      // recipient 2 will find no provider with sufficient balance and will be refunded
      const sendResult = await sendSms({
        userId: user.id,
        to: ["9841111111", "9842222222"],
        message: "Partial refund test",
      });

      assert.equal(sendResult.sent, 1);
      assert.equal(sendResult.failed, 1);
      assert.equal(sendResult.totalReserved, "2.00");
      assert.equal(sendResult.totalRefunded, "1.00");

      // Wallet originally had 5.00, reserved 2.00 (balance 3.00), refunded 1.00 -> final 4.00
      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(wallet.balance), 4.0);
    } finally {
      await cleanupUser();
      await pLimited.cleanup();
    }
  });

  it("fails over when a provider raises an unexpected transport error", async () => {
    const pThrow = await createTestProvider({
      priority: 905,
      balance: "50.00",
      failureRate: "0.00",
    });
    const pOk = await createTestProvider({
      priority: 906,
      balance: "50.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "5.00" });

    try {
      const result = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "Unexpected provider error failover",
        options: {
          providerOutcomes: { [pThrow.provider.name]: "throw" },
        },
      });

      assert.equal(result.sent, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.results[0].provider.id, pOk.provider.id.toString());

      const failedAttempt = await prisma.sms_provider_attempts.findFirst({
        where: { provider_id: pThrow.provider.id, status: "failed" },
      });
      assert.ok(failedAttempt);
      assert.match(failedAttempt.error_message, /unexpected transport error/);
    } finally {
      await cleanupUser();
      await pThrow.cleanup();
      await pOk.cleanup();
    }
  });

  it("skips inactive and exhausted providers, then refunds exactly once", async () => {
    const pInactive = await createTestProvider({
      priority: 907,
      balance: "50.00",
      failureRate: "0.00",
      isActive: false,
    });
    const pExhausted = await createTestProvider({
      priority: 908,
      balance: "0.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "3.00" });

    try {
      const result = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "No eligible provider",
      });

      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.totalRefunded, "1.00");
      assert.equal(result.totalCharged, "0.00");
      assert.match(result.results[0].failureReason, /No active SMS provider/);

      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(wallet.balance), 3);

      const attempts = await prisma.sms_provider_attempts.count({
        where: {
          provider_id: { in: [pInactive.provider.id, pExhausted.provider.id] },
        },
      });
      assert.equal(attempts, 0);
    } finally {
      await cleanupUser();
      await pInactive.cleanup();
      await pExhausted.cleanup();
    }
  });

  it("charges once and returns the stored response for a repeated Idempotency-Key", async () => {
    const p = await createTestProvider({
      priority: 909,
      balance: "50.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "5.00" });
    const idempotencyKey = `idem_${Date.now()}`;

    try {
      const first = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "Idempotent send",
        idempotencyKey,
      });
      const second = await sendSms({
        userId: user.id,
        to: ["9841234567"],
        message: "Idempotent send",
        idempotencyKey,
      });

      assert.equal(first.results[0].logId, second.results[0].logId);
      assert.equal(second.sent, 1);

      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(wallet.balance), 4);

      const logCount = await prisma.sms_logs.count({ where: { user_id: user.id } });
      assert.equal(logCount, 1);

      const provider = await prisma.sms_providers.findUnique({
        where: { id: p.provider.id },
      });
      assert.equal(Number(provider.balance), 49);
    } finally {
      await cleanupUser();
      await p.cleanup();
    }
  });

  it("paginates and filters SMS logs correctly", async () => {
    const p = await createTestProvider({
      priority: 920,
      balance: "100.00",
      failureRate: "0.00",
    });
    const { user, cleanup: cleanupUser } = await createTestUser({ balance: "10.00" });

    try {
      // Send 3 SMS messages
      await sendSms({ userId: user.id, to: ["9841000001"], message: "Msg 1" });
      await sendSms({ userId: user.id, to: ["9841000002"], message: "Msg 2" });
      await sendSms({ userId: user.id, to: ["9841000003"], message: "Msg 3" });

      // Test pagination: page 1 with limit 2
      const page1 = await getSmsLogs({ userId: user.id, page: 1, limit: 2 });
      assert.equal(page1.logs.length, 2);
      assert.equal(page1.pagination.totalCount, 3);
      assert.equal(page1.pagination.totalPages, 2);
      assert.equal(page1.pagination.hasNextPage, true);
      assert.equal(page1.pagination.hasPrevPage, false);

      // Page 2 with limit 2
      const page2 = await getSmsLogs({ userId: user.id, page: 2, limit: 2 });
      assert.equal(page2.logs.length, 1);
      assert.equal(page2.pagination.hasNextPage, false);
      assert.equal(page2.pagination.hasPrevPage, true);

      // Filter by recipient
      const recipientFiltered = await getSmsLogs({
        userId: user.id,
        recipient: "9841000002",
      });
      assert.equal(recipientFiltered.logs.length, 1);
      assert.equal(recipientFiltered.logs[0].recipient, "9841000002");

      // Filter by status 'sent'
      const statusFiltered = await getSmsLogs({
        userId: user.id,
        status: "sent",
      });
      assert.equal(statusFiltered.logs.length, 3);

      // Inclusive same-day range + normalized recipient filter
      const today = new Date().toISOString().slice(0, 10);
      const dateFiltered = await getSmsLogs({
        userId: user.id,
        startDate: today,
        endDate: today,
      });
      assert.equal(dateFiltered.logs.length, 3);

      const normalizedRecipient = await getSmsLogs({
        userId: user.id,
        recipient: "+9779841000002",
      });
      assert.equal(normalizedRecipient.logs.length, 1);

      const empty = await getSmsLogs({
        userId: user.id,
        recipient: "9809999999",
      });
      assert.equal(empty.logs.length, 0);
      assert.equal(empty.pagination.totalCount, 0);
      assert.equal(empty.pagination.totalPages, 0);
      assert.equal(empty.pagination.hasNextPage, false);

      await assert.rejects(
        () => getSmsLogs({ userId: user.id, page: 0 }),
        /Page must be a positive integer/
      );
      await assert.rejects(
        () => getSmsLogs({ userId: user.id, limit: 101 }),
        /Limit must be an integer/
      );
      await assert.rejects(
        () => getSmsLogs({ userId: user.id, status: "retrying" }),
        /Invalid status/
      );
      await assert.rejects(
        () => getSmsLogs({ userId: user.id, startDate: "2026-02-31" }),
        /Invalid calendar date/
      );
      await assert.rejects(
        () =>
          getSmsLogs({
            userId: user.id,
            startDate: "2026-10-30",
            endDate: "2026-10-01",
          }),
        /startDate must be before/
      );
    } finally {
      await cleanupUser();
      await p.cleanup();
    }
  });

  it("strictly isolates user logs preventing cross-user access", async () => {
    const p = await createTestProvider({
      priority: 930,
      balance: "100.00",
      failureRate: "0.00",
    });
    const userA = await createTestUser({ name: "User A", balance: "5.00" });
    const userB = await createTestUser({ name: "User B", balance: "5.00" });

    try {
      // User A sends 1 SMS
      await sendSms({ userId: userA.user.id, to: ["9841111111"], message: "From User A" });

      // User B sends 1 SMS
      await sendSms({ userId: userB.user.id, to: ["9842222222"], message: "From User B" });

      // User A queries logs
      const logsA = await getSmsLogs({ userId: userA.user.id });
      assert.equal(logsA.logs.length, 1);
      assert.equal(logsA.logs[0].recipient, "9841111111");

      // User B queries logs
      const logsB = await getSmsLogs({ userId: userB.user.id });
      assert.equal(logsB.logs.length, 1);
      assert.equal(logsB.logs[0].recipient, "9842222222");

      // Neither user sees the other user's log
      const userAHasB = logsA.logs.some((l) => l.recipient === "9842222222");
      assert.equal(userAHasB, false);

      const userBHasA = logsB.logs.some((l) => l.recipient === "9841111111");
      assert.equal(userBHasA, false);
    } finally {
      await userA.cleanup();
      await userB.cleanup();
      await p.cleanup();
    }
  });
});
