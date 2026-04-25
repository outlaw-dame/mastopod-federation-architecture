import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";

const HOST = process.env["MOCK_ACTIVITYPODS_HOST"] || "0.0.0.0";
const PORT = Number.parseInt(process.env["MOCK_ACTIVITYPODS_PORT"] || "8793", 10);
const TOKEN = process.env["MOCK_ACTIVITYPODS_TOKEN"] || "interop-activitypods-token";
const LOCAL_DOMAIN = process.env["MOCK_ACTIVITYPODS_LOCAL_DOMAIN"] || "sidecar";
const KEY_DIR = process.env["MOCK_ACTIVITYPODS_KEY_DIR"] || "/runtime/mock-authority";
const DEFAULT_ACTOR_IDENTIFIER = process.env["MOCK_ACTIVITYPODS_DEFAULT_ACTOR"] || "alice";
const DEFAULT_ACTOR_NAME = process.env["MOCK_ACTIVITYPODS_DEFAULT_ACTOR_NAME"] || "Alice Interop";
const ACTOR_IDENTIFIER_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

type SigningRequestItem = {
  requestId?: unknown;
  actorUri?: unknown;
  method?: unknown;
  profile?: unknown;
  target?: {
    host?: unknown;
    path?: unknown;
    query?: unknown;
  };
  body?: {
    bytes?: unknown;
    encoding?: unknown;
  };
  digest?: {
    mode?: unknown;
  };
};

type MockInboxReceipt = {
  targetInbox?: unknown;
  activity?: unknown;
  verifiedActorUri?: unknown;
  receivedAt?: unknown;
  remoteIp?: unknown;
};

async function main(): Promise<void> {
  const keyPair = await loadOrCreateSigningKeyPair(KEY_DIR);
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/internal/actors/:identifier", async (request, reply) => {
    if (!authenticate(request.headers.authorization)) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const identifier = (request.params as { identifier: string }).identifier;
    if (!ACTOR_IDENTIFIER_PATTERN.test(identifier)) {
      reply.status(404).send({ error: "Actor not found" });
      return;
    }

    reply.send({
      id: buildActorUri(identifier),
      name: identifier === DEFAULT_ACTOR_IDENTIFIER
        ? DEFAULT_ACTOR_NAME
        : `${DEFAULT_ACTOR_NAME} (${identifier})`,
      url: buildActorUri(identifier),
      publicKeyPem: keyPair.publicKeyPem,
      publicKey: {
        id: `${buildActorUri(identifier)}#main-key`,
        owner: buildActorUri(identifier),
        publicKeyPem: keyPair.publicKeyPem,
      },
    });
  });

  app.post("/api/internal/signatures/batch", async (request, reply) => {
    if (!authenticate(request.headers.authorization)) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const body = request.body as { requests?: unknown };
    if (!Array.isArray(body?.requests) || body.requests.length === 0) {
      reply.status(400).send({
        results: [
          {
            requestId: null,
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: "requests must be a non-empty array",
              retryable: false,
            },
          },
        ],
      });
      return;
    }

    const results = body.requests.map((item) => signOne(item as SigningRequestItem, keyPair.privateKeyPem));
    reply.send({ results });
  });

  app.post("/api/internal/inbox/receive", async (request, reply) => {
    if (!authenticate(request.headers.authorization)) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const body = (request.body ?? {}) as MockInboxReceipt;
    if (
      typeof body.targetInbox !== "string" ||
      body.targetInbox.length === 0 ||
      !body.activity ||
      typeof body.activity !== "object" ||
      Array.isArray(body.activity) ||
      typeof body.verifiedActorUri !== "string" ||
      body.verifiedActorUri.length === 0
    ) {
      reply.status(400).send({ error: "Invalid inbox receipt" });
      return;
    }

    reply.status(202).send({
      accepted: true,
      targetInbox: body.targetInbox,
      verifiedActorUri: body.verifiedActorUri,
    });
  });

  await app.listen({ host: HOST, port: PORT });
  console.log(`[mock-activitypods-authority] listening on http://${HOST}:${PORT}`);
}

function authenticate(authorization: string | undefined): boolean {
  return authorization === `Bearer ${TOKEN}`;
}

