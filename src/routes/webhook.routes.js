import { Router } from "express";
import { deliveryWebhookHandler } from "../controllers/webhook.controller.js";

const router = Router();

router.post("/sms/delivery", deliveryWebhookHandler);

export default router;
