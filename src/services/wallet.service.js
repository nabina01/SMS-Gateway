import prisma from "../config/prisma.js";
import { createHttpError } from "../utils/errors.js";

export async function getWalletForUser(userId) {
  const wallet = await prisma.credit_wallets.findUnique({
    where: { user_id: BigInt(userId) },
  });

  if (!wallet) {
    throw createHttpError("Credit wallet not found", 404);
  }

  return {
    id: wallet.id.toString(),
    userId: wallet.user_id.toString(),
    balance: Number(wallet.balance).toFixed(2),
    updatedAt: wallet.updated_at.toISOString(),
  };
}
