import { describe, expect, it } from "vitest";
import {
  isSafeTargetInboxUrl,
  parseRetryAfterMs,
  sanitizeErrorText,
  sanitizeResponseBodySnippet,
} from "../outbound-worker.js";

describe("OutboundWorker helper hardening", () => {
  it("accepts https and loopback-only http inbox URLs", () => {
    expect(isSafeTargetInboxUrl("https://remote.example/inbox")).toBe(true);
    expect(isSafeTargetInboxUrl("http://localhost/inbox")).toBe(true);
    expect(isSafeTargetInboxUrl("http://127.0.0.1/inbox")).toBe(true);
    expect(isSafeTargetInboxUrl("http://10.0.0.5/inbox")).toBe(false);
    expect(isSafeTargetInboxUrl("ftp://remote.example/inbox")).toBe(false);
    expect(isSafeTargetInboxUrl("https://user:pass@remote.example/inbox")).toBe(false);
  });

  it("parses Retry-After seconds and HTTP-date with cap", () => {
    expect(parseRetryAfterMs("120", 0)).toBe(120_000);

    const now = Date.parse("2026-04-10T00:00:00.000Z");
    const fiveSecLater = new Date(now + 5_000).toUTCString();
    const parsedDateDelay = parseRetryAfterMs(fiveSecLater, now);
    expect(parsedDateDelay).toBeGreaterThanOrEqual(0);
    expect(parsedDateDelay).toBeLessThanOrEqual(5_000);

    expect(parseRetryAfterMs("99999999", now)).toBe(3_600_000);
    expect(parseRetryAfterMs("not-a-value", now)).toBeUndefined();
  });

  it("sanitizes sensitive error text and response snippets", () => {
    const raw = "request failed\nAuthorization: Bearer secret-token-value";
    const sanitized = sanitizeErrorText(raw);
    expect(sanitized).not.toContain("secret-token-value");
    expect(sanitized).toContain("Bearer [redacted]");

    expect(sanitizeResponseBodySnippet("\u0000bad\u0008text\n")).toBe("badtext");
    expect(sanitizeResponseBodySnippet(42 as unknown)).toBeUndefined();
  });
});
