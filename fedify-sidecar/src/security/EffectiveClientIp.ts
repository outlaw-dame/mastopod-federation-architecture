import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

const MAX_FORWARDED_FOR_BYTES = 4_096;
const MAX_FORWARDED_HOPS = 32;
const TRUST_ALL_TOKENS = new Set([
  '*',
  'true',
  '0.0.0.0/0',
  '::/0',
]);
const IPV4_MAPPED_START = '::ffff:0:0';
const IPV4_MAPPED_END = '::ffff:ffff:ffff';
const IPV4_MAPPED_PREFIX = 96;

export type ClientIpRequest = Pick<FastifyRequest, 'headers' | 'socket'>;
export type EffectiveClientIpResolver = (request: ClientIpRequest) => string;

/**
 * Resolve a security-sensitive client address without trusting forwarding
 * headers by default.
 *
 * SIDECAR_TRUSTED_PROXY_IPS is intentionally an explicit IP/CIDR allowlist.
 * Wildcard/trust-all values are rejected because Fastify's `trustProxy: true`
 * makes X-Forwarded-* metadata spoofable by any directly connected client.
 */
export function createEffectiveClientIpResolver(
  trustedProxyConfig = process.env['SIDECAR_TRUSTED_PROXY_IPS'] ?? '',
): EffectiveClientIpResolver {
  const trustedProxies = parseTrustedProxyConfig(trustedProxyConfig);

  return (request: ClientIpRequest): string => {
    const directPeer = normalizeIp(request.socket.remoteAddress);
    if (!directPeer) {
      return 'unknown';
    }

    // No trusted direct proxy means forwarding headers are attacker-controlled
    // metadata and must not affect rate limiting, audit attribution, or policy.
    if (!trustedProxies.matches(directPeer)) {
      return directPeer;
    }

    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.length === 0) {
      return directPeer;
    }
    if (forwarded.length > MAX_FORWARDED_FOR_BYTES) {
      return directPeer;
    }

    const rawHops = forwarded.split(',');
    if (rawHops.length === 0 || rawHops.length > MAX_FORWARDED_HOPS) {
      return directPeer;
    }

    const hops: string[] = [];
    for (const rawHop of rawHops) {
      const hop = normalizeIp(rawHop);
      // Fail closed on malformed chains rather than selectively ignoring an
      // attacker-controlled segment and accidentally changing hop semantics.
      if (!hop) {
        return directPeer;
      }
      hops.push(hop);
    }

    // Walk from the proxy closest to us toward the original client. This
    // ignores attacker-prepended leftmost values when a trusted edge proxy
    // appends the actual remote address to an existing X-Forwarded-For chain.
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = hops[index];
      if (!hop) continue;
      if (trustedProxies.matches(hop)) continue;
      return hop;
    }

    // An all-trusted chain does not prove a distinct client identity. Use the
    // direct socket peer so the limiter/audit path remains conservative.
    return directPeer;
  };
}

interface TrustedProxyMatcher {
  matches(address: string): boolean;
}

function parseTrustedProxyConfig(raw: string): TrustedProxyMatcher {
  const blockList = new BlockList();
  const tokens = raw
    .split(',')
    .map(token => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (TRUST_ALL_TOKENS.has(lower)) {
      throw trustAllError(token);
    }

    const slash = token.lastIndexOf('/');
    if (slash >= 0) {
      const rawNetwork = token.slice(0, slash).trim();
      const prefixText = token.slice(slash + 1).trim();
      const prefix = Number.parseInt(prefixText, 10);
      if (!/^\d+$/u.test(prefixText) || !Number.isInteger(prefix)) {
        throw new Error(`Invalid trusted proxy CIDR: ${token}`);
      }

      // Node commonly exposes IPv4 sockets as ::ffff:a.b.c.d while this
      // resolver canonicalizes those peers to IPv4. Normalize any IPv4-mapped
      // CIDR spelling into the equivalent IPv4 subnet so configuration and
      // runtime matching cannot disagree. /96 is exactly IPv4 /0 and is
      // therefore forbidden; mapped supernets are rejected rather than
      // broadening trust implicitly.
      const mappedIpv4 = parseIpv4MappedAddress(rawNetwork);
      if (mappedIpv4) {
        if (prefix < IPV4_MAPPED_PREFIX || prefix > 128) {
          throw new Error(`Invalid trusted proxy CIDR: ${token}`);
        }
        const ipv4Prefix = prefix - IPV4_MAPPED_PREFIX;
        if (ipv4Prefix === 0) {
          throw trustAllError(token);
        }
        blockList.addSubnet(mappedIpv4, ipv4Prefix, 'ipv4');
        continue;
      }

      const network = normalizeIp(rawNetwork);
      const family = network ? isIP(network) : 0;
      const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
      if (!network || prefix < 0 || prefix > maxPrefix) {
        throw new Error(`Invalid trusted proxy CIDR: ${token}`);
      }
      if (prefix === 0) {
        throw trustAllError(token);
      }

      if (family === 6 && overlapsIpv4MappedRange(network, prefix)) {
        throw new Error(
          `Invalid trusted proxy CIDR: ${token} overlaps IPv4-mapped addresses; use an IPv4 CIDR or IPv4-mapped CIDR`,
        );
      }

      blockList.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
      continue;
    }

    const address = normalizeIp(token);
    const family = address ? isIP(address) : 0;
    if (!address || family === 0) {
      throw new Error(`Invalid trusted proxy IP address: ${token}`);
    }
    blockList.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
  }

  return {
    matches(address: string): boolean {
      const normalized = normalizeIp(address);
      if (!normalized) return false;
      const family = isIP(normalized);
      if (family === 0) return false;
      return blockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

function trustAllError(token: string): Error {
  return new Error(
    `SIDECAR_TRUSTED_PROXY_IPS must not trust every source (${token})`,
  );
}

function parseIpv4MappedAddress(value: string): string | null {
  const candidate = value.trim();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(candidate);
  if (dotted?.[1] && isIP(dotted[1]) === 4) {
    return dotted[1];
  }

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(candidate);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return null;
  }
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function overlapsIpv4MappedRange(network: string, prefix: number): boolean {
  const mappedRange = new BlockList();
  mappedRange.addSubnet(IPV4_MAPPED_START, IPV4_MAPPED_PREFIX, 'ipv6');
  if (mappedRange.check(network, 'ipv6')) {
    return true;
  }

  const candidate = new BlockList();
  candidate.addSubnet(network, prefix, 'ipv6');
  return candidate.check(IPV4_MAPPED_START, 'ipv6')
    || candidate.check(IPV4_MAPPED_END, 'ipv6');
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate) return null;

  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1);
  }

  // Node commonly reports IPv4 peers on dual-stack sockets as IPv4-mapped
  // IPv6. Canonicalize both dotted and hexadecimal mapped spellings so proxy
  // allowlists and runtime socket addresses are compared in one IPv4 space.
  const mappedIpv4 = parseIpv4MappedAddress(candidate);
  if (mappedIpv4) {
    candidate = mappedIpv4;
  }

  return isIP(candidate) === 0 ? null : candidate.toLowerCase();
}
