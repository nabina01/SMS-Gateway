import { processDeliveryReport } from "../services/webhook.service.js";

export async function deliveryWebhookHandler(req, res, next) {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";
    const result = await processDeliveryReport({
      headers: req.headers,
      rawBody,
      payload: req.body,
    });

    return res.status(200).json({
      success: true,
      message: result.duplicate
        ? "Delivery report already processed (idempotent)"
        : "Delivery report processed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
