import { EntrywayError } from "./errors.js";

const DEFAULT_MAX_BYTES = 256 * 1024;

export interface BoundedJsonOptions {
  errorCode: string;
  invalidMessage: string;
  maxBytes?: number;
}

// Reading via Response.text() permits an upstream host to allocate unlimited
// memory before JSON validation. Bound bytes before decoding or parsing.
export async function readBoundedJson(
  response: Response,
  options: BoundedJsonOptions,
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("Invalid bounded JSON response limit");
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new EntrywayError(options.errorCode, options.invalidMessage, {
        statusCode: 502,
        retryable: false,
      });
    }
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EntrywayError(options.errorCode, options.invalidMessage, {
          statusCode: 502,
          retryable: false,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (receivedBytes === 0) return null;
  const body = Buffer.concat(chunks, receivedBytes).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Native SyntaxError messages sometimes include slices of rejected JSON.
    // Never attach parser causes or upstream bytes to retained diagnostics.
    throw new EntrywayError(options.errorCode, options.invalidMessage, {
      statusCode: 502,
      retryable: false,
    });
  }
}
