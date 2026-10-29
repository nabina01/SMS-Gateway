import "dotenv/config";
import prisma from "../src/config/prisma.js";

const DEFAULT_PROVIDERS = [
  { name: "SparrowMock", priority: 1, balance: "1000.00", failureRate: "0.05", isActive: true },
  { name: "AakashMock", priority: 2, balance: "500.00", failureRate: "0.15", isActive: true },
  { name: "BulkSmsMock", priority: 3, balance: "250.00", failureRate: "0.00", isActive: true },
];

function configuredProviders() {
  if (!process.env.SMS_PROVIDER_SEED_JSON) return DEFAULT_PROVIDERS;
  let parsed;
  try {
    parsed = JSON.parse(process.env.SMS_PROVIDER_SEED_JSON);
  } catch {
    throw new Error("SMS_PROVIDER_SEED_JSON must contain valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SMS_PROVIDER_SEED_JSON must be a non-empty JSON array");
  }
  return parsed.map((provider, index) => {
    if (!provider.name || !Number.isInteger(Number(provider.priority))) {
      throw new Error(`Provider at index ${index} needs a name and integer priority`);
    }
    const priority = Number(provider.priority);
    const balance = Number(provider.balance ?? 0);
    const failureRate = Number(provider.failureRate ?? provider.failure_rate ?? 0);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error(`Provider ${provider.name} has an invalid balance`);
    }
    if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) {
      throw new Error(`Provider ${provider.name} failureRate must be between 0 and 1`);
    }
    return {
      name: String(provider.name),
      priority,
      balance: balance.toFixed(2),
      failureRate: failureRate.toFixed(3),
      isActive: provider.isActive !== false && provider.is_active !== false,
    };
  });
}

/**
 * Idempotent seed/upsert for mock providers only. It never creates customers,
 * wallets, logs, or attempts, and it does not reset provider balances.
 */
export async function seedProviders() {
  const providers = configuredProviders();
  console.log(`Seeding ${providers.length} mock SMS providers...`);

  for (const provider of providers) {
    const upserted = await prisma.sms_providers.upsert({
      where: { name: provider.name },
      update: {
        priority: provider.priority,
        failure_rate: provider.failureRate,
        is_active: provider.isActive,
      },
      create: {
        name: provider.name,
        priority: provider.priority,
        balance: provider.balance,
        failure_rate: provider.failureRate,
        is_active: provider.isActive,
      },
    });
    console.log(
      `Provider configured: ${upserted.name} (priority=${upserted.priority}, balance=${upserted.balance})`
    );
  }

  console.log("Mock SMS providers seeded successfully.");
}

if (process.argv[1]?.endsWith("seed.js")) {
  seedProviders()
    .catch((error) => {
      console.error("Seed execution failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
