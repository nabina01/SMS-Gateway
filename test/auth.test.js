import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import prisma from "../src/config/prisma.js";
import { registerUser, loginUser } from "../src/services/auth.service.js";
import { authenticateToken } from "../src/middleware/auth.middleware.js";

describe("Authentication & JWT Middleware", () => {
  const createdUserIds = [];

  after(async () => {
    // Clean up created test users
    for (const userId of createdUserIds) {
      await prisma.credit_wallets.deleteMany({ where: { user_id: userId } });
      await prisma.users.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("registers a new user and creates an associated credit wallet", async () => {
    const email = `authtest_${Date.now()}@test.local`;
    const result = await registerUser({
      name: "Auth Test User",
      email,
      password: "StrongPassword123!",
    });

    createdUserIds.push(BigInt(result.user.id));

    assert.ok(result.user.id);
    assert.equal(result.user.email, email);
    assert.ok(result.token);

    // Verify wallet was created in the database
    const wallet = await prisma.credit_wallets.findUnique({
      where: { user_id: BigInt(result.user.id) },
    });

    assert.ok(wallet);
    assert.equal(Number(wallet.balance), 0);
  });

  it("normalizes email and never exposes the password hash", async () => {
    const email = `MixedCase_${Date.now()}@Test.Local`;
    const result = await registerUser({
      name: "Case Test",
      email,
      password: "StrongPassword123!",
    });
    createdUserIds.push(BigInt(result.user.id));

    assert.equal(result.user.email, email.toLowerCase());
    assert.equal(result.user.password_hash, undefined);
    assert.equal(result.user.passwordHash, undefined);

    const stored = await prisma.users.findUnique({
      where: { id: BigInt(result.user.id) },
    });
    assert.ok(stored.password_hash.startsWith("$2"));
  });

  it("prevents duplicate email registration with a 409 error", async () => {
    const email = `duplicate_${Date.now()}@test.local`;
    const result = await registerUser({
      name: "Original User",
      email,
      password: "StrongPassword123!",
    });
    createdUserIds.push(BigInt(result.user.id));

    await assert.rejects(
      async () => {
        await registerUser({
          name: "Duplicate User",
          email,
          password: "AnotherPassword123!",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /already registered/);
        return true;
      }
    );
  });

  it("logs in an existing user with valid credentials", async () => {
    const email = `login_${Date.now()}@test.local`;
    const registered = await registerUser({
      name: "Login User",
      email,
      password: "CorrectPassword123!",
    });
    createdUserIds.push(BigInt(registered.user.id));

    const loggedIn = await loginUser({
      email,
      password: "CorrectPassword123!",
    });

    assert.equal(loggedIn.user.id, registered.user.id);
    assert.ok(loggedIn.token);
  });

  it("rejects login with an invalid password with a 401 error", async () => {
    const email = `wrongpass_${Date.now()}@test.local`;
    const registered = await registerUser({
      name: "Wrong Pass User",
      email,
      password: "CorrectPassword123!",
    });
    createdUserIds.push(BigInt(registered.user.id));

    await assert.rejects(
      async () => {
        await loginUser({
          email,
          password: "WrongPassword999!",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.match(err.message, /Invalid email or password/);
        return true;
      }
    );
  });

  it("authenticates valid JWT via authenticateToken middleware", async () => {
    const token = jwt.sign({ sub: "42" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {};
    let nextCalled = false;

    authenticateToken(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user.id, "42");
  });

  it("rejects requests without authorization header with 401", async () => {
    const req = { headers: {} };
    let statusSent = null;
    let jsonSent = null;

    const res = {
      status(code) {
        statusSent = code;
        return this;
      },
      json(data) {
        jsonSent = data;
        return this;
      },
    };

    authenticateToken(req, res, () => {
      assert.fail("Next should not be called without authorization header");
    });

    assert.equal(statusSent, 401);
    assert.equal(jsonSent.success, false);
  });

  it("rejects invalid or expired tokens with 401", async () => {
    const expiredToken = jwt.sign(
      { sub: "42" },
      process.env.JWT_SECRET,
      { expiresIn: "-1s" }
    );
    const req = { headers: { authorization: `Bearer ${expiredToken}` } };
    let statusSent = null;
    let jsonSent = null;

    const res = {
      status(code) {
        statusSent = code;
        return this;
      },
      json(data) {
        jsonSent = data;
        return this;
      },
    };

    authenticateToken(req, res, () => {
      assert.fail("Next should not be called with expired token");
    });

    assert.equal(statusSent, 401);
    assert.match(jsonSent.message, /Invalid or expired/);
  });
});
