import { createHash, createVerify } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { request } from "undici";
import { logger } from "../utils/logger.js";

const INTERNAL_RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const INTERNAL_MAX_ATTEMPTS = 3;
const INTERNAL_BASE_DELAY_MS = 100;
const INTERNAL_MAX_DELAY_MS = 750;

export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

function parseSignatureHeader(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      params[match[1]] = match[2];
    }
  }
  return params;
}

async function fetchActorDocumentForKey(
  keyId: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const fetchUrl = keyId.includes("#") ? keyId.split("#")[0]! : keyId;
  try {
    const response = await request(fetchUrl, {
      method: "GET",
      headers: {
        accept: "application/activity+json, application/ld+json",
        "user-agent": userAgent,
      },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      maxRedirections: 3,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.text();
      return null;
    }
    return await response.body.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractPublicKeyPem(doc: Record<string, unknown>): string | null {
  const publicKey = doc["publicKey"];
  if (typeof publicKey === "object" && publicKey !== null) {
    const pem = (publicKey as Record<string, unknown>)["publicKeyPem"];
    if (typeof pem === "string") {
      return pem;
    }
  }
  return typeof doc["publicKeyPem"] === "string" ? doc["publicKeyPem"] : null;
}

function buildSigningString(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  signedHeaderNames: string[],
): string {
  const lines: string[] = [];
  for (const name of signedHeaderNames) {
    const lower = name.toLowerCase();
    if (lower === "(request-target)") {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
      continue;
    }

    const value = headers[lower];
    if (value !== undefined) {
      lines.push(`${lower}: ${Array.isArray(value) ? value[0] : value}`);
    }
  }
  return lines.join("\n");
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextBackoffDelayMs(attempt: number): number {
  return Math.min(INTERNAL_MAX_DELAY_MS, INTERNAL_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

function isRetryableInternalStatus(statusCode: number): boolean {
  return INTERNAL_RETRYABLE_STATUS_CODES.has(statusCode);
}

export async function verifyOwnerHttpSignature(
  req: FastifyRequest,
  identifier: string,
  domain: string,
  userAgent: string,
  timeoutMs: number,
  rawBody?: string | Buffer,
): Promise<{ status: number; error: string } | null> {
  const rawSignature = req.headers["signature"];
  if (typeof rawSignature !== "string" || rawSignature.length === 0) {
    return { status: 401, error: "HTTP Signature required" };
  }

  const sigParams = parseSignatureHeader(rawSignature);
  const keyId = sigParams["keyId"];
  const signatureB64 = sigParams["signature"];
  const signedHeadersRaw = sigParams["headers"];

  if (
    typeof keyId !== "string" || keyId.length === 0 ||
    typeof signatureB64 !== "string" ||
    typeof signedHeadersRaw !== "string"
  ) {
    return { status: 401, error: "Malformed HTTP Signature" };
  }

  const expectedActorUri = `https://${domain}/users/${encodeURIComponent(identifier)}`;
  const keyIdBase = keyId.includes("#") ? keyId.split("#")[0]! : keyId;
  if (keyIdBase !== expectedActorUri) {
    return { status: 403, error: "Access denied: not the collection owner" };
  }

  const actorDoc = await fetchActorDocumentForKey(keyId, userAgent, timeoutMs);
  if (!actorDoc) {
    return { status: 401, error: "Could not fetch signing key document" };
  }

  const publicKeyPem = extractPublicKeyPem(actorDoc);
  if (!publicKeyPem) {
    return { status: 401, error: "No public key in key document" };
  }

  const digestHeader = req.headers["digest"];
  if (typeof digestHeader === "string") {
    const bodyBytes = rawBody
      ? (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"))
      : Buffer.alloc(0);
    const expectedDigest = `SHA-256=${createHash("sha256").update(bodyBytes).digest("base64")}`;
    if (digestHeader !== expectedDigest) {
      return { status: 401, error: "Digest mismatch" };
    }
  }

  const rawHeaders = req.headers as Record<string, string | string[] | undefined>;
  const signingString = buildSigningString(req.method, req.url, rawHeaders, signedHeadersRaw.split(" "));

  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingString);
    const isValid = verifier.verify(publicKeyPem, signatureB64, "base64");
    if (!isValid) {
      return { status: 401, error: "Signature verification failed" };
    }
  } catch {
    return { status: 401, error: "Signature verification error" };
  }

  return null;
}

/**
 * Verify an HTTP Signature from any valid AP actor (not just the collection
 * owner). Used for POST endpoints that accept messages from remote peers.
 * Returns the sender's base actor URI on success.
 */
export async function verifyAnyActorHttpSignature(
  req: FastifyRequest,
  rawBody: string | Buffer,
  userAgent: string,
  timeoutMs: number,
): Promise<{ ok: false; status: number; error: string } | { ok: true; senderUri: string }> {
  const rawSignature = req.headers["signature"];
  if (typeof rawSignature !== "string" || rawSignature.length === 0) {
    return { ok: false, status: 401, error: "HTTP Signature required" };
  }

  const sigParams = parseSignatureHeader(rawSignature);
  const keyId = sigParams["keyId"];
  const signatureB64 = sigParams["signature"];
  const signedHeadersRaw = sigParams["headers"];

  if (
    typeof keyId !== "string" || keyId.length === 0 ||
    typeof signatureB64 !== "string" ||
    typeof signedHeadersRaw !== "string"
  ) {
    return { ok: false, status: 401, error: "Malformed HTTP Signature" };
  }

  const actorDoc = await fetchActorDocumentForKey(keyId, userAgent, timeoutMs);
  if (!actorDoc) {
    return { ok: false, status: 401, error: "Could not fetch signing key document" };
  }

  const publicKeyPem = extractPublicKeyPem(actorDoc);
  if (!publicKeyPem) {
    return { ok: false, status: 401, error: "No public key in key document" };
  }

  const digestHeader = req.headers["digest"];
  if (typeof digestHeader === "string") {
    const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
    const expectedDigest = `SHA-256=${createHash("sha256").update(bodyBytes).digest("base64")}`;
    if (digestHeader !== expectedDigest) {
      return { ok: false, status: 401, error: "Digest mismatch" };
    }
  }

  const rawHeaders = req.headers as Record<string, string | string[] | undefined>;
  const signingString = buildSigningString("POST", req.url, rawHeaders, signedHeadersRaw.split(" "));

  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingString);
    const isValid = verifier.verify(publicKeyPem, signatureB64, "base64");
    if (!isValid) {
      return { ok: false, status: 401, error: "Signature verification failed" };
    }
  } catch {
    return { ok: false, status: 401, error: "Signature verification error" };
  }

  const senderUri = keyId.includes("#") ? keyId.split("#")[0]! : keyId;
  return { ok: true, senderUri };
}

/**
 * POST to an internal ActivityPods API endpoint with a JSON body.
 * Returns the HTTP status code and parsed response body.
 * Retries on transient server errors (5xx, 408, 429).
 */
export async function postInternalActivityPodsBody<T>(input: {
  label: string;
  url: string;
  identifier: string;
  activityPodsToken: string;
  timeoutMs: number;
  body: unknown;
}): Promise<{ statusCode: number; data: T | null }> {
  const serialized = JSON.stringify(input.body);

  for (let attempt = 1; attempt <= INTERNAL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(input.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.activityPodsToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: serialized,
        bodyTimeout: input.timeoutMs,
        headersTimeout: input.timeoutMs,
      });

      const statusCode = response.statusCode;

      if (statusCode >= 200 && statusCode < 300) {
        const data = await response.body.json() as T;
        return { statusCode, data };
      }

      // Surface 4xx directly — these are not retryable
      if (statusCode >= 400 && statusCode < 500) {
        let data: T | null = null;
        try { data = await response.body.json() as T; } catch { await response.body.text().catch(() => {}); }
        return { statusCode, data };
      }

      await response.body.text().catch(() => {});
      const retryable = isRetryableInternalStatus(statusCode);
      if (!retryable || attempt === INTERNAL_MAX_ATTEMPTS) {
        logger.warn("[internal-post] ActivityPods returned unexpected status", {
          label: input.label,
          identifier: input.identifier,
          status: statusCode,
        });
        return { statusCode, data: null };
      }
    } catch (error: unknown) {
      if (attempt === INTERNAL_MAX_ATTEMPTS) {
        logger.warn("[internal-post] ActivityPods request failed", {
          label: input.label,
          identifier: input.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
        return { statusCode: 503, data: null };
      }
    }

    await wait(nextBackoffDelayMs(attempt));
  }

  return { statusCode: 503, data: null };
}

export async function fetchInternalActivityPodsBody<T>(input: {
  label: string;
  url: string;
  identifier: string;
  activityPodsToken: string;
  timeoutMs: number;
}): Promise<T | null> {
  for (let attempt = 1; attempt <= INTERNAL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(input.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.activityPodsToken}`,
          accept: "application/json",
        },
        bodyTimeout: input.timeoutMs,
        headersTimeout: input.timeoutMs,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return await response.body.json() as T;
      }

      if (response.statusCode === 404 || response.statusCode === 501) {
        await response.body.text();
        return null;
      }

      const retryable = isRetryableInternalStatus(response.statusCode);
      await response.body.text();
      if (!retryable || attempt === INTERNAL_MAX_ATTEMPTS) {
        logger.warn("[owner-collection] ActivityPods returned unexpected status", {
          label: input.label,
          identifier: input.identifier,
          status: response.statusCode,
        });
        return null;
      }
    } catch (error: unknown) {
      if (attempt === INTERNAL_MAX_ATTEMPTS) {
        logger.warn("[owner-collection] ActivityPods request failed", {
          label: input.label,
          identifier: input.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    await wait(nextBackoffDelayMs(attempt));
  }

  return null;
}
