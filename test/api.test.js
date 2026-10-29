import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import app from "../src/server.js";
import prisma from "../src/config/prisma.js";
import { createTestProvider } from "./helpers.js";

describe("API Endpoints & Integration", () => {
  let server;
  let baseUrl;
  let testProvider;
  let userToken;
  let registeredEmail;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    testProvider = await createTestProvider({
      priority: 850,
      balance: "500.00",
      failureRate: "0.00",
    });
  });

  after(async () => {
    if (registeredEmail) {
      const user = await prisma.users.findUnique({ where: { email: registeredEmail } });
      if (user) {
        await prisma.sms_provider_attempts.deleteMany({
          where: { sms_logs: { user_id: user.id } },
        });
        await prisma.sms_logs.deleteMany({ where: { user_id: user.id } });
        await prisma.credit_wallets.deleteMany({ where: { user_id: user.id } });
        await prisma.users.delete({ where: { id: user.id } });
      }
    }

    if (testProvider) {
      await testProvider.cleanup();
    }

    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  it("GET /health returns healthy status", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.message, "SMS Gateway API is healthy");
  });

  it("POST /auth/register creates a user and returns a token", async () => {
    registeredEmail = `api_user_${Date.now()}@test.local`;
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "API Tester",
        email: registeredEmail,
        password: "SuperSecret123!",
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.token);
    assert.equal(body.data.user.email, registeredEmail);
    userToken = body.data.token;
  });

  it("POST /auth/login returns token for valid credentials", async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: registeredEmail,
        password: "SuperSecret123!",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.token);
  });

  it("GET /api/auth/me returns current user profile with valid Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.email, registeredEmail);
  });

  it("GET /wallet returns only the authenticated user's wallet", async () => {
    const res = await fetch(`${baseUrl}/wallet`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.match(body.data.balance, /^\d+\.\d{2}$/);
    assert.equal(typeof body.data.userId, "string");
  });

  it("rejects invalid registration payloads with 400", async () => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", email: "not-an-email", password: "short" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(Array.isArray(body.errors));
  });

  it("GET /routes/health returns provider health metrics", async () => {
    const res = await fetch(`${baseUrl}/routes/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    const item = body.data.find((p) => p.id === testProvider.provider.id.toString());
    assert.ok(item);
    assert.equal(item.priority, 850);
  });

  it("POST /sms/send rejects unauthenticated request with 401", async () => {
    const res = await fetch(`${baseUrl}/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: ["9841234567"],
        message: "Unauthenticated ping",
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  it("POST /sms/send deducts credits and sends SMS when user has credits", async () => {
    const user = await prisma.users.findUnique({ where: { email: registeredEmail } });
    await prisma.credit_wallets.update({
      where: { user_id: user.id },
      data: { balance: "5.00" },
    });

    const res = await fetch(`${baseUrl}/sms/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        to: ["9841234567"],
        message: "Hello API",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.sent, 1);
    assert.equal(body.data.failed, 0);
  });

  it("POST /sms/send rejects an invalid number with 400 and does not send", async () => {
    const res = await fetch(`${baseUrl}/sms/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        to: ["9841234567", "9612345678"],
        message: "Invalid recipient test",
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /Invalid recipient/);

    const user = await prisma.users.findUnique({ where: { email: registeredEmail } });
    const logCount = await prisma.sms_logs.count({ where: { user_id: user.id } });
    assert.equal(logCount, 1);
  });

  it("POST /sms/send returns 402 for insufficient credits", async () => {
    const user = await prisma.users.findUnique({ where: { email: registeredEmail } });
    await prisma.credit_wallets.update({
      where: { user_id: user.id },
      data: { balance: "0.00" },
    });

    const res = await fetch(`${baseUrl}/sms/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ to: ["9841234567"], message: "No credits" }),
    });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /Insufficient credits/);
  });

  it("GET /sms/logs returns paginated logs for authenticated user", async () => {
    const res = await fetch(`${baseUrl}/sms/logs?page=1&limit=5`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].recipient, "9841234567");
    assert.equal(body.data[0].status, "sent");
    assert.ok(body.pagination);
    assert.equal(body.pagination.totalCount, 1);
  });

  it("POST /sms/send returns 502 and refunds when every provider fails", async () => {
    const user = await prisma.users.findUnique({ where: { email: registeredEmail } });
    await prisma.credit_wallets.update({
      where: { user_id: user.id },
      data: { balance: "2.00" },
    });

    const failing = await createTestProvider({
      priority: 851,
      balance: "50.00",
      failureRate: "1.00",
    });

    await prisma.sms_providers.update({
      where: { id: testProvider.provider.id },
      data: { is_active: false },
    });

    try {
      const res = await fetch(`${baseUrl}/sms/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          to: ["9841234567"],
          message: "All providers fail",
        }),
      });

      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.data.sent, 0);
      assert.equal(body.data.totalRefunded, "1.00");

      const wallet = await prisma.credit_wallets.findUnique({
        where: { user_id: user.id },
      });
      assert.equal(Number(wallet.balance), 2);
    } finally {
      await prisma.sms_providers.update({
        where: { id: testProvider.provider.id },
        data: { is_active: true },
      });
      await failing.cleanup();
    }
  });
});
