import { getProvidersHealth } from "../services/provider.service.js";
import {
  enqueueSms,
  getSmsJobForUser,
  isQueueEnabled,
} from "../services/queue.service.js";
import { getSmsLogs, sendSms, validateSendPayload } from "../services/sms.service.js";

function readIdempotencyKey(req) {
  const header = req.get("Idempotency-Key");
  if (typeof header === "string" && header.trim()) {
    return header.trim().slice(0, 200);
  }
  return undefined;
}

export function sendStatusForResult(result) {
  if (result.sent === 0) return 502;
  if (result.failed > 0) return 207;
  return 200;
}

export async function sendSmsHandler(req, res, next) {
  try {
    const { to, message, mode } = req.body || {};
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (mode === "queue" || req.query.mode === "queue") {
      return queueSmsHandler(req, res, next);
    }

    const idempotencyKey = readIdempotencyKey(req);
    const result = await sendSms({ userId, to, message, idempotencyKey });
    const statusCode = sendStatusForResult(result);

    return res.status(statusCode).json({
      success: result.sent > 0,
      message:
        result.sent === 0
          ? "SMS could not be delivered by any provider; credits were refunded"
          : result.failed > 0
            ? "SMS batch completed with partial failures"
            : "SMS processing completed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function queueSmsHandler(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isQueueEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Queue mode is disabled. Set SMS_QUEUE_ENABLED=true and REDIS_URL.",
      });
    }

    const { to, message } = req.body || {};
    validateSendPayload(to, message);

    const idempotencyKey =
      readIdempotencyKey(req) ||
      (typeof req.body?.idempotencyKey === "string"
        ? req.body.idempotencyKey.trim().slice(0, 200)
        : undefined);

    const queued = await enqueueSms({
      userId,
      to,
      message,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return res.status(202).json({
      success: true,
      message: "SMS request queued. It has not been delivered yet.",
      data: queued,
    });
  } catch (error) {
    next(error);
  }
}

export async function getQueueJobHandler(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isQueueEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Queue mode is disabled. Set SMS_QUEUE_ENABLED=true and REDIS_URL.",
      });
    }

    const job = await getSmsJobForUser({
      jobId: String(req.params.jobId),
      userId,
    });

    return res.status(200).json({
      success: true,
      data: job,
    });
  } catch (error) {
    next(error);
  }
}

export async function getSmsLogsHandler(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const {
      page = 1,
      limit = 10,
      status,
      recipient,
      startDate,
      endDate,
      from,
      to,
      date,
    } = req.query;

    let computedStartDate = startDate || from;
    let computedEndDate = endDate || to;

    if (date) {
      computedStartDate = date;
      computedEndDate = date;
    }

    const result = await getSmsLogs({
      userId,
      page,
      limit,
      status,
      recipient,
      startDate: computedStartDate,
      endDate: computedEndDate,
    });

    return res.status(200).json({
      success: true,
      data: result.logs,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getProviderHealthHandler(req, res, next) {
  try {
    const health = await getProvidersHealth();

    return res.status(200).json({
      success: true,
      message: "Provider health retrieved successfully",
      data: health,
      meta: {
        windowHours: 24,
        successRateFormula:
          "successful attempts (status=sent) / total attempts in the last 24h; null when total=0",
        healthStatusRule:
          "unrated when there are no attempts; healthy >=90%, degraded >=70%, otherwise unhealthy; inactive/no_balance override",
      },
    });
  } catch (error) {
    next(error);
  }
}
