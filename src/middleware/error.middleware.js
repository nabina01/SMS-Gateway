export function errorHandler(err, req, res, _next) {
  if (res.headersSent) {
    return;
  }

  let statusCode = err.statusCode || (err.status ? Number(err.status) : 500);
  let message = err.message || "An unexpected error occurred";
  let errors = err.errors;

  if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "Invalid JSON body";
  } else if (err.code === "P2002") {
    statusCode = 409;
    message = "A record with the same unique value already exists";
  } else if (err.code === "P2025") {
    statusCode = 404;
    message = "Requested record was not found";
  } else if (err.name === "PrismaClientValidationError") {
    statusCode = 400;
    message = "Invalid database query input";
  }

  if (statusCode >= 500 && process.env.NODE_ENV === "production") {
    message = "Internal server error";
  }

  const response = { success: false, message };
  if (errors) response.errors = errors;

  if (statusCode >= 500) {
    console.error(`[Error] ${req.method} ${req.originalUrl}:`, err.message);
  }

  res.status(statusCode).json(response);
}
