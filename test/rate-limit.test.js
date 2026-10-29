import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  MemoryRateLimitStore,
  createRateLimitMiddleware,
  createRateLimiter,
} from "../src/services/rate-limit.service.js";

describe("Per-user rate limiting", () => {
  let server;
  after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  function startApp(limiter) {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: req.get("x-user-id") || "1" };
      next();
    });
    app.use(createRateLimitMiddleware({ limiter }));
    app.get("/limited", (_req, res) => res.json({ success: true }));
    return new Promise((resolve) => {
      server = app.listen(0, () => resolve(`http://localhost:${server.address().port}`));
    });
  }

  it("returns 429 with Retry-After after the fixed-window limit", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = createRateLimiter({
      limit: 2,
      windowSeconds: 60,
      store,
      useRedis: false,
      prefix: "test-limit-a",
    });
    const baseUrl = await startApp(limiter);

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${baseUrl}/limited`, { headers: { "x-user-id": "1" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("ratelimit-remaining"), String(1 - i));
    }

    const blocked = await fetch(`${baseUrl}/limited`, { headers: { "x-user-id": "1" } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    const body = await blocked.json();
    assert.equal(body.success, false);
    assert.match(body.message, /Too many requests/);
  });

  it("separates users and resets after the window", async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = new MemoryRateLimitStore({ now: () => now });
    const limiter = createRateLimiter({
      limit: 2,
      windowSeconds: 60,
      store,
      useRedis: false,
      prefix: "test-limit-b",
    });

    assert.equal((await limiter.check("user:1")).allowed, true);
    assert.equal((await limiter.check("user:1")).allowed, true);
    assert.equal((await limiter.check("user:1")).allowed, false);
    assert.equal((await limiter.check("user:2")).allowed, true);

    now += 61_000;
    assert.equal((await limiter.check("user:1")).allowed, true);
  });

  it("uses the Redis store when it is available and reports the store type", async () => {
    let count = 0;
    const fakeRedisStore = {
      increment: async () => {
        count += 1;
        return { count, ttlSeconds: 30 };
      },
      reset: async () => {
        count = 0;
      },
    };
    const limiter = createRateLimiter({
      limit: 1,
      windowSeconds: 30,
      redisStore: fakeRedisStore,
      useRedis: true,
      prefix: "test-limit-c",
    });

    const first = await limiter.check("user:9");
    assert.equal(first.allowed, true);
    assert.equal(first.store, "redis");

    const second = await limiter.check("user:9");
    assert.equal(second.allowed, false);
    assert.equal(second.store, "redis");

    await limiter.reset("user:9");
    const third = await limiter.check("user:9");
    assert.equal(third.allowed, true);
  });

  it("falls back to the in-process store when Redis throws", async () => {
    const limiter = createRateLimiter({
      limit: 2,
      windowSeconds: 60,
      redisStore: {
        increment: async () => {
          throw new Error("redis down");
        },
        reset: async () => {},
      },
      useRedis: true,
      prefix: "test-limit-d",
    });

    const result = await limiter.check("user:fallback");
    assert.equal(result.allowed, true);
    assert.equal(result.store, "memory");
  });
});
