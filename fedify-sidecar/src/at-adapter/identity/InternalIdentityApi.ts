export function buildInternalIdentityProjectionPathsByCanonicalAccountId(
  canonicalAccountId: string
): string[] {
  const encoded = encodeURIComponent(canonicalAccountId);

  return [
    `/api/internal/identity/by-canonical-account-id?canonicalAccountId=${encoded}`,
    `/api/internal/identity/by-canonical?canonicalAccountId=${encoded}`,
  ];
}

export function buildInternalIdentityProjectionPathByDid(did: string): string {
  return `/api/internal/identity/by-did?did=${encodeURIComponent(did)}`;
}

export function buildInternalIdentityProjectionPathByHandle(handle: string): string {
  return `/api/internal/identity/by-handle?handle=${encodeURIComponent(handle.toLowerCase())}`;
}

export function buildInternalIdentityChangesPath(options?: {
  since?: string | null;
  limit?: number;
}): string {
  const params = new URLSearchParams();

  if (options?.since) {
    params.set('since', options.since);
  }

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    params.set('limit', String(Math.floor(options.limit)));
  }

  const query = params.toString();
  return query.length > 0
    ? `/api/internal/identity/changes?${query}`
    : '/api/internal/identity/changes';
}
