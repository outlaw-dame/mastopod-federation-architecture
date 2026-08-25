import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("path-restricted public ActivityPub tunnel proxy", () => {
  it("exposes only bounded actor, key, WebFinger, and inbox traffic", async () => {
    const upstreamRequests: Array<{ method?: string; url?: string; host?: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        upstreamRequests.push({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const body = Buffer.from('{"ok":true}');
        response.writeHead(200, {
          "content-type": "application/activity+json",
          "content-length": String(body.length),
          "set-cookie": "must-not-cross-the-public-proxy=1",
        });
        response.end(body);
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const reserved = createServer();
    const proxyPort = await listen(reserved);
    await new Promise<void>(done => reserved.close(() => done()));

    const authority = "bounded-proof.trycloudflare.com";
    let proxyEvidence = "";
    const child = spawn(process.execPath, [resolve("interop/ap/scripts/public-activitypub-tunnel-proxy.mjs")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AP_PUBLIC_PROXY_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_PORT: String(proxyPort),
        AP_PUBLIC_PROXY_AUTHORITY: authority,
        AP_PUBLIC_PROXY_TARGET_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_TARGET_PORT: String(upstreamPort),
        AP_PUBLIC_PROXY_MAX_REQUEST_BYTES: "64",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", chunk => { proxyEvidence += String(chunk); });
    await waitForListening(child);

    const health = await send(proxyPort, authority, "GET", "/.well-known/ap-proof-health");
    expect(health.status).toBe(204);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(upstreamRequests).toHaveLength(0);

    const actor = await send(proxyPort, authority, "GET", "/alice");
    expect(actor.status).toBe(200);
    expect(actor.headers["set-cookie"]).toBeUndefined();
    expect(upstreamRequests.at(-1)).toMatchObject({ method: "GET", url: "/alice", host: authority });

    const beforeBlocked = upstreamRequests.length;
    expect((await send(proxyPort, authority, "GET", "/api/internal/signatures/batch")).status).toBe(404);
    expect((await send(proxyPort, "attacker.example", "GET", "/alice")).status).toBe(421);
    expect((await send(proxyPort, authority, "GET", `/.well-known/webfinger?resource=acct:alice@attacker.example`)).status).toBe(404);
    expect((await send(proxyPort, authority, "POST", "/alice/inbox", "{}", "text/plain")).status).toBe(415);
    expect((await send(proxyPort, authority, "POST", "/alice/inbox", "x".repeat(65), "application/activity+json")).status).toBe(413);
    expect(upstreamRequests).toHaveLength(beforeBlocked);

    const activity = '{"type":"Accept","actor":"https://remote.example/alice"}';
    const inbox = await send(proxyPort, authority, "POST", "/alice/inbox", activity, "application/activity+json", {
      signature: "sensitive-signature-value",
    });
    expect(inbox.status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({ method: "POST", url: "/alice/inbox", host: authority, body: activity });
    expect(proxyEvidence).not.toContain("sensitive-signature-value");
    expect(proxyEvidence).not.toContain(activity);
  });

  it("switches inbox authority exactly once through a fail-closed mode file", async () => {
    const receipts: string[] = [];
    const makeUpstream = (name: string) => createServer((_request, response) => {
      receipts.push(name);
      response.writeHead(202, { "content-length": "0" }).end();
    });
    const native = makeUpstream("native");
    const external = makeUpstream("external");
    servers.push(native, external);
    const nativePort = await listen(native);
    const externalPort = await listen(external);

    const reserved = createServer();
    const proxyPort = await listen(reserved);
    await new Promise<void>(done => reserved.close(() => done()));
    const directory = mkdtempSync(join(tmpdir(), "public-ap-route-"));
    directories.push(directory);
    const modeFile = join(directory, "mode");
    writeFileSync(modeFile, "native\n");

    const authority = "bounded-switch.trycloudflare.com";
    const child = spawn(process.execPath, [resolve("interop/ap/scripts/public-activitypub-tunnel-proxy.mjs")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AP_PUBLIC_PROXY_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_PORT: String(proxyPort),
        AP_PUBLIC_PROXY_AUTHORITY: authority,
        AP_PUBLIC_PROXY_TARGET_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_TARGET_PORT: String(nativePort),
        AP_PUBLIC_PROXY_INBOX_MODE_FILE: modeFile,
        AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_PORT: String(nativePort),
        AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_HOST: "127.0.0.1",
        AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_PORT: String(externalPort),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    await waitForListening(child);

    expect((await send(proxyPort, authority, "POST", "/alice/inbox", "{}", "application/activity+json")).status).toBe(202);
    writeFileSync(modeFile, "external\n");
    expect((await send(proxyPort, authority, "POST", "/alice/inbox", "{}", "application/activity+json")).status).toBe(202);
    writeFileSync(modeFile, "unexpected\n");
    expect((await send(proxyPort, authority, "POST", "/alice/inbox", "{}", "application/activity+json")).status).toBe(503);
    expect(receipts).toEqual(["native", "external"]);
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server did not bind an IP port"));
      else resolvePort(address.port);
    });
  });
}

function waitForListening(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("proxy did not start")), 5_000);
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`proxy exited before readiness: ${code}`));
    });
    child.stderr.on("data", chunk => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
}

function send(
  port: number,
  host: string,
  method: string,
  path: string,
  body = "",
  contentType?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        host,
        ...(contentType ? { "content-type": contentType } : {}),
        "content-length": String(Buffer.byteLength(body)),
        ...extraHeaders,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}
