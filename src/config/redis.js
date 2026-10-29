import IORedis from "ioredis";

export function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL);
}

export function redisConnectionOptions(overrides = {}) {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }
  return {
    url: process.env.REDIS_URL,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...overrides,
  };
}

export function createRedisClient(options = {}) {
  const client = new IORedis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1000)),
    ...options,
  });
  client.on("error", (error) => {
    if (process.env.NODE_ENV !== "test") {
      console.error(`[Redis ${options.connectionName || "client"}]`, error.message);
    }
  });
  client.on("connect", () => {
    client.stream?.unref?.();
  });
  return client;
}
