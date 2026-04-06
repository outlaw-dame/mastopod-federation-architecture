import { config } from '../config/config';

export function buildCanonicalMediaUrl(key: string): string {
  const normalizedKey = key.replace(/^\/+/, '');
  if (config.cloudflareMediaDomain) {
    return `https://${config.cloudflareMediaDomain}/${normalizedKey}`;
  }

  return `${config.s3.endpoint.replace(/\/$/, '')}/${config.s3.bucket}/${normalizedKey}`;
}

export function buildGatewayUrl(cid?: string): string | undefined {
  if (!cid) return undefined;
  return `${config.filebaseGatewayBase.replace(/\/$/, '')}/${cid}`;
}
