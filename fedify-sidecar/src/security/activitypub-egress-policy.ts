import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request, type Dispatcher } from "undici";

type UrlRequestOptions = NonNullable<Parameters<typeof request>[1]>;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ActivityPubEgressPolicyOptions {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  allowLoopbackHttp?: boolean;
}

export interface ValidatedActivityPubTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

const DISPATCHER_TTL_MS = 60_000;
const MAX_DISPATCHERS = 128;
const dispatcherCache = new Map<string, { dispatcher: Agent; expiresAt: number }>();

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number.parseInt(part, 10));
  if (octets.some((part, index) => !/^\d+$/u.test(parts[index] ?? "") || part < 0 || part > 255)) return null;
  return octets;
}

export function isForbiddenActivityPubAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    if (!octets) return true;
    const [a = 0, b = 0, c = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      return isIP(mapped) === 4 ? isForbiddenActivityPubAddress(mapped) : true;
    }
    const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
    if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true;
    if (normalized.startsWith("2001:db8:")) return true;
    return false;
  }

  return true;
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const octets = parseIpv4(address);
  return octets?.[0] === 127;
}

function isExplicitLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return parseIpv4(normalized)?.[0] === 127;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, order: "verbatim" });
  return results
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
    .map(entry => ({ address: entry.address, family: entry.family }));
}

export async function validateActivityPubTarget(
  value: string | URL,
  options: ActivityPubEgressPolicyOptions = {},
): Promise<ValidatedActivityPubTarget> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error("ActivityPub egress target is not a valid URL");
  }

  if (url.username || url.password) throw new Error("ActivityPub egress target must not contain credentials");
  if (url.hash) throw new Error("ActivityPub egress target must not contain a fragment");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("ActivityPub egress target must use HTTP(S)");
  }

  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw new Error("ActivityPub egress target must contain a hostname");

  let addresses: ResolvedAddress[];
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    const resolver = options.lookup ?? defaultLookup;
    addresses = await resolver(hostname);
  }

  if (addresses.length === 0) throw new Error("ActivityPub egress target resolved to no addresses");

  const loopbackException =
    allowLoopbackHttp
    && url.protocol === "http:"
    && isExplicitLoopbackHost(hostname)
    && addresses.every(entry => isLoopbackAddress(entry.address));

  const unsafe = addresses.find(entry => isForbiddenActivityPubAddress(entry.address));
  if (unsafe && !loopbackException) {
    throw new Error(`ActivityPub egress target resolved to forbidden address ${unsafe.address}`);
  }

  if (url.protocol === "http:" && !loopbackException) {
    throw new Error("Plain HTTP ActivityPub egress is restricted to explicitly enabled literal loopback targets");
  }

  const chosen = addresses[0]!;
  return { url, address: chosen.address, family: chosen.family };
}

function createPinnedDispatcher(target: ValidatedActivityPubTarget): Agent {
  const expectedHost = target.url.hostname.toLowerCase();
  return new Agent({
    connect: {
      lookup: ((hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => {
        if (hostname.toLowerCase() !== expectedHost) {
          callback(new Error("ActivityPub egress dispatcher hostname mismatch"));
          return;
        }
        callback(null, target.address, target.family);
      }) as any,
    },
  });
}

function getPinnedDispatcher(target: ValidatedActivityPubTarget): Dispatcher {
  const now = Date.now();
  const key = `${target.url.origin}|${target.address}|${target.family}`;
  const existing = dispatcherCache.get(key);
  if (existing && existing.expiresAt > now) return existing.dispatcher;
  if (existing) {
    dispatcherCache.delete(key);
    void existing.dispatcher.close().catch(() => undefined);
  }

  for (const [cacheKey, entry] of dispatcherCache) {
    if (entry.expiresAt <= now || dispatcherCache.size >= MAX_DISPATCHERS) {
      dispatcherCache.delete(cacheKey);
      void entry.dispatcher.close().catch(() => undefined);
      if (dispatcherCache.size < MAX_DISPATCHERS) break;
    }
  }

  const dispatcher = createPinnedDispatcher(target);
  dispatcherCache.set(key, { dispatcher, expiresAt: now + DISPATCHER_TTL_MS });
  return dispatcher;
}

export async function secureActivityPubRequest(
  value: string | URL,
  options: UrlRequestOptions,
): Promise<Dispatcher.ResponseData> {
  const target = await validateActivityPubTarget(value, {
    allowLoopbackHttp: process.env["NODE_ENV"] === "test" || process.env["APDM_ALLOW_LOOPBACK_HTTP"] === "true",
  });
  const dispatcher = getPinnedDispatcher(target);
  return request(target.url, {
    ...options,
    dispatcher,
    maxRedirections: 0,
  });
}
