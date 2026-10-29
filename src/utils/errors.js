export function createHttpError(message, statusCode = 400, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) {
    error.errors = details;
  }
  return error;
}

export function isHttpError(error) {
  return Number.isInteger(error?.statusCode) && error.statusCode >= 400;
}
