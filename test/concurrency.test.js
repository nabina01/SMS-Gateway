import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/config/prisma.js";
import { sendSms } from "../src/services/sms.service.js";
import { createTestUser, createTestProvider } from "./helpers.js";

describe("Critical Concurrency Safety", () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it("handles 20 parallel requests with a 10-credit wallet: exactly 10 succeed, balance never negative", async () => {
    // 1. Create a reliable provider with ample balance
    const provider = await createTestProvider({
      priority: 999,
      balance: "500.00",
      failureRate: "0.00",
    });

    // 2. Create an isolated user with exactly 10.00 credits
    const { user, cleanup: cleanupUser } = await createTestUser({
      name: "Concurrency Tester",
      balance: "10.00",
    });

    try {
      // 3. Fire 20 parallel requests simultaneously
      const parallelRequests = Array.from({ length: 20 }, (_, index) => {
        const recipient = `984100${String(index).padStart(4, "0")}`;
        return sendSms({
          userId: user.id,
          to: [recipient],
          message: `Concurrent ping #${index}`,
        })
          .then((res) => ({ status: "fulfilled", res }))
          .catch((err) => ({ status: "rejected", err }));
      });

      const outcomes = await Promise.all(parallelRequests);

      const succeeded = outcomes.filter(
        (o) => o.status === "fulfilled" && o.res.sent === 1
      );
      const rejectedForCredits = outcomes.filter(
        (o) => o.status === "rejected" && o.err?.statusCode === 402
      );

      // 4. Assertions: exactly 10 succeed, exactly 10 rejected with 402 Insufficient credits
      assert.equal(
        succeeded.length,
        10,
        `Expected exactly 10 successful requests, but got ${succeeded.length}`
      );
      assert.equal(
        rejectedForCredits.length,
        10,
        `Expected exactly 10 rejected requests (402), but got ${rejectedForCredits.length}`
      );

      // 5. Final wallet balance check: must be exactly 0.00 and NEVER negative
      const finalWallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });

      const finalBalance = Number(finalWallet.balance);
      assert.equal(
        finalBalance,
        0,
        `Wallet balance must be exactly 0.00, but got ${finalBalance}`
      );
      assert.ok(
        finalBalance >= 0,
        "Wallet balance must never be negative under concurrency"
      );

      // 6. Verify exactly 10 SMS logs were persisted in database
      const totalLogsCreated = await prisma.sms_logs.count({
        where: { user_id: user.id },
      });
      assert.equal(totalLogsCreated, 10);
    } finally {
      await cleanupUser();
      await provider.cleanup();
    }
  });
});
