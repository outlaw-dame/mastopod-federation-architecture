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

function note(activityId: string, objectId: string, content: string, type = "Create") {
  const now = new Date().toISOString();
  if (type === "Delete") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: activityId,
      type: "Delete",
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
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    },
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    published: now,
  };
}

async function signedPost(activity: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(activity);
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
  const signatureHeader = `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`;

  const response = await fetch(SIDECAR_INBOX, {
    method: "POST",
    headers: {
      accept: "application/activity+json",
      "content-type": "application/activity+json",
      date,
      digest,
      signature: signatureHeader,
      host: target.host,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

async function runSequence() {
  const token = randomUUID();
  const objectId = `${PUBLIC_ORIGIN}/notes/${token}`;
  const createId = `${PUBLIC_ORIGIN}/activities/create-${token}`;
  const updateId = `${PUBLIC_ORIGIN}/activities/update-${token}`;
  const deleteId = `${PUBLIC_ORIGIN}/activities/delete-${token}`;
  const initialContent = `OS4b live federation ${token} initial`;
  const updatedContent = `OS4b live federation ${token} updated`;

  const create = await signedPost(note(createId, objectId, initialContent));
  if (create.status < 200 || create.status >= 300) throw new Error(`Create inbox POST failed: ${create.status} ${create.body}`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const update = await signedPost(note(updateId, objectId, updatedContent, "Update"));
  if (update.status < 200 || update.status >= 300) throw new Error(`Update inbox POST failed: ${update.status} ${update.body}`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const del = await signedPost(note(deleteId, objectId, "", "Delete"));
  if (del.status < 200 || del.status >= 300) throw new Error(`Delete inbox POST failed: ${del.status} ${del.body}`);

  return { actorId: ACTOR_ID, objectId, createId, updateId, deleteId, initialContent, updatedContent, statuses: { create: create.status, update: update.status, delete: del.status } };
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
    if (req.method === "POST" && req.url === "/send-sequence") {
      const result = await runSequence();
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
