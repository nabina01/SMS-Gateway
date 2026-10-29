import { createHash, randomUUID } from "node:crypto";
import { Queue, UnrecoverableError } from "bullmq";
import { bullmqConnection, getQueueConfig } from "../config/queue.js";
import { createHttpError } from "../utils/errors.js";
import { sendSms } from "./sms.service.js";

let queue;

export function isQueueEnabled() {
  return getQueueConfig().enabled;
}

export function getSmsQueue() {
  const config = getQueueConfig();
  if (!config.enabled) {
    throw createHttpError("Queue mode is disabled (SMS_QUEUE_ENABLED=false)", 503);
  }
  if (!queue) {
    queue = new Queue(config.name, { connection: bullmqConnection() });
  }
  return queue;
}

function stableJobId(userId, idempotencyKey) {
  const digest = createHash("sha256")
    .update(`${userId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `sms_${digest}`;
}

export async function enqueueSms({
  userId,
  to,
  message,
  idempotencyKey = randomUUID(),
}) {
  const config = getQueueConfig();
  const queueClient = getSmsQueue();
  const jobId = stableJobId(userId, idempotencyKey);

  const job = await queueClient.add(
    "send",
    {
      userId: String(userId),
      to,
      message,
      idempotencyKey,
    },
    {
      jobId,
      attempts: config.attempts,
      backoff: { type: "exponential", delay: config.backoffMs },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
    }
  );

  return {
    jobId: job.id,
    idempotencyKey,
    state: await job.getState(),
  };
}

export async function getSmsJobForUser({ jobId, userId }) {
  const queueClient = getSmsQueue();
  const job = await queueClient.getJob(jobId);

  if (!job || String(job.data?.userId) !== String(userId)) {
    throw createHttpError("Queued SMS job not found", 404);
  }

  const state = await job.getState();
  return {
    jobId: job.id,
    state,
    status:
      state === "completed"
        ? "completed"
        : state === "failed"
          ? "failed"
          : "pending",
    attemptsMade: job.attemptsMade,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason || null,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

export async function processSmsJob(job) {
  const { userId, to, message, idempotencyKey } = job.data || {};

  try {
    return await sendSms({
      userId,
      to,
      message,
      idempotencyKey: idempotencyKey || `job:${job.id}`,
    });
  } catch (error) {
    if (Number.isInteger(error.statusCode) && error.statusCode < 500) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}

export async function closeSmsQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
