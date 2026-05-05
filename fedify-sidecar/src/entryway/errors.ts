export class EntrywayError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: string,
    message: string,
    options: {
      statusCode?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EntrywayError";
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toEntrywayError(error: unknown): EntrywayError {
  if (error instanceof EntrywayError) {
    return error;
  }

  return new EntrywayError("entryway_internal_error", "Entryway request failed", {
    statusCode: 500,
    retryable: false,
    cause: error,
  });
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof EntrywayError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return redactSensitiveText(error.message);
  }
  return "Entryway request failed";
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/("?(?:password|accessJwt|refreshJwt|authorization|token)"?\s*[:=]\s*)("[^"]+"|[^\s,}]+)/gi, "$1[redacted]")
    .slice(0, 512);
}
