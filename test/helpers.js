import prisma from "../src/config/prisma.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../src/utils/jwt.js";

/**
 * Creates an isolated test user with an initial wallet balance.
 */
export async function createTestUser({
  name = "Test User",
  emailPrefix = "test",
  balance = "10.00",
} = {}) {
  const email = `${emailPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@test.local`;
  const passwordHash = await bcrypt.hash("TestPass123!", 10);

  const user = await prisma.users.create({
    data: {
      name,
      email,
      password_hash: passwordHash,
      credit_wallets: {
        create: {
          balance,
        },
      },
    },
    include: {
      credit_wallets: true,
    },
  });

  const token = generateToken(user.id);

  return {
    user,
    token,
    cleanup: async () => {
      await prisma.sms_provider_attempts.deleteMany({
        where: { sms_logs: { user_id: user.id } },
      });
      await prisma.sms_logs.deleteMany({
        where: { user_id: user.id },
      });
      await prisma.credit_wallets.deleteMany({
        where: { user_id: user.id },
      });
      await prisma.users.delete({
        where: { id: user.id },
      });
    },
  };
}

/**
 * Creates an isolated test provider.
 */
export async function createTestProvider({
  namePrefix = "TestProvider",
  priority = 990,
  balance = "500.00",
  failureRate = "0.00",
  isActive = true,
} = {}) {
  const name = `${namePrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const provider = await prisma.sms_providers.create({
    data: {
      name,
      priority,
      balance,
      failure_rate: failureRate,
      is_active: isActive,
    },
  });

  return {
    provider,
    cleanup: async () => {
      await prisma.sms_provider_attempts.deleteMany({
        where: { provider_id: provider.id },
      });
      await prisma.sms_logs.updateMany({
        where: { provider_id: provider.id },
        data: { provider_id: null },
      });
      await prisma.sms_providers.delete({
        where: { id: provider.id },
      });
    },
  };
}
