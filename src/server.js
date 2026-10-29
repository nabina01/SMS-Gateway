import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import prisma from "./config/prisma.js";
import authRoutes from "./routes/auth.routes.js";
import apiRoutes from "./routes/routes.js";
import smsRoutes from "./routes/sms.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import { authenticateToken } from "./middleware/auth.middleware.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { getProviderHealthHandler } from "./controllers/sms.controller.js";
import { closeSmsQueue } from "./services/queue.service.js";

BigInt.prototype.toJSON = function toJSON() {
  return this.toString();
};

const app = express();
app.disable("x-powered-by");

app.use(
  express.json({
    limit: "100kb",
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);

app.use("/auth", authRoutes);
app.use("/sms", smsRoutes);
app.use("/wallet", walletRoutes);
app.use("/webhooks", webhookRoutes);
app.use("/api", apiRoutes);

app.get("/routes/health", getProviderHealthHandler);
app.get("/api/routes/health", getProviderHealthHandler);

app.get("/api/auth/me", authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: BigInt(req.user.id) },
      select: { id: true, name: true, email: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: user.id.toString(),
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    next(error);
  }
});

async function healthHandler(_req, res) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      success: true,
      message: "SMS Gateway API is healthy",
      data: {
        database: "up",
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  } catch {
    return res.status(503).json({
      success: false,
      message: "SMS Gateway API is unhealthy",
      data: { database: "down" },
    });
  }
}

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use(errorHandler);

const PORT = Number(process.env.PORT) || 3000;
let server;

const isMainModule =
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();

if (isMainModule) {
  server = app.listen(PORT, () => {
    console.log(`SMS Gateway API running at http://localhost:${PORT}`);
  });
}

async function shutdown() {
  console.log("Shutting down SMS Gateway API...");

  const finish = async () => {
    await closeSmsQueue().catch(() => {});
    await prisma.$disconnect();
    process.exit(0);
  };

  if (server) {
    server.close(() => {
      finish();
    });
    setTimeout(() => finish(), 10_000).unref();
  } else {
    await finish();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
export { server };
