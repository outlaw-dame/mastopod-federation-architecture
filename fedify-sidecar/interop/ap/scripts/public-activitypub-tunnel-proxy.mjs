import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const BIND_HOST = process.env.AP_PUBLIC_PROXY_HOST || "127.0.0.1";
const BIND_PORT = parsePort(process.env.AP_PUBLIC_PROXY_PORT || "18002", "AP_PUBLIC_PROXY_PORT");
const AUTHORITY = requireAuthority(process.env.AP_PUBLIC_PROXY_AUTHORITY);
const DOCUMENT_TARGET_HOST = requirePrivateTarget(
  process.env.AP_PUBLIC_PROXY_DOCUMENT_TARGET_HOST || process.env.AP_PUBLIC_PROXY_TARGET_HOST,
);
const DOCUMENT_TARGET_PORT = parsePort(
  process.env.AP_PUBLIC_PROXY_DOCUMENT_TARGET_PORT || process.env.AP_PUBLIC_PROXY_TARGET_PORT || "3000",
  "AP_PUBLIC_PROXY_DOCUMENT_TARGET_PORT",
);
const STATIC_INBOX_TARGET_HOST = requirePrivateTarget(
  process.env.AP_PUBLIC_PROXY_INBOX_TARGET_HOST || process.env.AP_PUBLIC_PROXY_TARGET_HOST,
);
const STATIC_INBOX_TARGET_PORT = parsePort(
  process.env.AP_PUBLIC_PROXY_INBOX_TARGET_PORT || process.env.AP_PUBLIC_PROXY_TARGET_PORT || "3000",
  "AP_PUBLIC_PROXY_INBOX_TARGET_PORT",
);
const INBOX_MODE_FILE = optionalAbsolutePath(process.env.AP_PUBLIC_PROXY_INBOX_MODE_FILE);
const NATIVE_INBOX_TARGET = INBOX_MODE_FILE ? {
  host: requirePrivateTarget(process.env.AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_HOST),
  port: parsePort(process.env.AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_PORT || "", "AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_PORT"),
} : null;
const EXTERNAL_INBOX_TARGET = INBOX_MODE_FILE ? {
  host: requirePrivateTarget(process.env.AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_HOST),
  port: parsePort(process.env.AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_PORT || "", "AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_PORT"),
} : null;
const MAX_REQUEST_BYTES = parsePositiveInteger(process.env.AP_PUBLIC_PROXY_MAX_REQUEST_BYTES || "2097152", "AP_PUBLIC_PROXY_MAX_REQUEST_BYTES");
const MAX_RESPONSE_BYTES = parsePositiveInteger(process.env.AP_PUBLIC_PROXY_MAX_RESPONSE_BYTES || "4194304", "AP_PUBLIC_PROXY_MAX_RESPONSE_BYTES");

const ACTOR_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._~-]{0,127}";
const ACTOR_PATH = new RegExp(`^/${ACTOR_SEGMENT}/?$`);
const KEY_PATH = new RegExp(`^/${ACTOR_SEGMENT}/keys/main/?$`);
const INBOX_PATH = new RegExp(`^/(?:users/)?${ACTOR_SEGMENT}/inbox/?$`);
const ACTIVITY_CONTENT_TYPE = /^(application\/(?:activity\+json|json)|application\/ld\+json)(?:\s*;|$)/i;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "content-type",
  "date",
  "digest",
  "signature",
  "user-agent",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "link",
  "vary",
]);

export function classifyPublicActivityPubRequest(method, rawUrl) {
  const url = new URL(rawUrl, `https://${AUTHORITY}`);
  if ((method === "GET" || method === "HEAD") && (ACTOR_PATH.test(url.pathname) || KEY_PATH.test(url.pathname))) {
    return { allowed: true, kind: KEY_PATH.test(url.pathname) ? "key" : "actor", url };
  }
  if ((method === "GET" || method === "HEAD") && url.pathname === "/.well-known/webfinger") {
    if ([...url.searchParams.keys()].some(key => key !== "resource")) return { allowed: false };
    const resource = url.searchParams.get("resource") || "";
    const allowedResource = resource.startsWith(`acct:`) && resource.endsWith(`@${AUTHORITY}`)
      || resource.startsWith(`https://${AUTHORITY}/`);
    return allowedResource ? { allowed: true, kind: "webfinger", url } : { allowed: false };
  }
  if (method === "POST" && INBOX_PATH.test(url.pathname) && url.search === "") {
    return { allowed: true, kind: "inbox", url };
  }
  return { allowed: false };
}

