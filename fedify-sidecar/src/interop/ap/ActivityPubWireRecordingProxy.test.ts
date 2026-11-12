import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const processes: ChildProcess[] = [];
const servers: Server[] = [];
const script = resolve("interop/ap/scripts/activitypub-wire-recording-proxy.mjs");

async function listen(server: Server): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing server address"));
      resolvePort(address.port);
    });
  });
}

async function startRecorder(upstreamPort: number, evidencePath: string): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AP_WIRE_RECORDER_HOST: "127.0.0.1",
      AP_WIRE_RECORDER_PORT: String(port),
      AP_WIRE_RECORDER_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      AP_WIRE_RECORDER_EVIDENCE_PATH: evidencePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);

  await new Promise<void>((resolveReady, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`wire recorder start timeout: ${stderr}`)), 5_000);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wire recorder exited before ready: ${code} ${stderr}`));
    });
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("ap.interop.wire-recorder.ready.v1")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });

  return port;
}

async function postWithExactHost(port: number, body: string): Promise<number> {
  return await new Promise((resolveStatus, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/inbox",
      method: "POST",
      headers: {
        host: "mastodon",
        "content-type": "application/activity+json",
        date: "Sun, 23 Aug 2026 12:00:00 GMT",
        digest: "SHA-256=proof-digest",
        signature: 'keyId="https://activitypods/users/alice/keys/main",headers="(request-target) host date digest",signature="wire-proof"',
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end(body);
  });
}

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGTERM");
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ActivityPub wire recording proxy", () => {
  it("forwards the exact signed Follow while retaining only bounded correlation evidence", async () => {
    let received: { host?: string; signature?: string; digest?: string; body?: string } = {};
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        received = {
          host: req.headers.host,
          signature: req.headers["signature"] as string | undefined,
          digest: req.headers["digest"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(202, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const directory = mkdtempSync(join(tmpdir(), "ap-wire-recorder-"));
    directories.push(directory);
    const evidencePath = join(directory, "wire.jsonl");
    const proxyPort = await startRecorder(upstreamPort, evidencePath);

    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://activitypods/activities/follow-1",
      type: "Follow",
      actor: "https://activitypods/users/alice",
      object: "https://mastodon/users/bob",
    };
    const body = JSON.stringify(activity);
    const status = await postWithExactHost(proxyPort, body);

    expect(status).toBe(202);
    expect(received).toMatchObject({
      host: "mastodon",
      digest: "SHA-256=proof-digest",
      body,
    });
    expect(received.signature).toContain("/keys/main");

    const rows = readFileSync(evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      schema: "ap.interop.wire-request.v1",
      method: "POST",
      path: "/inbox",
      host: "mastodon",
      activityId: activity.id,
      activityType: "Follow",
      actorUri: activity.actor,
      objectUri: activity.object,
      bodyBytes: Buffer.byteLength(body),
    });
    expect(rows[0].signature).toContain("/keys/main");
    expect(rows[0].requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(rows[1]).toMatchObject({
      schema: "ap.interop.wire-response.v1",
      requestId: rows[0].requestId,
      activityId: activity.id,
      upstreamStatus: 202,
      cached: false,
      errorCode: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain(body);
  });
});
