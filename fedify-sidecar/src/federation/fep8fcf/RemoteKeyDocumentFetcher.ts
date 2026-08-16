import { secureActivityPubRequest } from "../../security/activitypub-egress-policy.js";

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;
const DEFAULT_MAX_KEY_ID_BYTES = 4096;
const DEFAULT_MAX_PUBLIC_KEY_PEM_BYTES = 16 * 1024;

export interface RemoteKeyDocumentFetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  maxKeyIdBytes?: number;
  maxPublicKeyPemBytes?: number;
}

export interface RemoteKeyDocumentResult {
  document: Record<string, unknown>;
  publicKeyPem: string;
  resolvedUrl: string;
}

type BoundedBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

export async function fetchRemoteKeyDocument(
  keyIdValue: string,
  options: RemoteKeyDocumentFetcherOptions,
): Promise<RemoteKeyDocumentResult | null> {
  const maxKeyIdBytes = clampInteger(options.maxKeyIdBytes, DEFAULT_MAX_KEY_ID_BYTES, 256, 16 * 1024);
  const maxResponseBytes = clampInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    64 * 1024,
    4 * 1024 * 1024,
  );
  const maxRedirects = clampInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 4);
  const maxPublicKeyPemBytes = clampInteger(
    options.maxPublicKeyPemBytes,
    DEFAULT_MAX_PUBLIC_KEY_PEM_BYTES,
    1024,
    64 * 1024,
  );

  if (
    typeof keyIdValue !== "string"
    || keyIdValue.length === 0
    || Buffer.byteLength(keyIdValue, "utf8") > maxKeyIdBytes
  ) {
    return null;
  }

  let keyId: URL;
  try {
    keyId = new URL(keyIdValue);
  } catch {
    return null;
  }
  if (
    (keyId.protocol !== "http:" && keyId.protocol !== "https:")
    || keyId.username
    || keyId.password
  ) {
    return null;
  }

  const originalOrigin = keyId.origin;
  keyId.hash = "";
  let current = keyId;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let response;
    try {
      response = await secureActivityPubRequest(current, {
        method: "GET",
        headers: {
          accept: "application/activity+json, application/ld+json",
          "user-agent": options.userAgent,
        },
        bodyTimeout: options.timeoutMs,
        headersTimeout: options.timeoutMs,
      });
    } catch {
      return null;
    }

    if (isRedirectStatus(response.statusCode)) {
      const location = headerValue(response.headers, "location");
      response.body.destroy();
      if (!location || redirectCount >= maxRedirects) return null;

      let redirected: URL;
      try {
        redirected = new URL(location, current);
      } catch {
        return null;
      }
      if (
        redirected.origin !== originalOrigin
        || redirected.username
        || redirected.password
        || redirected.hash
      ) {
        return null;
      }
      current = redirected;
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy();
      return null;
    }

    const document = await readBoundedJsonObject(
      response.body as unknown as BoundedBody,
      maxResponseBytes,
    );
    if (!document) return null;

    const publicKeyPem = extractPublicKeyPem(document, maxPublicKeyPemBytes);
    if (!publicKeyPem) return null;

    return {
      document,
      publicKeyPem,
      resolvedUrl: current.toString(),
    };
  }

  return null;
}

async function readBoundedJsonObject(
  body: BoundedBody,
  maxResponseBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxResponseBytes) {
        body.destroy?.();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    body.destroy?.();
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractPublicKeyPem(
  document: Record<string, unknown>,
  maxPublicKeyPemBytes = DEFAULT_MAX_PUBLIC_KEY_PEM_BYTES,
): string | null {
  const embedded = document["publicKey"];
  const candidate = embedded && typeof embedded === "object" && !Array.isArray(embedded)
    ? (embedded as Record<string, unknown>)["publicKeyPem"]
    : document["publicKeyPem"];

  if (typeof candidate !== "string") return null;
  const pem = candidate.trim();
  if (!pem || Buffer.byteLength(pem, "utf8") > maxPublicKeyPemBytes) return null;
  return pem;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301
    || statusCode === 302
    || statusCode === 303
    || statusCode === 307
    || statusCode === 308;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}