const server = createServer(async (incoming, outgoing) => {
  const startedAt = Date.now();
  const incomingHost = normalizeHost(incoming.headers.host);
  if (incomingHost !== AUTHORITY) {
    sendJson(outgoing, 421, { error: "Misdirected Request" });
    return;
  }

  const method = incoming.method || "";
  if ((method === "GET" || method === "HEAD") && incoming.url === "/.well-known/ap-proof-health") {
    outgoing.writeHead(204, {
      "cache-control": "no-store",
      "content-length": "0",
    });
    outgoing.end();
    return;
  }
  const classification = classifyPublicActivityPubRequest(method, incoming.url || "/");
  if (!classification.allowed) {
    sendJson(outgoing, 404, { error: "Not Found" });
    return;
  }

  if (classification.kind === "inbox") {
    const contentType = String(incoming.headers["content-type"] || "");
    if (!ACTIVITY_CONTENT_TYPE.test(contentType)) {
      sendJson(outgoing, 415, { error: "Unsupported Media Type" });
      return;
    }
  }

  let body;
  try {
    body = await readBoundedBody(incoming, MAX_REQUEST_BYTES);
  } catch (error) {
    sendJson(outgoing, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
      error: error?.code === "BODY_TOO_LARGE" ? "Payload Too Large" : "Bad Request",
    });
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (REQUEST_HEADER_ALLOWLIST.has(name) && value !== undefined) headers[name] = value;
  }
  headers.host = AUTHORITY;
  headers["x-forwarded-host"] = AUTHORITY;
  headers["x-forwarded-proto"] = "https";
  headers["content-length"] = String(body.length);

  const inboxRequest = classification.kind === "inbox";
  let inboxRoute = null;
  if (inboxRequest) {
    try {
      inboxRoute = await resolveInboxRoute();
    } catch {
      sendJson(outgoing, 503, { error: "Inbox Route Unavailable" });
      return;
    }
  }
  const upstream = httpRequest({
    hostname: inboxRequest ? inboxRoute.host : DOCUMENT_TARGET_HOST,
    port: inboxRequest ? inboxRoute.port : DOCUMENT_TARGET_PORT,
    method,
    path: `${classification.url.pathname}${classification.url.search}`,
    headers,
  });

  upstream.on("response", async response => {
    if ((response.statusCode || 502) >= 300 && (response.statusCode || 502) < 400) {
      response.resume();
      sendJson(outgoing, 502, { error: "Upstream redirect rejected" });
      return;
    }
    let responseBody;
    try {
      responseBody = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    } catch {
      response.destroy();
      sendJson(outgoing, 502, { error: "Upstream response rejected" });
      return;
    }
    const responseHeaders = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (RESPONSE_HEADER_ALLOWLIST.has(name) && value !== undefined) responseHeaders[name] = value;
    }
    responseHeaders["content-length"] = String(method === "HEAD" ? 0 : responseBody.length);
    outgoing.writeHead(response.statusCode || 502, responseHeaders);
    outgoing.end(method === "HEAD" ? undefined : responseBody);
    process.stdout.write(`${JSON.stringify({
      schema: "activitypods.activitypub.public-tunnel-receipt.v1",
      method,
      path: classification.url.pathname,
      kind: classification.kind,
      inboxRouteMode: inboxRoute?.mode ?? null,
      requestBytes: body.length,
      requestSha256: createHash("sha256").update(body).digest("hex"),
      responseStatus: response.statusCode || 502,
      responseBytes: responseBody.length,
      durationMs: Date.now() - startedAt,
    })}\n`);
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) sendJson(outgoing, 502, { error: "Bad Gateway" });
    else outgoing.destroy();
  });
  if (body.length > 0) upstream.write(body);
  upstream.end();
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(BIND_PORT, BIND_HOST, () => {
  process.stderr.write(`[public-activitypub-tunnel-proxy] listening on ${BIND_HOST}:${BIND_PORT}\n`);
});

function normalizeHost(value) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/:443$/, "");
}

function requireAuthority(value) {
  const authority = normalizeHost(value);
  if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(authority)) {
    throw new Error("AP_PUBLIC_PROXY_AUTHORITY must be one trycloudflare.com hostname");
  }
  return authority;
}

function requirePrivateTarget(value) {
  const host = String(value || "");
  if (!/^(127\.0\.0\.1|10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})$/.test(host)) {
    throw new Error("AP_PUBLIC_PROXY_TARGET_HOST must be an explicit loopback or RFC1918 address");
  }
  return host;
}

function optionalAbsolutePath(value) {
  if (value === undefined || value === "") return null;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error("AP_PUBLIC_PROXY_INBOX_MODE_FILE must be an absolute path");
  }
  return value;
}

async function resolveInboxRoute() {
  if (!INBOX_MODE_FILE) {
    return { host: STATIC_INBOX_TARGET_HOST, port: STATIC_INBOX_TARGET_PORT, mode: "static" };
  }
  const mode = (await readFile(INBOX_MODE_FILE, { encoding: "utf8" })).trim();
  if (mode === "native") return { ...NATIVE_INBOX_TARGET, mode };
  if (mode === "external") return { ...EXTERNAL_INBOX_TARGET, mode };
  throw new Error("public inbox route mode must be native or external");
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid port`);
  return port;
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function readBoundedBody(stream, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    stream.on("data", chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        const error = new Error("body exceeds limit");
        error.code = "BODY_TOO_LARGE";
        settled = true;
        chunks.length = 0;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    stream.on("error", error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
}
