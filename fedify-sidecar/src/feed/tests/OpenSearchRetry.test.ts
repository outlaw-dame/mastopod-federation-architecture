import { describe, expect, it, vi } from "vitest";
import {
  classifyOpenSearchRetryReason,
  isRetryableOpenSearchError,
  withOpenSearchRetry,
} from "../OpenSearchRetry.js";

describe("OpenSearchRetry", () => {
  it("classifies transient OpenSearch and transport errors as retryable", () => {
    expect(isRetryableOpenSearchError({ meta: { statusCode: 503 } })).toBe(true);
    expect(isRetryableOpenSearchError({ statusCode: 429 })).toBe(true);
    expect(isRetryableOpenSearchError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableOpenSearchError({ statusCode: 400 })).toBe(false);
  });

  it("sanitizes retry reason labels for safe metric cardinality", () => {
    expect(classifyOpenSearchRetryReason({ statusCode: 503 })).toBe("http_503");
    expect(classifyOpenSearchRetryReason({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe("und_err_connect_timeout");
    expect(classifyOpenSearchRetryReason({ code: "bad code with spaces!!!" })).toBe("bad_code_with_spaces");
  });

  it("retries transient failures and eventually returns", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue("ok");

    const value = await withOpenSearchRetry(operation, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      jitterRatio: 0,
    });

    expect(value).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("invokes onRetry callback with retry metadata", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    await withOpenSearchRetry(
      operation,
      {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
      },
      onRetry,
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, nextDelayMs: 1 }),
    );
  });

  it("does not retry non-retryable failures", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue({ statusCode: 400, message: "bad request" });

    await expect(
      withOpenSearchRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