function signOne(item: SigningRequestItem, privateKeyPem: string) {
  if (typeof item.requestId !== "string" || item.requestId.length === 0) {
    return failureResult(item.requestId, "INVALID_REQUEST", "requestId is required", false);
  }
  if (typeof item.actorUri !== "string" || item.actorUri.length === 0) {
    return failureResult(item.requestId, "INVALID_REQUEST", "actorUri is required", false);
  }
  if (!isLocalActor(item.actorUri)) {
    return failureResult(item.requestId, "ACTOR_NOT_LOCAL", "actorUri is not local to this harness", false);
  }
  if (typeof item.method !== "string" || (item.method !== "GET" && item.method !== "POST")) {
    return failureResult(item.requestId, "INVALID_REQUEST", "method must be GET or POST", false);
  }
  if (typeof item.profile !== "string" || !["ap_get_v1", "ap_post_v1", "ap_post_v1_ct"].includes(item.profile)) {
    return failureResult(item.requestId, "INVALID_REQUEST", "unsupported profile", false);
  }
  if (!item.target || typeof item.target !== "object") {
    return failureResult(item.requestId, "INVALID_REQUEST", "target is required", false);
  }
  if (typeof item.target.host !== "string" || typeof item.target.path !== "string") {
    return failureResult(item.requestId, "INVALID_REQUEST", "target.host and target.path are required", false);
  }

  const dateHeader = new Date().toUTCString();
  const bodyBytes =
    item.body && typeof item.body === "object" && typeof item.body.bytes === "string"
      ? item.body.bytes
      : "";
  const digestHeader =
    item.method === "POST" || item.profile !== "ap_get_v1"
      ? `SHA-256=${createHash("sha256").update(bodyBytes, "utf8").digest("base64")}`
      : undefined;

  const signedHeaders = buildSignedHeaders(item.profile);
  const signingString = buildSigningString({
    method: item.method,
    host: item.target.host,
    path: item.target.path,
    query: typeof item.target.query === "string" ? item.target.query : "",
    date: dateHeader,
    digest: digestHeader,
  }, signedHeaders);

  const signature = sign("RSA-SHA256", Buffer.from(signingString, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
  const signatureHeader =
    `keyId="${item.actorUri}#main-key",`
    + `algorithm="rsa-sha256",`
    + `headers="${signedHeaders.join(" ")}",`
    + `signature="${signature}"`;

  return {
    requestId: item.requestId,
    ok: true,
    outHeaders: {
      Date: dateHeader,
      Signature: signatureHeader,
      ...(digestHeader ? { Digest: digestHeader } : {}),
    },
    meta: {
      keyId: `${item.actorUri}#main-key`,
      algorithm: "rsa-sha256",
      signedHeaders: signedHeaders.join(" "),
      ...(digestHeader
        ? { bodySha256Base64: digestHeader.replace(/^SHA-256=/, "") }
        : {}),
    },
  };
}

function buildSignedHeaders(profile: string): string[] {
  if (profile === "ap_get_v1") {
    return ["(request-target)", "host", "date"];
  }
  if (profile === "ap_post_v1_ct") {
    return ["(request-target)", "host", "date", "digest", "content-type"];
  }
  return ["(request-target)", "host", "date", "digest"];
}

function buildSigningString(
  request: {
    method: string;
    host: string;
    path: string;
    query: string;
    date: string;
    digest?: string;
  },
  signedHeaders: string[],
): string {
  return signedHeaders.map((header) => {
    switch (header) {
      case "(request-target)":
        return `(request-target): ${request.method.toLowerCase()} ${request.path}${request.query}`;
      case "host":
        return `host: ${request.host}`;
      case "date":
        return `date: ${request.date}`;
      case "digest":
        return `digest: ${request.digest ?? ""}`;
      case "content-type":
        return "content-type: application/activity+json";
      default:
        throw new Error(`Unsupported signed header ${header}`);
    }
  }).join("\n");
}

function failureResult(requestId: unknown, code: string, message: string, retryable: boolean) {
  return {
    requestId: typeof requestId === "string" ? requestId : null,
    ok: false,
    error: {
      code,
      message,
      retryable,
    },
  };
}

function isLocalActor(actorUri: string): boolean {
  try {
    const parsed = new URL(actorUri);
    const identifier = parsed.pathname.replace(/^\/users\//, "");
    return (
      parsed.protocol === "https:" &&
      parsed.host === LOCAL_DOMAIN &&
      parsed.pathname === `/users/${identifier}` &&
      ACTOR_IDENTIFIER_PATTERN.test(identifier)
    );
  } catch {
    return false;
  }
}

function buildActorUri(identifier: string): string {
  return `https://${LOCAL_DOMAIN}/users/${identifier}`;
}

async function loadOrCreateSigningKeyPair(keyDir: string): Promise<{
  privateKeyPem: string;
  publicKeyPem: string;
}> {
  const privateKeyPath = join(keyDir, "activitypub-private-key.pem");
  const publicKeyPath = join(keyDir, "activitypub-public-key.pem");
  await mkdir(keyDir, { recursive: true });

  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      readFile(privateKeyPath, "utf8"),
      readFile(publicKeyPath, "utf8"),
    ]);
    return { privateKeyPem, publicKeyPem };
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    await Promise.all([
      writeFile(privateKeyPath, privateKey, { mode: 0o600 }),
      writeFile(publicKeyPath, publicKey, { mode: 0o644 }),
    ]);

    return {
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
    };
  }
}

main().catch((error) => {
  console.error(
    "[mock-activitypods-authority] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
