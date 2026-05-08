import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { resolveTunnelUrl, type TunnelProvider } from "./tunnel-url.js";

interface CliOptions {
  baseUrl?: string;
  actor?: string;
  provider?: TunnelProvider;
  expectXrpc: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseArgs(argv: string[]): CliOptions {
  let baseUrl = process.env["FEDERATION_BASE_URL"] ?? process.env["PUBLIC_BASE_URL"];
  let actor = process.env["FEDERATION_SMOKE_ACTOR"];
  let provider = process.env["TUNNEL_PROVIDER"] as TunnelProvider | undefined;
  let expectXrpc = parseBool(process.env["FEDERATION_SMOKE_EXPECT_XRPC"], true);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--base-url" || arg === "-u") && next) {
      baseUrl = next;
      index += 1;
      continue;
    }

    if (arg === "--actor" && next) {
      actor = next;
      index += 1;
      continue;
    }

    if (arg === "--provider" && next) {
      provider = next === "cloudflare" ? "cloudflare" : "ngrok";
      index += 1;
      continue;
    }

    if (arg === "--expect-xrpc" && next) {
      expectXrpc = parseBool(next, true);
      index += 1;
    }
  }

  return { baseUrl, actor, provider, expectXrpc };
}

async function expectJson(url: URL, label: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("jrd+json")) {
    throw new Error(`${label} returned unexpected content-type: ${contentType || "<missing>"}`);
  }

  return response.json();
}

async function verifySubscribeRepos(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const url = new URL("/xrpc/com.atproto.sync.subscribeRepos?cursor=0", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    let opened = false;

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("subscribeRepos handshake timed out"));
    }, timeoutMs);

    ws.on("open", () => {
      opened = true;
      clearTimeout(timer);
      ws.close(1000, "smoke complete");
      resolve();
    });

    ws.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`subscribeRepos rejected with HTTP ${response.statusCode}`));
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    ws.on("close", (code, reason) => {
      if (opened) return;
      clearTimeout(timer);
      reject(new Error(`subscribeRepos closed before opening (${code} ${reason.toString()})`));
    });
  });
}

async function resolveBaseUrl(options: CliOptions): Promise<string> {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
  if (!options.provider) {
    throw new Error("FEDERATION_BASE_URL is required unless --provider or TUNNEL_PROVIDER is set");
  }

  return resolveTunnelUrl({ provider: options.provider });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = await resolveBaseUrl(options);
  const base = new URL(baseUrl);

  console.log("=".repeat(60));
  console.log(" Public Federation Smoke Test");
  console.log("=".repeat(60));
  console.log(` Base URL:     ${baseUrl}`);
  console.log(` Host:         ${base.host}`);
  console.log(` Actor check:  ${options.actor ?? "<skipped>"}`);
  console.log(` XRPC check:   ${options.expectXrpc ? "enabled" : "skipped"}`);
  console.log("=".repeat(60));
  console.log();

  await expectJson(new URL("/health", base), "GET /health");
  console.log("[smoke] /health ok");

  await expectJson(new URL("/ready", base), "GET /ready");
  console.log("[smoke] /ready ok");

  const nodeInfoLinks = await expectJson(
    new URL("/.well-known/nodeinfo", base),
    "GET /.well-known/nodeinfo",
  ) as Record<string, unknown>;
  if (!Array.isArray(nodeInfoLinks["links"])) {
    throw new Error("NodeInfo discovery response is missing links[]");
  }
  console.log("[smoke] /.well-known/nodeinfo ok");

  const nodeInfo = await expectJson(new URL("/nodeinfo/2.1", base), "GET /nodeinfo/2.1") as Record<string, unknown>;
  if (nodeInfo["version"] !== "2.1") {
    throw new Error(`Unexpected NodeInfo version: ${String(nodeInfo["version"] ?? "<missing>")}`);
  }
  console.log("[smoke] /nodeinfo/2.1 ok");

  if (options.actor) {
    const actorPayload = await expectJson(
      new URL(`/users/${encodeURIComponent(options.actor)}`, base),
      `GET /users/${options.actor}`,
      {
        headers: {
          accept: "application/activity+json, application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"",
        },
      },
    ) as Record<string, unknown>;
    const actorId = String(actorPayload["id"] ?? "");
    if (!actorId.startsWith(baseUrl)) {
      throw new Error(`Actor document id does not use tunnel origin: ${actorId || "<missing>"}`);
    }
    console.log(`[smoke] /users/${options.actor} ok`);

    const webfinger = await expectJson(
      new URL(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${options.actor}@${base.host}`)}`, base),
      "GET /.well-known/webfinger",
      { headers: { accept: "application/jrd+json, application/json" } },
    ) as Record<string, unknown>;
    const links = Array.isArray(webfinger["links"]) ? webfinger["links"] as Array<Record<string, unknown>> : [];
    const selfLink = links.find((link) => link["rel"] === "self" && typeof link["href"] === "string");
    if (!selfLink || !String(selfLink["href"]).startsWith(baseUrl)) {
      throw new Error("WebFinger self link does not point at the tunnel origin");
    }
    console.log("[smoke] /.well-known/webfinger ok");
  }

  if (options.expectXrpc) {
    await verifySubscribeRepos(baseUrl);
    console.log("[smoke] subscribeRepos websocket ok");
  }

  console.log();
  console.log("[smoke] SUCCESS — public federation surface is reachable");
}

const isMain = process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error("[smoke] failed", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}