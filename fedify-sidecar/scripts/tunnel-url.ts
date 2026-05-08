import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type TunnelProvider = "ngrok" | "cloudflare";

export interface ResolveTunnelUrlOptions {
  provider: TunnelProvider;
  port?: number;
  cloudflareLogFile?: string;
  timeoutMs?: number;
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOUDFLARE_LOG_FILE = ".tmp/cloudflared-fedify.log";

function parseArgs(argv: string[]): ResolveTunnelUrlOptions {
  let provider = (process.env["TUNNEL_PROVIDER"] as TunnelProvider | undefined) ?? "ngrok";
  let port = parseIntEnv(process.env["TUNNEL_PORT"], DEFAULT_PORT);
  let cloudflareLogFile =
    process.env["CLOUDFLARED_LOG_FILE"] ?? DEFAULT_CLOUDFLARE_LOG_FILE;
  let timeoutMs = parseIntEnv(process.env["TUNNEL_URL_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--provider" || arg === "-p") && next) {
      provider = next === "cloudflare" ? "cloudflare" : "ngrok";
      index += 1;
      continue;
    }

    if (arg === "--port" && next) {
      port = parseIntEnv(next, DEFAULT_PORT);
      index += 1;
      continue;
    }

    if (arg === "--cloudflare-log-file" && next) {
      cloudflareLogFile = next;
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms" && next) {
      timeoutMs = parseIntEnv(next, DEFAULT_TIMEOUT_MS);
      index += 1;
    }
  }

  return { provider, port, cloudflareLogFile, timeoutMs };
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveNgrokUrl(port: number): Promise<string | null> {
  const response = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!response.ok) {
    throw new Error(`ngrok API returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    tunnels?: Array<{
      public_url?: string;
      proto?: string;
      config?: { addr?: string };
    }>;
  };

  const tunnels = Array.isArray(payload.tunnels) ? payload.tunnels : [];
  const portCandidates = new Set([
    `${port}`,
    `:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
  ]);

  const exact = tunnels.find((tunnel) => {
    if (!tunnel.public_url?.startsWith("https://")) return false;
    const addr = String(tunnel.config?.addr ?? "");
    return Array.from(portCandidates).some((candidate) => addr === candidate || addr.endsWith(candidate));
  });

  return exact?.public_url ?? tunnels.find((tunnel) => tunnel.public_url?.startsWith("https://"))?.public_url ?? null;
}

async function resolveCloudflareUrl(cloudflareLogFile: string): Promise<string | null> {
  if (!existsSync(cloudflareLogFile)) {
    return null;
  }

  const logText = await readFile(cloudflareLogFile, "utf8");
  const match = logText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0] ?? null;
}

export async function resolveTunnelUrl(options: ResolveTunnelUrlOptions): Promise<string> {
  const provider = options.provider;
  const port = options.port ?? DEFAULT_PORT;
  const cloudflareLogFile = options.cloudflareLogFile ?? DEFAULT_CLOUDFLARE_LOG_FILE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  for (;;) {
    try {
      const url = provider === "cloudflare"
        ? await resolveCloudflareUrl(cloudflareLogFile)
        : await resolveNgrokUrl(port);
      if (url) return url;
    } catch {
      // Keep polling until the tunnel controller is ready.
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        provider === "cloudflare"
          ? `Timed out waiting for Cloudflare tunnel URL in ${cloudflareLogFile}`
          : `Timed out waiting for ngrok tunnel URL for port ${port}`,
      );
    }

    await sleep(500);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const url = await resolveTunnelUrl(options);
  process.stdout.write(`${url}\n`);
}

const isMain = process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}