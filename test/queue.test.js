import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import prisma from "../src/config/prisma.js";
import { bullmqConnection, getQueueConfig } from "../src/config/queue.js";
import {
  closeSmsQueue,
  enqueueSms,
  getSmsJobForUser,
  getSmsQueue,
  processSmsJob,
} from "../src/services/queue.service.js";
import { createTestProvider, createTestUser } from "./helpers.js";

const redisUrl = process.env.TEST_REDIS_URL || process.env.REDIS_URL || "";
let redisAvailable = false;

if (redisUrl) {
  const probe = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  } finally {
    await probe.quit().catch(() => {});
  }
}

if (redisAvailable) {
  process.env.REDIS_URL = redisUrl;
  process.env.SMS_QUEUE_ENABLED = "true";
  process.env.SMS_QUEUE_NAME = `sms-send-test-${process.pid}`;
}

describe(
  "BullMQ queued SMS processing",
  { skip: redisAvailable ? false : "Redis is not reachable; queue tests skipped" },
  () => {
    let worker;
    const cleanups = [];

    before(async () => {
      worker = new Worker(getQueueConfig().name, processSmsJob, {
        connection: bullmqConnection(),
        concurrency: 2,
      });
      worker.on("error", () => {});
      await worker.waitUntilReady();
    });

    after(async () => {
      await worker.close();
      await closeSmsQueue();
      for (const cleanup of cleanups.reverse()) {
        await cleanup().catch(() => {});
      }
      await prisma.$disconnect();
    });

    async function waitForJob(jobId, userId, expectedStates, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const job = await getSmsJobForUser({ jobId, userId });
        if (expectedStates.includes(job.state)) return job;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for job ${jobId}`);
    }

    it("processes a queued send exactly once and deduplicates the same job id", async () => {
      const provider = await createTestProvider({
        namePrefix: "QueueProvider",
        priority: 970,
        balance: "50.00",
        failureRate: "0.00",
      });
      const user = await createTestUser({ balance: "5.00" });
      cleanups.push(async () => {
        await user.cleanup();
        await provider.cleanup();
      });

      const key = `queue-idem-${Date.now()}`;
      const first = await enqueueSms({
        userId: user.user.id,
        to: ["9841234567"],
        message: "Queued message",
        idempotencyKey: key,
      });

      const completed = await waitForJob(first.jobId, user.user.id, [
        "completed",
        "failed",
      ]);
      assert.equal(completed.state, "completed");
      assert.equal(completed.result.sent, 1);

      const duplicate = await enqueueSms({
        userId: user.user.id,
        to: ["9841234567"],
        message: "Queued message",
        idempotencyKey: key,
      });
      assert.equal(duplicate.jobId, first.jobId);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.user.id },
      });
      assert.equal(Number(wallet.balance), 4);
      assert.equal(
        await prisma.sms_logs.count({ where: { user_id: user.user.id } }),
        1
      );
    });

    it("marks an unrecoverable business failure as failed without charging", async () => {
      const user = await createTestUser({ balance: "0.00" });
      cleanups.push(user.cleanup);

      const queued = await enqueueSms({
        userId: user.user.id,
        to: ["9841234567"],
        message: "No credits in queue",
        idempotencyKey: `queue-fail-${Date.now()}`,
      });

      const failed = await waitForJob(queued.jobId, user.user.id, [
        "failed",
        "completed",
      ]);
      assert.equal(failed.state, "failed");
      assert.match(failed.failedReason, /Insufficient credits/);

      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.user.id },
      });
      assert.equal(Number(wallet.balance), 0);
      assert.equal(
        await prisma.sms_logs.count({ where: { user_id: user.user.id } }),
        0
      );
    });

    it("rejects queue use when the feature is disabled", async () => {
      const previous = process.env.SMS_QUEUE_ENABLED;
      process.env.SMS_QUEUE_ENABLED = "false";
      try {
        assert.throws(() => getSmsQueue(), /Queue mode is disabled/);
      } finally {
        process.env.SMS_QUEUE_ENABLED = previous;
      }
    });
  }
);
