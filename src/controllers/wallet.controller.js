import { getWalletForUser } from "../services/wallet.service.js";

export async function getWalletHandler(req, res, next) {
  try {
    const wallet = await getWalletForUser(req.user.id);
    return res.status(200).json({
      success: true,
      data: wallet,
    });
  } catch (error) {
    next(error);
  }
}
