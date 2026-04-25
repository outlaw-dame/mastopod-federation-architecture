export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "BAD_REQUEST", message, details);

export const unauthorized = (message = "Unauthorized") =>
  new HttpError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Forbidden") =>
  new HttpError(403, "FORBIDDEN", message);

export const notFound = (message = "Not found") =>
  new HttpError(404, "NOT_FOUND", message);

export const conflict = (message = "Conflict") =>
  new HttpError(409, "CONFLICT", message);

export const tooMany = (message = "Too many requests") =>
  new HttpError(429, "RATE_LIMITED", message);

export const internal = (message = "Internal error") =>
  new HttpError(500, "INTERNAL_ERROR", message);
