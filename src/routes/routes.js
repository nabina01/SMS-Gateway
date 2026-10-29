import { Router } from "express";
import authRoutes from "./auth.routes.js";
import smsRoutes from "./sms.routes.js";
import walletRoutes from "./wallet.routes.js";
import webhookRoutes from "./webhook.routes.js";
import { getProviderHealthHandler } from "../controllers/sms.controller.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/sms", smsRoutes);
router.use("/wallet", walletRoutes);
router.use("/webhooks", webhookRoutes);
router.get("/routes/health", getProviderHealthHandler);

export default router;
