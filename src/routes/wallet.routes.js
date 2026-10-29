import { Router } from "express";
import { getWalletHandler } from "../controllers/wallet.controller.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticateToken);
router.get("/", getWalletHandler);

export default router;
