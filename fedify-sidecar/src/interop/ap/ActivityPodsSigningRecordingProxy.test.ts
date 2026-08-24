import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForProxy(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`recording proxy exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { method: "OPTIONS" });
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  }
  throw new Error("recording proxy did not become ready");
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => undefined);
    }
  }
  children.clear();
});

describe("ActivityPods signing recording proxy", () => {
  it("preserves the upstream status, headers, and body while recording a redacted signing call", async () => {
    const observedPaths: string[] = [];
    const upstream = createServer((req, res) => {
      if (req.url === "/ready") {
        res.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        observedPaths.push(req.url ?? "");
        expect(req.headers.authorization).toBe("Bearer super-secret-token");
        if (req.url === "/api/internal/activitypub-bridge/inbox/receive") {
          expect(Buffer.concat(chunks).toString("utf8")).toContain('"type":"Accept"');
          res.writeHead(202, { "x-inbox-upstream": "preserved" }).end();
          return;
        }
        expect(Buffer.concat(chunks).toString("utf8")).toContain("requests");
        const responseBody = JSON.stringify({ results: [{ requestId: "request-1", ok: true }] });
        res.writeHead(207, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(responseBody),
          "x-signing-upstream": "preserved"
        });
        res.end(responseBody);
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream did not bind");

    const proxyPort = await unusedPort();
    const evidenceDirectory = await mkdtemp(join(tmpdir(), "activitypods-signing-proxy-"));
    const evidencePath = join(evidenceDirectory, "signing-api.jsonl");
    const proxyScript = resolve(process.cwd(), "interop/ap/scripts/activitypods-signing-recording-proxy.mjs");
    const child = spawn(process.execPath, [proxyScript], {
      env: {
        ...process.env,
        AP_SIGNING_PROXY_HOST: "127.0.0.1",
        AP_SIGNING_PROXY_PORT: String(proxyPort),
        AP_SIGNING_PROXY_TARGET_HOST: "127.0.0.1",
        AP_SIGNING_PROXY_TARGET_PORT: String(upstreamAddress.port),
        AP_SIGNING_PROXY_EVIDENCE_PATH: evidencePath
      },
      stdio: "ignore"
    });
    children.add(child);

    try {
      await waitForProxy(proxyPort, child);
      const unrelatedResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/internal/other`, {
        method: "POST",
        body: "{}"
      });
      expect(unrelatedResponse.status).toBe(404);
      const inboundResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/internal/activitypub-bridge/inbox/receive`, {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ type: "Accept" })
      });
      expect(inboundResponse.status).toBe(202);
      expect(inboundResponse.headers.get("x-inbox-upstream")).toBe("preserved");
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/internal/signatures/batch`, {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret-token",
          cookie: "session=also-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify({ requests: [{ requestId: "request-1" }] })
      });
      expect(response.status).toBe(207);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("content-length")).toBeTruthy();
      expect(response.headers.get("x-signing-upstream")).toBe("preserved");
      await expect(response.json()).resolves.toEqual({ results: [{ requestId: "request-1", ok: true }] });

      let evidence = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        evidence = await readFile(evidencePath, "utf8").catch(() => "");
        if (evidence.trim()) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      const record = JSON.parse(evidence.trim());
      expect(record).toMatchObject({
        schema: "ap.real-signing-api-call.v1",
        method: "POST",
        path: "/api/internal/signatures/batch",
        responseStatus: 207,
        requestHeaders: { authorization: "<redacted>", cookie: "<redacted>" },
        response: { results: [{ requestId: "request-1", ok: true }] }
      });
      expect(observedPaths).toEqual([
        "/api/internal/activitypub-bridge/inbox/receive",
        "/api/internal/signatures/batch",
      ]);
    } finally {
      await new Promise<void>(resolveClose => upstream.close(() => resolveClose()));
    }
  });
});
