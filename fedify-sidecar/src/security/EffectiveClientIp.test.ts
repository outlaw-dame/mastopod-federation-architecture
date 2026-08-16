import { describe, expect, it } from 'vitest';
import { createEffectiveClientIpResolver } from './EffectiveClientIp.js';

function request(
  remoteAddress: string | undefined,
  forwardedFor?: string,
) {
  return {
    headers: forwardedFor === undefined
      ? {}
      : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as any;
}

describe('createEffectiveClientIpResolver', () => {
  it('ignores spoofed X-Forwarded-For by default', () => {
    const resolve = createEffectiveClientIpResolver('');
    expect(resolve(request('203.0.113.10', '198.51.100.99'))).toBe('203.0.113.10');
  });

  it('uses the nearest untrusted hop when the direct proxy is explicitly trusted', () => {
    const resolve = createEffectiveClientIpResolver('127.0.0.1');
    expect(resolve(request('127.0.0.1', '198.51.100.25'))).toBe('198.51.100.25');
  });

  it('walks a multi-proxy chain from right to left and ignores attacker-prepended values', () => {
    const resolve = createEffectiveClientIpResolver('127.0.0.1,10.0.0.0/8');
    expect(resolve(request(
      '127.0.0.1',
      '192.0.2.66, 198.51.100.42, 10.4.5.6',
    ))).toBe('198.51.100.42');
  });

  it('canonicalizes IPv4-mapped socket addresses before trust matching', () => {
    const resolve = createEffectiveClientIpResolver('127.0.0.1');
    expect(resolve(request('::ffff:127.0.0.1', '198.51.100.42'))).toBe('198.51.100.42');
  });

  it('normalizes dotted IPv4-mapped proxy CIDRs to their IPv4 equivalent', () => {
    const resolve = createEffectiveClientIpResolver('::ffff:192.0.2.0/120');
    expect(resolve(request('::ffff:192.0.2.25', '198.51.100.42'))).toBe('198.51.100.42');
    expect(resolve(request('::ffff:198.51.100.25', '203.0.113.9'))).toBe('198.51.100.25');
  });

  it('normalizes hexadecimal IPv4-mapped proxy addresses and CIDRs', () => {
    const single = createEffectiveClientIpResolver('::ffff:c000:201');
    expect(single(request('::ffff:192.0.2.1', '198.51.100.42'))).toBe('198.51.100.42');

    const subnet = createEffectiveClientIpResolver('::ffff:c000:200/120');
    expect(subnet(request('::ffff:192.0.2.25', '203.0.113.9'))).toBe('203.0.113.9');
    expect(subnet(request('::ffff:198.51.100.25', '203.0.113.9'))).toBe('198.51.100.25');
  });

  it('fails closed to the socket peer for malformed or oversized forwarded chains', () => {
    const resolve = createEffectiveClientIpResolver('127.0.0.1');
    expect(resolve(request('127.0.0.1', '198.51.100.42, not-an-ip'))).toBe('127.0.0.1');
    expect(resolve(request('127.0.0.1', '1'.repeat(4097)))).toBe('127.0.0.1');
    expect(resolve(request(
      '127.0.0.1',
      Array.from({ length: 33 }, (_, index) => `192.0.2.${index + 1}`).join(','),
    ))).toBe('127.0.0.1');
  });

  it('rejects wildcard, native trust-all, and IPv4-mapped trust-all proxy configurations', () => {
    expect(() => createEffectiveClientIpResolver('*')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('true')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('0.0.0.0/0')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('::/0')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('::ffff:0.0.0.0/96')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('::ffff:0:0/96')).toThrow(/must not trust every source/u);
    expect(() => createEffectiveClientIpResolver('::/80')).toThrow(/IPv4-mapped/u);
  });

  it('does not let mapped trust-all configuration make a directly connected IPv4 attacker trusted', () => {
    expect(() => createEffectiveClientIpResolver('::ffff:0.0.0.0/96')).toThrow();
    expect(() => createEffectiveClientIpResolver('::ffff:0:0/96')).toThrow();

    const resolve = createEffectiveClientIpResolver('192.0.2.0/24');
    expect(resolve(request('203.0.113.44', '198.51.100.99'))).toBe('203.0.113.44');
  });

  it('rejects invalid IPs and CIDRs at startup', () => {
    expect(() => createEffectiveClientIpResolver('proxy.internal')).toThrow(/Invalid trusted proxy IP/u);
    expect(() => createEffectiveClientIpResolver('10.0.0.0/99')).toThrow(/Invalid trusted proxy CIDR/u);
    expect(() => createEffectiveClientIpResolver('::ffff:c000:200/95')).toThrow(/Invalid trusted proxy CIDR/u);
  });

  it('returns unknown when no valid socket peer exists', () => {
    const resolve = createEffectiveClientIpResolver('127.0.0.1');
    expect(resolve(request(undefined, '198.51.100.42'))).toBe('unknown');
  });
});
