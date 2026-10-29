import { createRedisClient, isRedisConfigured } from "../config/redis.js";

export class MemoryRateLimitStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buckets = new Map();
  }

  async increment(key, windowSeconds) {
    const now = this.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.expiresAt <= now) {
      const expiresAt = now + windowSeconds * 1000;
      this.buckets.set(key, { count: 1, expiresAt });
      return { count: 1, ttlSeconds: windowSeconds };
    }

    existing.count += 1;
    return {
      count: existing.count,
      ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    };
  }

  async reset(key) {
    this.buckets.delete(key);
  }

  async clear() {
    this.buckets.clear();
  }
}

const REDIS_INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export class RedisRateLimitStore {
  constructor({ client } = {}) {
    this.client = client || createRedisClient({ connectionName: "rate-limit" });
    this.connected = false;
  }

  async ensureConnected() {
    if (!this.connected) {
      if (this.client.status === "wait") {
        await this.client.connect();
      }
      this.connected = true;
    }
  }

  async increment(key, windowSeconds) {
    await this.ensureConnected();
    const [count, ttlMs] = await this.client.eval(
      REDIS_INCREMENT_SCRIPT,
      1,
      key,
      windowSeconds * 1000
    );
    return {
      count: Number(count),
      ttlSeconds: Math.max(1, Math.ceil(Number(ttlMs) / 1000)),
    };
  }

  async reset(key) {
    await this.ensureConnected();
    await this.client.del(key);
  }
}

export function getRateLimitConfig() {
  const enabled = process.env.RATE_LIMIT_ENABLED !== "false";
  const limit = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);
  const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);
  const prefix = process.env.RATE_LIMIT_REDIS_PREFIX || "sms:ratelimit";

  return {
    enabled,
    limit: Number.isInteger(limit) && limit > 0 ? limit : 60,
    windowSeconds:
      Number.isInteger(windowSeconds) && windowSeconds > 0
        ? windowSeconds
        : 60,
    prefix,
  };
}

export function createRateLimiter({
  limit,
  windowSeconds,
  prefix = "sms:ratelimit",
  store,
  redisStore,
  useRedis = isRedisConfigured(),
} = {}) {
  const config = getRateLimitConfig();
  const effectiveLimit = limit || config.limit;
  const effectiveWindow = windowSeconds || config.windowSeconds;
  const memoryStore = store || new MemoryRateLimitStore();
  const redis = redisStore || (useRedis ? new RedisRateLimitStore() : null);
  let redisAvailable = Boolean(redis);

  async function check(key) {
    const fullKey = `${prefix}:${key}`;
    let result;

    if (redisAvailable) {
      try {
        result = await redis.increment(fullKey, effectiveWindow);
      } catch (error) {
        redisAvailable = false;
        console.error(
          "[RateLimit] Redis unavailable, falling back to in-process limiter:",
          error.message
        );
      }
    }

    if (!result) {
      result = await memoryStore.increment(fullKey, effectiveWindow);
    }

    const remaining = Math.max(0, effectiveLimit - result.count);
    return {
      allowed: result.count <= effectiveLimit,
      limit: effectiveLimit,
      remaining,
      count: result.count,
      retryAfterSeconds: result.ttlSeconds,
      store: redisAvailable ? "redis" : "memory",
    };
  }

  return {
    check,
    limit: effectiveLimit,
    windowSeconds: effectiveWindow,
    reset: (key) => (redisAvailable ? redis.reset(`${prefix}:${key}`) : memoryStore.reset(`${prefix}:${key}`)),
  };
}

export function createRateLimitMiddleware({
  limiter = createRateLimiter(),
  keyGenerator = (req) => req.user?.id || req.ip,
  onRateLimited,
} = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const result = await limiter.check(String(keyGenerator(req)));
      res.setHeader("RateLimit-Limit", result.limit);
      res.setHeader("RateLimit-Remaining", result.remaining);
      res.setHeader(
        "RateLimit-Reset",
        Math.ceil(Date.now() / 1000) + result.retryAfterSeconds
      );

      if (!result.allowed) {
        res.setHeader("Retry-After", result.retryAfterSeconds);
        const body = {
          success: false,
          message: "Too many requests. Please retry later.",
          retryAfterSeconds: result.retryAfterSeconds,
          limit: result.limit,
          windowSeconds: limiter.windowSeconds,
        };
        if (typeof onRateLimited === "function") onRateLimited(req, body);
        return res.status(429).json(body);
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
