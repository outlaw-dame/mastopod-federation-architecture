import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request, type Dispatcher } from "undici";

type UrlRequestOptions = NonNullable<Parameters<typeof request>[1]>;

export class UnsafeActivityPubTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeActivityPubTargetError";
  }
}

export function isUnsafeActivityPubTargetError(error: unknown): error is UnsafeActivityPubTargetError {
  return error instanceof UnsafeActivityPubTargetError;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ActivityPubEgressPolicyOptions {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  allowLoopbackHttp?: boolean;
  interopPrivateHostnames?: ReadonlySet<string>;
}

export interface ValidatedActivityPubTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  hostname: string;
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

function normalizeUrlHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
  return normalized;
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
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("::")) return true;
    const parts = normalized.split(":");
    const first = Number.parseInt(parts[0] || "0", 16);
    const second = Number.parseInt(parts[1] || "0", 16);

    // ActivityPub federation targets must resolve to globally routable IPv6.
    // Global unicast is 2000::/3; reject special-purpose ranges inside it too.
    if (first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2001 && second <= 0x01ff) return true; // protocol/special-purpose block
    if (first === 0x2001 && second === 0x0db8) return true; // documentation
    if (first === 0x2002) return true; // 6to4 embeds IPv4 and can reach non-global space
    if (first === 0x3fff) return true; // documentation prefix
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
  const normalized = normalizeUrlHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return parseIpv4(normalized)?.[0] === 127;
}

function isInteropPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    if (!octets) return false;
    const [a = 0, b = 0] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const first = Number.parseInt(address.toLowerCase().split(":", 1)[0] || "0", 16);
    return first >= 0xfc00 && first <= 0xfdff;
  }
  return false;
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
    throw new UnsafeActivityPubTargetError("ActivityPub egress target is not a valid URL");
  }

  if (url.username || url.password) throw new UnsafeActivityPubTargetError("ActivityPub egress target must not contain credentials");
  if (url.hash) throw new UnsafeActivityPubTargetError("ActivityPub egress target must not contain a fragment");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeActivityPubTargetError("ActivityPub egress target must use HTTP(S)");
  }

  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const hostname = normalizeUrlHostname(url.hostname);
  if (!hostname) throw new UnsafeActivityPubTargetError("ActivityPub egress target must contain a hostname");

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

  const interopPrivateException =
    url.protocol === "https:"
    && options.interopPrivateHostnames?.has(hostname) === true
    && addresses.every(entry => isInteropPrivateAddress(entry.address));

  const unsafe = addresses.find(entry => isForbiddenActivityPubAddress(entry.address));
  if (unsafe && !loopbackException && !interopPrivateException) {
    throw new UnsafeActivityPubTargetError(`ActivityPub egress target resolved to forbidden address ${unsafe.address}`);
  }

  if (url.protocol === "http:" && !loopbackException) {
    throw new UnsafeActivityPubTargetError("Plain HTTP ActivityPub egress is restricted to explicitly enabled literal loopback targets");
  }

  const chosen = addresses[0]!;
  return { url, address: chosen.address, family: chosen.family, hostname };
}

export function createPinnedLookup(target: ValidatedActivityPubTarget) {
  const expectedHost = target.hostname;
  return (hostname: string, lookupOptions: { all?: boolean } | undefined, callback: (...args: any[]) => void): void => {
    if (normalizeUrlHostname(hostname) !== expectedHost) {
      callback(new UnsafeActivityPubTargetError("ActivityPub egress dispatcher hostname mismatch"));
      return;
    }
    if (lookupOptions?.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function createPinnedDispatcher(target: ValidatedActivityPubTarget): Agent {
  return new Agent({ connect: { lookup: createPinnedLookup(target) as any } });
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

function interopPrivateHostnamesFromEnvironment(): ReadonlySet<string> | undefined {
  if (process.env["NODE_ENV"] !== "development" || process.env["AP_INTEROP_ENABLE_MEDIA_FIXTURES"] !== "true") return undefined;
  const configured = process.env["APDM_INTEROP_PRIVATE_HOSTS"];
  if (!configured) return undefined;
  return new Set(configured.split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
}

function loopbackHttpAllowedFromEnvironment(): boolean {
  if (process.env["NODE_ENV"] === "test") return true;
  return process.env["NODE_ENV"] === "development" && process.env["APDM_ALLOW_LOOPBACK_HTTP"] === "true";
}

export async function secureActivityPubRequest(
  value: string | URL,
  options: UrlRequestOptions,
  assertExternalPostAllowed?: () => void,
): Promise<Dispatcher.ResponseData> {
  const target = await validateActivityPubTarget(value, {
    allowLoopbackHttp: loopbackHttpAllowedFromEnvironment(),
    interopPrivateHostnames: interopPrivateHostnamesFromEnvironment(),
  });
  const dispatcher = getPinnedDispatcher(target);
  assertExternalPostAllowed?.();
  return request(target.url, {
    ...options,
    dispatcher,
    maxRedirections: 0,
  });
}
