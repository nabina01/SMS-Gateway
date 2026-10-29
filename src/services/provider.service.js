import prisma from "../config/prisma.js";
import { createHttpError } from "../utils/errors.js";

const HEALTH_WINDOW_HOURS = 24;
const HEALTHY_THRESHOLD = 0.9;
const DEGRADED_THRESHOLD = 0.7;

export async function getEligibleProviders(minBalance = 0) {
  return prisma.sms_providers.findMany({
    where: {
      is_active: true,
      balance: minBalance > 0 ? { gte: minBalance } : { gt: 0 },
    },
    orderBy: { priority: "asc" },
  });
}

export async function getBalance(providerId) {
  const provider = await prisma.sms_providers.findUnique({
    where: { id: BigInt(providerId) },
    select: {
      id: true,
      name: true,
      balance: true,
      is_active: true,
      priority: true,
      failure_rate: true,
    },
  });

  if (!provider) {
    throw createHttpError("SMS provider not found", 404);
  }

  return {
    id: provider.id.toString(),
    name: provider.name,
    balance: Number(provider.balance).toFixed(2),
    isActive: provider.is_active,
    priority: provider.priority,
    failureRate: Number(provider.failure_rate),
  };
}

export const getProviderBalance = getBalance;

export async function attemptProviderSend(provider, smsLogId, options = {}) {
  const providerKey = provider.name;
  const providerIdKey = provider.id.toString();
  const outcome =
    options.providerOutcomes?.[providerKey] ??
    options.providerOutcomes?.[providerIdKey];

  if (outcome === "throw") {
    throw new Error(`Provider ${provider.name} raised an unexpected transport error`);
  }

  const failureRate = Number(provider.failure_rate);
  let failed;

  if (outcome === "fail") {
    failed = true;
  } else if (outcome === "success") {
    failed = false;
  } else if (typeof options.simulatedFailure === "boolean") {
    failed = options.simulatedFailure;
  } else {
    const random = typeof options.random === "function" ? options.random : Math.random;
    failed = random() < failureRate;
  }

  return {
    success: !failed,
    providerId: providerIdKey,
    providerName: provider.name,
    smsLogId: String(smsLogId),
    error: failed
      ? `Simulated provider failure (failure_rate=${failureRate})`
      : null,
  };
}

function round(value, places = 2) {
  return Number(Number(value).toFixed(places));
}

export async function getProvidersHealth() {
  const since = new Date(Date.now() - HEALTH_WINDOW_HOURS * 60 * 60 * 1000);

  const [providers, groupedAttempts] = await Promise.all([
    prisma.sms_providers.findMany({ orderBy: { priority: "asc" } }),
    prisma.sms_provider_attempts.groupBy({
      by: ["provider_id", "status"],
      where: { attempted_at: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map();
  for (const row of groupedAttempts) {
    const key = row.provider_id.toString();
    const current = counts.get(key) || { sent: 0, failed: 0 };
    if (row.status === "sent") current.sent = row._count._all;
    if (row.status === "failed") current.failed = row._count._all;
    counts.set(key, current);
  }

  return providers.map((provider) => {
    const providerKey = provider.id.toString();
    const attemptCount = counts.get(providerKey) || { sent: 0, failed: 0 };
    const successfulAttempts = attemptCount.sent;
    const failedAttempts = attemptCount.failed;
    const totalAttempts = successfulAttempts + failedAttempts;
    const balance = Number(provider.balance);

    const successRate =
      totalAttempts > 0
        ? round(successfulAttempts / totalAttempts, 4)
        : null;
    const healthPercentage =
      successRate === null ? null : round(successRate * 100, 2);

    let availability = "available";
    if (!provider.is_active) availability = "inactive";
    else if (balance <= 0) availability = "no_balance";

    let healthStatus;
    if (!provider.is_active) {
      healthStatus = "inactive";
    } else if (balance <= 0) {
      healthStatus = "no_balance";
    } else if (totalAttempts === 0) {
      healthStatus = "unrated";
    } else if (successRate >= HEALTHY_THRESHOLD) {
      healthStatus = "healthy";
    } else if (successRate >= DEGRADED_THRESHOLD) {
      healthStatus = "degraded";
    } else {
      healthStatus = "unhealthy";
    }

    return {
      id: providerKey,
      name: provider.name,
      priority: provider.priority,
      balance: balance.toFixed(2),
      isActive: provider.is_active,
      availability,
      balanceState: balance > 0 ? "available" : "exhausted",
      totalAttempts24h: totalAttempts,
      successfulAttempts24h: successfulAttempts,
      failedAttempts24h: failedAttempts,
      successRate,
      healthPercentage,
      healthStatus,
      healthWindowHours: HEALTH_WINDOW_HOURS,
    };
  });
}
