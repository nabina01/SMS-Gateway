import { Router } from "express";
import {
  getQueueJobHandler,
  getSmsLogsHandler,
  queueSmsHandler,
  sendSmsHandler,
} from "../controllers/sms.controller.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { createRateLimitMiddleware } from "../services/rate-limit.service.js";

const router = Router();

router.use(authenticateToken);
router.use(
  createRateLimitMiddleware({
    keyGenerator: (req) => `user:${req.user.id}`,
  })
);

router.post("/send", sendSmsHandler);
router.post("/queue", queueSmsHandler);
router.get("/queue/:jobId", getQueueJobHandler);
router.get("/logs", getSmsLogsHandler);

export default router;
