import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_IPV4_RANGES: Array<[string, string]> = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.255']
];

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are permitted');
  }
  if (url.username || url.password) {
    throw new Error('Userinfo is not permitted in media URLs');
  }

  if (net.isIP(url.hostname)) {
    assertPublicIp(url.hostname);
    return url;
  }

  const answers = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (answers.length === 0) {
    throw new Error('Unable to resolve remote host');
  }
  for (const answer of answers) {
    assertPublicIp(answer.address);
  }

  return url;
}

function assertPublicIp(ip: string): void {
  if (net.isIPv4(ip)) {
    const num = ipv4ToInt(ip);
    for (const [start, end] of PRIVATE_IPV4_RANGES) {
      if (num >= ipv4ToInt(start) && num <= ipv4ToInt(end)) {
        throw new Error(`Blocked private IPv4 address: ${ip}`);
      }
    }
    return;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower.startsWith('ff') ||
      lower.startsWith('2001:db8:') ||
      lower.startsWith('2001:10:') ||
      lower.startsWith('2002:') ||
      lower.startsWith('64:ff9b:') ||
      lower.startsWith('100:') ||
      lower.startsWith('::ffff:')
    ) {
      throw new Error(`Blocked private IPv6 address: ${ip}`);
    }
    return;
  }

  throw new Error('Invalid IP address');
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').map(Number).reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
}
