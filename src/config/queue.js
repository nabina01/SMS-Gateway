export function getQueueConfig() {
  const attempts = Number(process.env.QUEUE_ATTEMPTS || 3);
  const backoffMs = Number(process.env.QUEUE_BACKOFF_MS || 5000);
  const concurrency = Number(process.env.QUEUE_CONCURRENCY || 5);

  return {
    enabled: process.env.SMS_QUEUE_ENABLED === "true",
    name: process.env.SMS_QUEUE_NAME || "sms-send",
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 3,
    backoffMs: Number.isInteger(backoffMs) && backoffMs > 0 ? backoffMs : 5000,
    concurrency:
      Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 5,
  };
}

export function bullmqConnection() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required for BullMQ queue mode");
  }

  const url = new URL(process.env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
