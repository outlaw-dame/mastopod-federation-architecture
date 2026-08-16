import { beforeEach, describe, expect, it, vi } from "vitest";
import { secureActivityPubRequest } from "../../security/activitypub-egress-policy.js";
import { fetchRemoteKeyDocument } from "./RemoteKeyDocumentFetcher.js";

vi.mock("../../security/activitypub-egress-policy.js", () => ({
  secureActivityPubRequest: vi.fn(),
}));

const requestMock = vi.mocked(secureActivityPubRequest);
const PEM = "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----";

function responseBody(chunks: Array<string | Buffer>) {
  const destroy = vi.fn();
  return {
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      }
    },
  };
}

function response(statusCode: number, payload: unknown, headers: Record<string, string> = {}) {
  const body = responseBody([
    typeof payload === "string" ? payload : JSON.stringify(payload),
  ]);
  return { statusCode, headers, body } as any;
}

const options = {
  userAgent: "test-agent",
  timeoutMs: 5_000,
};

beforeEach(() => {
  requestMock.mockReset();
});

describe("fetchRemoteKeyDocument", () => {
  it("uses the shared pinned-DNS egress policy and extracts a bounded PEM", async () => {
    requestMock.mockResolvedValueOnce(response(200, { publicKey: { publicKeyPem: PEM } }));

    const result = await fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", options);

    expect(result).toMatchObject({
      publicKeyPem: PEM,
      resolvedUrl: "https://remote.example/users/alice",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(String(requestMock.mock.calls[0]?.[0])).toBe("https://remote.example/users/alice");
    expect(requestMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      bodyTimeout: 5_000,
      headersTimeout: 5_000,
    });
  });

  it("revalidates a same-origin redirect through the secure request helper", async () => {
    const redirect = response(302, "", { location: "/actors/alice" });
    requestMock
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(response(200, { publicKeyPem: PEM }));

    const result = await fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", options);

    expect(result?.resolvedUrl).toBe("https://remote.example/actors/alice");
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(String(requestMock.mock.calls[1]?.[0])).toBe("https://remote.example/actors/alice");
    expect(redirect.body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-origin redirect before making the redirected request", async () => {
    const redirect = response(302, "", { location: "https://other.example/key" });
    requestMock.mockResolvedValueOnce(redirect);

    await expect(fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", options))
      .resolves.toBeNull();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(redirect.body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized document before JSON parsing and destroys the body", async () => {
    const body = responseBody([Buffer.alloc(40_000), Buffer.alloc(30_000)]);
    requestMock.mockResolvedValueOnce({ statusCode: 200, headers: {}, body } as any);

    await expect(fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", {
      ...options,
      maxResponseBytes: 65_536,
    })).resolves.toBeNull();

    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized public key PEM", async () => {
    requestMock.mockResolvedValueOnce(response(200, {
      publicKeyPem: `-----BEGIN PUBLIC KEY-----${"x".repeat(2_000)}`,
    }));

    await expect(fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", {
      ...options,
      maxPublicKeyPemBytes: 1_024,
    })).resolves.toBeNull();
  });

  it("rejects invalid or credential-bearing key IDs before egress", async () => {
    await expect(fetchRemoteKeyDocument("not-a-url", options)).resolves.toBeNull();
    await expect(fetchRemoteKeyDocument("https://user:pass@remote.example/key", options)).resolves.toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("destroys non-success bodies without materializing them", async () => {
    const notFound = response(404, "x".repeat(10_000));
    requestMock.mockResolvedValueOnce(notFound);

    await expect(fetchRemoteKeyDocument("https://remote.example/users/alice#main-key", options))
      .resolves.toBeNull();

    expect(notFound.body.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops at the redirect ceiling", async () => {
    const first = response(302, "", { location: "/one" });
    const second = response(302, "", { location: "/two" });
    requestMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await expect(fetchRemoteKeyDocument("https://remote.example/key", {
      ...options,
      maxRedirects: 1,
    })).resolves.toBeNull();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(first.body.destroy).toHaveBeenCalledTimes(1);
    expect(second.body.destroy).toHaveBeenCalledTimes(1);
  });
});
