import { VideoPlaybackVariant, VideoStreamingManifest, VideoStreamingVariant } from '../contracts/CanonicalAsset';

export function parsePlaybackVariants(value: unknown): VideoPlaybackVariant[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.label !== 'string' || typeof candidate.url !== 'string' || typeof candidate.mimeType !== 'string') {
      return [];
    }

    return [{
      label: candidate.label,
      url: candidate.url,
      mimeType: candidate.mimeType,
      width: normalizeOptionalNumber(candidate.width),
      height: normalizeOptionalNumber(candidate.height),
      bitrateKbps: normalizeOptionalNumber(candidate.bitrateKbps)
    }];
  });
}

export function serializePlaybackVariants(variants: VideoPlaybackVariant[]): string {
  return JSON.stringify(variants);
}

export function parseStreamingManifests(value: unknown): VideoStreamingManifest[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if ((candidate.protocol !== 'hls' && candidate.protocol !== 'dash') || typeof candidate.url !== 'string' || typeof candidate.mimeType !== 'string') {
      return [];
    }

    return [{
      protocol: candidate.protocol,
      url: candidate.url,
      mimeType: candidate.mimeType,
      defaultVariantLabel: typeof candidate.defaultVariantLabel === 'string' ? candidate.defaultVariantLabel : undefined,
      variants: parseStreamingVariants(candidate.variants)
    }];
  });
}

export function serializeStreamingManifests(manifests: VideoStreamingManifest[]): string {
  return JSON.stringify(manifests);
}

export function mergePlaybackVariants(
  existing: VideoPlaybackVariant[] | undefined,
  incoming: VideoPlaybackVariant[] | undefined
): VideoPlaybackVariant[] | undefined {
  const merged = new Map<string, VideoPlaybackVariant>();

  for (const variant of existing || []) {
    merged.set(playbackVariantKey(variant), variant);
  }

  for (const variant of incoming || []) {
    merged.set(playbackVariantKey(variant), variant);
  }

  if (merged.size === 0) {
    return undefined;
  }

  return [...merged.values()].sort((left, right) => {
    const leftWidth = left.width ?? Number.MAX_SAFE_INTEGER;
    const rightWidth = right.width ?? Number.MAX_SAFE_INTEGER;
    return leftWidth - rightWidth || left.label.localeCompare(right.label);
  });
}

export function mergeStreamingManifests(
  existing: VideoStreamingManifest[] | undefined,
  incoming: VideoStreamingManifest[] | undefined
): VideoStreamingManifest[] | undefined {
  const merged = new Map<string, VideoStreamingManifest>();

  for (const manifest of existing || []) {
    merged.set(streamingManifestKey(manifest), normalizeStreamingManifest(manifest));
  }

  for (const manifest of incoming || []) {
    merged.set(streamingManifestKey(manifest), normalizeStreamingManifest(manifest));
  }

  if (merged.size === 0) {
    return undefined;
  }

  return [...merged.values()].sort((left, right) => left.protocol.localeCompare(right.protocol) || left.url.localeCompare(right.url));
}

export function sanitizePlaybackVariantsForLogging(value: string): string {
  const variants = parsePlaybackVariants(value);
  if (variants.length === 0) {
    return '[]';
  }

  return JSON.stringify(variants.map((variant) => ({
    label: variant.label,
    url: sanitizeUrl(variant.url),
    mimeType: variant.mimeType,
    width: variant.width,
    height: variant.height,
    bitrateKbps: variant.bitrateKbps
  })));
}

export function sanitizeStreamingManifestsForLogging(value: string): string {
  const manifests = parseStreamingManifests(value);
  if (manifests.length === 0) {
    return '[]';
  }

  return JSON.stringify(manifests.map((manifest) => ({
    protocol: manifest.protocol,
    url: sanitizeUrl(manifest.url),
    mimeType: manifest.mimeType,
    defaultVariantLabel: manifest.defaultVariantLabel,
    variantCount: manifest.variants.length,
    variants: manifest.variants.map((variant) => ({
      label: variant.label,
      url: sanitizeUrl(variant.url),
      mimeType: variant.mimeType,
      width: variant.width,
      height: variant.height,
      bitrateKbps: variant.bitrateKbps
    }))
  })));
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  return value;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseStreamingVariants(value: unknown): VideoStreamingVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.label !== 'string' || typeof candidate.url !== 'string' || typeof candidate.mimeType !== 'string') {
      return [];
    }

    return [{
      label: candidate.label,
      url: candidate.url,
      mimeType: candidate.mimeType,
      width: normalizeOptionalNumber(candidate.width),
      height: normalizeOptionalNumber(candidate.height),
      bitrateKbps: normalizeOptionalNumber(candidate.bitrateKbps)
    }];
  });
}

function playbackVariantKey(variant: VideoPlaybackVariant): string {
  return `${variant.label}:${variant.mimeType}`;
}

function streamingManifestKey(manifest: VideoStreamingManifest): string {
  return `${manifest.protocol}:${manifest.url}`;
}

function normalizeStreamingManifest(manifest: VideoStreamingManifest): VideoStreamingManifest {
  return {
    ...manifest,
    variants: [...manifest.variants].sort((left, right) => {
      const leftWidth = left.width ?? Number.MAX_SAFE_INTEGER;
      const rightWidth = right.width ?? Number.MAX_SAFE_INTEGER;
      return leftWidth - rightWidth || left.label.localeCompare(right.label);
    })
  };
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}
