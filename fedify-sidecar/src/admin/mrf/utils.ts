import { ZodError, type ZodSchema } from "zod";
import { HttpError, badRequest, internal } from "./errors.js";

export async function parseJson<T>(req: Request): Promise<T> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "BAD_JSON", "Malformed JSON body");
  }
}

export function parseWithSchema<T>(schema: ZodSchema<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest("Invalid request payload", err.flatten());
    }
    throw err;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorToResponse(err: unknown, requestId?: string): Response {
  if (err instanceof HttpError) {
    return json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          requestId,
        },
      },
      err.status,
    );
  }

  const e = internal();
  return json(
    {
      error: {
        code: e.code,
        message: e.message,
        requestId,
      },
    },
    e.status,
  );
}

export function redactTrace<T>(trace: T, includePrivate = false): T {
  if (includePrivate) return trace;
  const clone = { ...(trace as Record<string, unknown>) };
  delete clone["rawContent"];
  delete clone["signedHeaders"];
  delete clone["token"];
  delete clone["dmPayload"];
  return clone as T;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    retries = 4,
    baseMs = 100,
    maxMs = 2000,
  }: { retries?: number; baseMs?: number; maxMs?: number } = {},
): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(25, backoff / 4));
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      attempt += 1;
    }
  }

  throw lastErr;
}
