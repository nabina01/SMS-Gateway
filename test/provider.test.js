import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/config/prisma.js";
import { getBalance, getProvidersHealth } from "../src/services/provider.service.js";
import { createTestProvider, createTestUser } from "./helpers.js";

describe("Provider Service & Health Calculations", () => {
  const cleanups = [];
  const providerIds = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function provider(options) {
    const created = await createTestProvider(options);
    cleanups.push(created.cleanup);
    providerIds.push(created.provider.id);
    return created.provider;
  }

  async function userForLogs() {
    const created = await createTestUser({ balance: "1.00" });
    cleanups.push(created.cleanup);
    return created.user;
  }

  async function logFor(user, recipient = "9841000000") {
    return prisma.sms_logs.create({
      data: {
        user_id: user.id,
        recipient,
        message: "Health test message",
        parts: 1,
        cost: "1.00",
        status: "sent",
      },
    });
  }

  it("retrieves provider balance through getBalance()", async () => {
    const p = await provider({
      namePrefix: "BalanceProvider",
      priority: 950,
      balance: "750.50",
      failureRate: "0.05",
    });

    const balanceInfo = await getBalance(p.id);
    assert.equal(balanceInfo.id, p.id.toString());
    assert.equal(balanceInfo.name, p.name);
    assert.equal(balanceInfo.balance, "750.50");
    assert.equal(balanceInfo.isActive, true);
  });

  it("throws 404 when getBalance() is called with a nonexistent provider id", async () => {
    await assert.rejects(
      async () => getBalance(99999999n),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.match(error.message, /not found/);
        return true;
      }
    );
  });

  it("does not claim health from zero attempts and distinguishes availability/balance", async () => {
    const pUnrated = await provider({
      namePrefix: "Unrated",
      priority: 951,
      balance: "100.00",
      failureRate: "0.00",
    });
    const pInactive = await provider({
      namePrefix: "Inactive",
      priority: 952,
      balance: "100.00",
      isActive: false,
    });
    const pNoBalance = await provider({
      namePrefix: "NoBalance",
      priority: 953,
      balance: "0.00",
    });

    const health = await getProvidersHealth();
    const unrated = health.find((p) => p.id === pUnrated.id.toString());
    const inactive = health.find((p) => p.id === pInactive.id.toString());
    const noBalance = health.find((p) => p.id === pNoBalance.id.toString());

    assert.ok(unrated);
    assert.equal(unrated.totalAttempts24h, 0);
    assert.equal(unrated.successRate, null);
    assert.equal(unrated.healthPercentage, null);
    assert.equal(unrated.healthStatus, "unrated");
    assert.equal(unrated.availability, "available");

    assert.ok(inactive);
    assert.equal(inactive.healthPercentage, null);
    assert.equal(inactive.healthStatus, "inactive");
    assert.equal(inactive.availability, "inactive");

    assert.ok(noBalance);
    assert.equal(noBalance.healthPercentage, null);
    assert.equal(noBalance.healthStatus, "no_balance");
    assert.equal(noBalance.availability, "no_balance");
    assert.equal(noBalance.balanceState, "exhausted");
  });

  it("calculates mixed, all-success, and all-failure success rates", async () => {
    const user = await userForLogs();
    const log = await logFor(user);

    const pMixed = await provider({ namePrefix: "Mixed", priority: 954 });
    const pAllSuccess = await provider({ namePrefix: "AllSuccess", priority: 955 });
    const pAllFail = await provider({ namePrefix: "AllFail", priority: 956 });

    await prisma.sms_provider_attempts.createMany({
      data: [
        { sms_log_id: log.id, provider_id: pMixed.id, status: "sent" },
        { sms_log_id: log.id, provider_id: pMixed.id, status: "sent" },
        { sms_log_id: log.id, provider_id: pMixed.id, status: "sent" },
        {
          sms_log_id: log.id,
          provider_id: pMixed.id,
          status: "failed",
          error_message: "Test failure",
        },
        { sms_log_id: log.id, provider_id: pAllSuccess.id, status: "sent" },
        { sms_log_id: log.id, provider_id: pAllSuccess.id, status: "sent" },
        { sms_log_id: log.id, provider_id: pAllFail.id, status: "failed" },
        { sms_log_id: log.id, provider_id: pAllFail.id, status: "failed" },
      ],
    });

    const health = await getProvidersHealth();

    const mixed = health.find((p) => p.id === pMixed.id.toString());
    assert.equal(mixed.totalAttempts24h, 4);
    assert.equal(mixed.successfulAttempts24h, 3);
    assert.equal(mixed.failedAttempts24h, 1);
    assert.equal(mixed.successRate, 0.75);
    assert.equal(mixed.healthPercentage, 75);
    assert.equal(mixed.healthStatus, "degraded");

    const allSuccess = health.find((p) => p.id === pAllSuccess.id.toString());
    assert.equal(allSuccess.successRate, 1);
    assert.equal(allSuccess.healthPercentage, 100);
    assert.equal(allSuccess.healthStatus, "healthy");

    const allFail = health.find((p) => p.id === pAllFail.id.toString());
    assert.equal(allFail.successRate, 0);
    assert.equal(allFail.healthPercentage, 0);
    assert.equal(allFail.healthStatus, "unhealthy");
  });
});
