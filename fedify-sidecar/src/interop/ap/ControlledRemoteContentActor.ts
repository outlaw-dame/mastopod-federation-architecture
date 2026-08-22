import http from "node:http";
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";

const HOST = process.env["REMOTE_CONTENT_HOST"] ?? "0.0.0.0";
const PORT = Number.parseInt(process.env["REMOTE_CONTENT_PORT"] ?? "8890", 10);
const PUBLIC_ORIGIN = process.env["REMOTE_CONTENT_PUBLIC_ORIGIN"] ?? "https://remote-content";
const SIDECAR_INBOX = process.env["REMOTE_CONTENT_SIDECAR_INBOX"] ?? "https://sidecar/inbox";
const ACTOR_ID = `${PUBLIC_ORIGIN}/users/remote`;
const KEY_ID = `${ACTOR_ID}#main-key`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

type FixtureState = {
  token: string;
  objectId: string;
  createId: string;
  updateId: string;
  deleteId: string;
  initialContent: string;
  updatedContent: string;
};
let fixture: FixtureState | null = null;

function actorDocument() {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: ACTOR_ID,
    type: "Person",
    preferredUsername: "remote",
    inbox: `${ACTOR_ID}/inbox`,
    outbox: `${ACTOR_ID}/outbox`,
    publicKey: { id: KEY_ID, owner: ACTOR_ID, publicKeyPem },
  };
}

function activity(activityId: string, objectId: string, content: string, type: "Create" | "Update" | "Delete") {
  const now = new Date().toISOString();
  if (type === "Delete") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: activityId,
      type,
      actor: ACTOR_ID,
      object: { id: objectId, type: "Tombstone" },
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      published: now,
    };
  }
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: activityId,
    type,
    actor: ACTOR_ID,
    object: {
      id: objectId,
      type: "Note",
      attributedTo: ACTOR_ID,
      content,
      published: now,
      updated: type === "Update" ? now : undefined,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    },
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    published: now,
  };
}

async function signedPost(payload: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(payload);
  const target = new URL(SIDECAR_INBOX);
  const date = new Date().toUTCString();
  const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  const signingString = [
    `(request-target): post ${target.pathname}${target.search}`,
    `host: ${target.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const signer = createSign("RSA-SHA256");
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(privateKey, "base64");
  const response = await fetch(SIDECAR_INBOX, {
    method: "POST",
    headers: {
      accept: "application/activity+json",
      "content-type": "application/activity+json",
      date,
      digest,
      signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
      host: target.host,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Inbox POST failed: ${response.status} ${await response.text()}`);
  }
  return response.status;
}

function ensureFixture(): FixtureState {
  if (fixture) return fixture;
  const token = randomUUID();
  fixture = {
    token,
    objectId: `${PUBLIC_ORIGIN}/notes/${token}`,
    createId: `${PUBLIC_ORIGIN}/activities/create-${token}`,
    updateId: `${PUBLIC_ORIGIN}/activities/update-${token}`,
    deleteId: `${PUBLIC_ORIGIN}/activities/delete-${token}`,
    initialContent: `OS4b live federation ${token} initial`,
    updatedContent: `OS4b live federation ${token} updated`,
  };
  return fixture;
}

async function sendStage(stage: "create" | "update" | "delete") {
  const f = ensureFixture();
  const payload = stage === "create"
    ? activity(f.createId, f.objectId, f.initialContent, "Create")
    : stage === "update"
      ? activity(f.updateId, f.objectId, f.updatedContent, "Update")
      : activity(f.deleteId, f.objectId, "", "Delete");
  const status = await signedPost(payload);
  return { ...f, actorId: ACTOR_ID, stage, status };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/users/remote") {
      res.writeHead(200, { "content-type": "application/activity+json" });
      res.end(JSON.stringify(actorDocument()));
      return;
    }
    if (req.method === "GET" && req.url === "/fixture") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...ensureFixture(), actorId: ACTOR_ID }));
      return;
    }
    const match = req.method === "POST" ? /^\/send\/(create|update|delete)$/.exec(req.url ?? "") : null;
    if (match) {
      const result = await sendStage(match[1] as "create" | "update" | "delete");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, listening: `${HOST}:${PORT}`, actorId: ACTOR_ID }));
});
