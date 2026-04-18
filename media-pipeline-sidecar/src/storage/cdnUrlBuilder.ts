import { config } from '../config/config';

export function buildCanonicalMediaUrl(key: string): string {
  const normalizedKey = key.replace(/^\/+/, '');
  if (config.mediaObjectStoreBackend === 'file' && config.mediaObjectPublicBaseUrl) {
    return `${config.mediaObjectPublicBaseUrl.replace(/\/$/, '')}/${normalizedKey}`;
  }

  if (config.cloudflareMediaDomain) {
    return `https://${config.cloudflareMediaDomain}/${normalizedKey}`;
  }

  if (config.s3.publicBaseUrl) {
    return `${config.s3.publicBaseUrl.replace(/\/$/, '')}/${normalizedKey}`;
  }

  return `${config.s3.endpoint.replace(/\/$/, '')}/${config.s3.bucket}/${normalizedKey}`;
}

export function objectKeyFromCanonicalMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.replace(/^\/+/, '');

    if (config.mediaObjectPublicBaseUrl) {
      const publicBase = new URL(`${config.mediaObjectPublicBaseUrl.replace(/\/$/, '')}/`);
      const publicPrefix = publicBase.pathname.replace(/^\/+|\/+$/g, '');
      if (publicPrefix) {
        if (normalizedPath === publicPrefix) {
          return null;
        }

        if (normalizedPath.startsWith(`${publicPrefix}/`)) {
          return normalizedPath.slice(publicPrefix.length + 1) || null;
        }
      }
    }

    if (config.cloudflareMediaDomain) {
      return normalizedPath || null;
    }

    if (config.s3.publicBaseUrl) {
      const publicBase = new URL(`${config.s3.publicBaseUrl.replace(/\/$/, '')}/`);
      const publicPrefix = publicBase.pathname.replace(/^\/+|\/+$/g, '');
      if (!publicPrefix) {
        return normalizedPath || null;
      }

      if (normalizedPath === publicPrefix) {
        return null;
      }

      if (normalizedPath.startsWith(`${publicPrefix}/`)) {
        return normalizedPath.slice(publicPrefix.length + 1) || null;
      }
    }

    const bucketPrefix = `${config.s3.bucket}/`;
    if (normalizedPath.startsWith(bucketPrefix)) {
      return normalizedPath.slice(bucketPrefix.length) || null;
    }

    return normalizedPath || null;
  } catch {
    return null;
  }
}

export function buildGatewayUrl(cid?: string): string | undefined {
  if (!cid) return undefined;
  return `${config.ipfsGatewayBase.replace(/\/$/, '')}/${cid}`;
}
