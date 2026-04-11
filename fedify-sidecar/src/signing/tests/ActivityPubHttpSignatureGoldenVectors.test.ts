import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import crypto from "node:crypto";
import { SigningClient } from "../signing-client.js";

function createClient(): SigningClient {
  return new SigningClient({
    baseUrl: "http://localhost:3000",
    token: "test-token",
    maxBatchSize: 100,
    maxBodyBytes: 1024 * 1024,
    timeoutMs: 5_000,
    maxRetries: 1,
    retryDelayMs: 50,
  });
}

function buildSigningString(input: {
  requestTarget: string;
  host: string;
  date: string;
  digest?: string;
  contentType?: string;
}, signedHeaders: string[]): string {
  return signedHeaders
    .map((header) => {
      const normalized = header.toLowerCase();
      if (normalized === "(request-target)") {
        return `(request-target): ${input.requestTarget}`;
      }
      if (normalized === "host") {
        return `host: ${input.host}`;
      }
      if (normalized === "date") {
        return `date: ${input.date}`;
      }
      if (normalized === "digest") {
        return `digest: ${input.digest}`;
      }
      if (normalized === "content-type") {
        return `content-type: ${input.contentType}`;
      }
      throw new Error(`Unsupported header ${header}`);
    })
    .join("\n");
}

describe("ActivityPub HTTP signature golden vectors", () => {
  it("encodes POST signing requests with the GoToSocial/Mastodon baseline profile", () => {
    const client = createClient();
    const item = (client as any)._toApItem({
      requestId: "req-1",
      actorUri: "https://pod.example/users/alice",
      method: "POST",
      targetUrl: "https://mastodon.example/inbox?shared=true",
      body: '{"id":"https://pod.example/activities/1","type":"Create"}',
    });

    expect(item).toMatchObject({
      requestId: "req-1",
      actorUri: "https://pod.example/users/alice",
      method: "POST",
      profile: "ap_post_v1",
      target: {
        host: "mastodon.example",
        path: "/inbox",
        query: "?shared=true",
      },
      body: {
        bytes: '{"id":"https://pod.example/activities/1","type":"Create"}',
        encoding: "utf8",
      },
      digest: {
        mode: "server_compute",
      },
    });
  });

  it("keeps GET signatures on the lean baseline without digest or content-type coverage", () => {
    const client = createClient();
    const item = (client as any)._toApItem({
      requestId: "req-2",
      actorUri: "https://pod.example/users/alice",
      method: "GET",
      targetUrl: "https://mastodon.example/users/alice",
    });

    expect(item).toMatchObject({
      requestId: "req-2",
      actorUri: "https://pod.example/users/alice",
      method: "GET",
      profile: "ap_get_v1",
      target: {
        host: "mastodon.example",
        path: "/users/alice",
        query: "",
      },
    });
    expect(item).not.toHaveProperty("digest");
    expect(item).not.toHaveProperty("body");
  });

  it("matches the ActivityPods Cavage signing-string baseline for POST requests", () => {
    const body = '{"id":"https://pod.example/activities/1","type":"Create"}';
    const digest = `SHA-256=${crypto.createHash("sha256").update(body).digest("base64")}`;
    const signingString = buildSigningString(
      {
        requestTarget: "post /inbox?shared=true",
        host: "mastodon.example",
        date: "Tue, 01 Jan 2030 00:00:00 GMT",
        digest,
      },
      ["(request-target)", "host", "date", "digest"],
    );

    expect(signingString).toBe(
      `(request-target): post /inbox?shared=true\n`
      + `host: mastodon.example\n`
      + `date: Tue, 01 Jan 2030 00:00:00 GMT\n`
      + `digest: ${digest}`,
    );
  });

  it("normalizes successful signing responses into wire-ready headers", () => {
    const client = createClient();
    const result = (client as any)._fromApResult({
      requestId: "req-3",
      ok: true,
      outHeaders: {
        Date: "Tue, 01 Jan 2030 00:00:00 GMT",
        Signature:
          'keyId="https://pod.example/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc123=="',
        Digest: "SHA-256=deadbeefbase64==",
      },
      meta: {
        keyId: "https://pod.example/users/alice#main-key",
        algorithm: "rsa-sha256",
        signedHeaders: "(request-target) host date digest",
      },
    });

    expect(result).toMatchObject({
      requestId: "req-3",
      ok: true,
      signedHeaders: {
        date: "Tue, 01 Jan 2030 00:00:00 GMT",
        signature:
          'keyId="https://pod.example/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc123=="',
        digest: "SHA-256=deadbeefbase64==",
      },
      meta: {
        keyId: "https://pod.example/users/alice#main-key",
        algorithm: "rsa-sha256",
        signedHeaders: "(request-target) host date digest",
      },
    });
  });
});
