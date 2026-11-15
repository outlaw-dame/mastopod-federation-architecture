import { describe, expect, it } from "vitest";
import { readBoundedJson } from "../readBoundedJson.js";

const options = { errorCode: "invalid_json", invalidMessage: "Rejected upstream body", maxBytes: 128 };

describe("readBoundedJson", () => {
  it("accepts well-formed JSON below the byte bound", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    await expect(readBoundedJson(response, options)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized Content-Length before parsing", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "content-length": "1000000" },
    });
    await expect(readBoundedJson(response, options)).rejects.toMatchObject({
      code: "invalid_json",
      message: "Rejected upstream body",
      retryable: false,
    });
  });

  it("rejects a chunked response that exceeds the limit without retaining bytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("A".repeat(100)));
        controller.enqueue(new TextEncoder().encode("B".repeat(100)));
        controller.close();
      },
    });
    const response = new Response(body, { status: 200 });
    await expect(readBoundedJson(response, options)).rejects.toMatchObject({
      code: "invalid_json",
      message: "Rejected upstream body",
    });
  });

  it("never includes malformed upstream secrets in the parsing error", async () => {
    const secret = "private-user-password-12345";
    const response = new Response(`{"password":"${secret}"`, { status: 200 });
    let error: unknown;
    try {
      await readBoundedJson(response, options);
    } catch (received) {
      error = received;
    }
    expect(error).toMatchObject({ code: "invalid_json", message: "Rejected upstream body" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("returns null for an empty JSON response", async () => {
    const response = new Response(null, { status: 200 });
    await expect(readBoundedJson(response, options)).resolves.toBeNull();
  });
});
