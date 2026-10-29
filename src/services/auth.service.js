import bcrypt from "bcryptjs";
import prisma from "../config/prisma.js";
import { createHttpError } from "../utils/errors.js";
import { generateToken } from "../utils/jwt.js";

function welcomeCredits() {
  const value = Number(process.env.WELCOME_CREDITS || 0);
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "0.00";
}

function publicUser(user) {
  return {
    id: user.id.toString(),
    name: user.name,
    email: user.email,
  };
}

export async function registerUser({ name, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await prisma.users.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    throw createHttpError("Email is already registered", 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.users.create({
        data: {
          name: name.trim(),
          email: normalizedEmail,
          password_hash: passwordHash,
        },
      });

      await tx.credit_wallets.create({
        data: {
          user_id: createdUser.id,
          balance: welcomeCredits(),
        },
      });

      return createdUser;
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw createHttpError("Email is already registered", 409);
    }
    throw error;
  }

  return {
    user: publicUser(user),
    token: generateToken(user.id),
  };
}

export async function loginUser({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.users.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw createHttpError("Invalid email or password", 401);
  }

  return {
    user: publicUser(user),
    token: generateToken(user.id),
  };
}
