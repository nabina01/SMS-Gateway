import { Worker } from "bullmq";
import prisma from "../config/prisma.js";
import { bullmqConnection, getQueueConfig } from "../config/queue.js";
import { closeSmsQueue, processSmsJob } from "../services/queue.service.js";

export function createSmsWorker({
  connection = bullmqConnection(),
  concurrency = getQueueConfig().concurrency,
} = {}) {
  const config = getQueueConfig();
  const worker = new Worker(config.name, processSmsJob, {
    connection,
    concurrency,
  });

  worker.on("completed", (job) => {
    console.log(`[Queue] Job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Queue] Job ${job?.id} failed:`, error.message);
  });

  worker.on("error", (error) => {
    console.error("[Queue] Worker error:", error.message);
  });

  return worker;
}

async function main() {
  const config = getQueueConfig();
  if (!config.enabled) {
    console.error(
      "SMS_QUEUE_ENABLED is not true. Set SMS_QUEUE_ENABLED=true and REDIS_URL to run the worker."
    );
    process.exitCode = 1;
    return;
  }

  const worker = createSmsWorker();
  console.log(
    `SMS queue worker started (queue=${config.name}, concurrency=${config.concurrency})`
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Queue] ${signal} received, finishing active jobs...`);
    try {
      await worker.close();
      await closeSmsQueue();
    } finally {
      await prisma.$disconnect();
    }
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (error) => {
  console.error("Queue worker failed to start:", error.message);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
