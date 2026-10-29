import "dotenv/config";
import prisma from "../src/config/prisma.js";

const [email, amountRaw] = process.argv.slice(2);
const amount = Number(amountRaw);

if (!email || !Number.isFinite(amount) || amount <= 0) {
  console.error("Usage: node scripts/credit-wallet.js <user-email> <positive-amount>");
  process.exit(1);
}

try {
  const user = await prisma.users.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { credit_wallets: true },
  });

  if (!user) {
    throw new Error("User not found");
  }
  if (!user.credit_wallets) {
    throw new Error("User does not have a wallet");
  }

  const wallet = await prisma.credit_wallets.update({
    where: { user_id: user.id },
    data: {
      balance: { increment: amount.toFixed(2) },
      updated_at: new Date(),
    },
  });

  console.log(
    `Credited ${amount.toFixed(2)} to ${user.email}. New balance: ${Number(wallet.balance).toFixed(2)}`
  );
} catch (error) {
  console.error("Wallet credit failed:", error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
