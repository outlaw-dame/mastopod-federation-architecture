import path from 'node:path';
import type { CanonicalAsset } from '../contracts/CanonicalAsset';
import { generateBlurPreview } from '../processing/blurPreview';
import { processImageFile } from '../processing/image';
import { renderVideoRenditions } from '../processing/video';
import { replaceAsset, loadAllAssets } from '../storage/assetStore';
import { buildCanonicalMediaUrl, objectKeyFromCanonicalMediaUrl } from '../storage/cdnUrlBuilder';
import {
  downloadFromFilebaseToPath,
  headFilebaseObject,
  uploadToFilebase
} from '../storage/filebaseClient';
import { persistVideoRenditions } from '../storage/videoArtifactPersistence';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';

export interface ReconcileOptions {
  auditOnly?: boolean;
  assetId?: string;
}

export interface AssetReconcileResult {
  assetId: string;
  status: 'unchanged' | 'needs-repair' | 'repaired' | 'unrecoverable';
  repairs: string[];
  reason?: string;
}

export interface ReconcileSummary {
  assets: number;
  needsRepair: number;
  repaired: number;
  unchanged: number;
  unrecoverable: number;
  mode: 'audit' | 'repair';
  results: AssetReconcileResult[];
}

interface MissingVideoArtifacts {
  preview: boolean;
  thumbnail: boolean;
  playback: boolean;
  streaming: boolean;
}

export async function reconcileCanonicalAssets(
  options: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const assets = await loadAllAssets();
  const selectedAssets = options.assetId
    ? assets.filter((asset) => asset.assetId === options.assetId)
    : assets;

  if (options.assetId && selectedAssets.length === 0) {
    throw new Error(`Asset ${options.assetId} not found in canonical store`);
  }

  const results: AssetReconcileResult[] = [];

  for (const asset of selectedAssets) {
    results.push(await reconcileAsset(asset, { auditOnly: Boolean(options.auditOnly) }));
  }

  return summarizeResults(results, Boolean(options.auditOnly));
}

export async function reconcileAsset(
  asset: CanonicalAsset,
  options: { auditOnly: boolean }
): Promise<AssetReconcileResult> {
  const originalKey = objectKeyFromCanonicalMediaUrl(asset.canonicalUrl);
  if (!originalKey) {
    return {
      assetId: asset.assetId,
      status: 'unrecoverable',
      repairs: [],
      reason: 'canonical original URL cannot be mapped back to an object key'
    };
  }

  const originalHead = await headFilebaseObject(originalKey);
  if (!originalHead.exists) {
    return {
      assetId: asset.assetId,
      status: 'unrecoverable',
      repairs: [],
      reason: 'canonical original object is missing'
    };
  }

  if (asset.mimeType.startsWith('video/')) {
    return reconcileVideoAsset(asset, originalKey, options);
  }

  if (asset.mimeType.startsWith('image/')) {
    return reconcileImageAsset(asset, originalKey, options);
  }

  return {
    assetId: asset.assetId,
    status: 'unchanged',
    repairs: []
  };
}

function summarizeResults(
  results: AssetReconcileResult[],
  auditOnly: boolean
): ReconcileSummary {
  let repaired = 0;
  let needsRepair = 0;
  let unchanged = 0;
  let unrecoverable = 0;

  for (const result of results) {
    switch (result.status) {
      case 'repaired':
        repaired += 1;
        break;
      case 'needs-repair':
        needsRepair += 1;
        break;
      case 'unrecoverable':
        unrecoverable += 1;
        break;
      case 'unchanged':
      default:
        unchanged += 1;
        break;
    }
  }

  return {
    assets: results.length,
    needsRepair,
    repaired,
    unchanged,
    unrecoverable,
    mode: auditOnly ? 'audit' : 'repair',
    results
  };
}

async function reconcileImageAsset(
  asset: CanonicalAsset,
  originalKey: string,
  options: { auditOnly: boolean }
): Promise<AssetReconcileResult> {
  const previewMissing = !(await objectExistsForUrl(asset.variants.preview));
  const thumbnailMissing = !(await objectExistsForUrl(asset.variants.thumbnail));

  if (!previewMissing && !thumbnailMissing) {
    return {
      assetId: asset.assetId,
      status: 'unchanged',
      repairs: []
    };
  }

  const repairs = [
    ...(previewMissing ? ['preview'] : []),
    ...(thumbnailMissing ? ['thumbnail'] : [])
  ];

  if (options.auditOnly) {
    return {
      assetId: asset.assetId,
      status: 'needs-repair',
      repairs
    };
  }

  let scratchDir: string | undefined;

  try {
    scratchDir = await createWorkerScratchDir('reconcile-image');
    const originalPath = path.join(scratchDir, 'canonical-image.bin');
    await downloadFromFilebaseToPath(originalKey, originalPath);

    const processed = await processImageFile(originalPath);
    const updatedAsset: CanonicalAsset = {
      ...asset,
      width: asset.width ?? processed.width,
      height: asset.height ?? processed.height,
      variants: {
        ...asset.variants
      }
    };

    if (previewMissing) {
      const previewBuffer = await generateBlurPreview(processed.buffer);
      const uploadedPreview = await uploadToFilebase({
        key: `${asset.sha256}-preview.webp`,
        body: previewBuffer,
        contentType: 'image/webp',
        objectClass: 'image-preview'
      });
      updatedAsset.variants.preview = buildCanonicalMediaUrl(uploadedPreview.key);
    }

    if (thumbnailMissing && processed.thumbnail) {
      const uploadedThumbnail = await uploadToFilebase({
        key: `${asset.sha256}-thumb.webp`,
        body: processed.thumbnail,
        contentType: 'image/webp',
        objectClass: 'image-thumbnail'
      });
      updatedAsset.variants.thumbnail = buildCanonicalMediaUrl(uploadedThumbnail.key);
    }

    await replaceAsset(updatedAsset);

    return {
      assetId: asset.assetId,
      status: 'repaired',
      repairs
    };
  } finally {
    await cleanupWorkerScratchDir(scratchDir);
  }
}

async function reconcileVideoAsset(
  asset: CanonicalAsset,
  originalKey: string,
  options: { auditOnly: boolean }
): Promise<AssetReconcileResult> {
  const missing = await identifyMissingVideoArtifacts(asset);
  const repairs = [
    ...(missing.preview ? ['preview'] : []),
    ...(missing.thumbnail ? ['thumbnail'] : []),
    ...(missing.playback ? ['playback'] : []),
    ...(missing.streaming ? ['streaming'] : [])
  ];

  if (repairs.length === 0) {
    return {
      assetId: asset.assetId,
      status: 'unchanged',
      repairs: []
    };
  }

  if (options.auditOnly) {
    return {
      assetId: asset.assetId,
      status: 'needs-repair',
      repairs
    };
  }

  let scratchDir: string | undefined;

  try {
    scratchDir = await createWorkerScratchDir('reconcile-video');
    const originalPath = path.join(scratchDir, 'canonical-video.bin');
    await downloadFromFilebaseToPath(originalKey, originalPath);

    const renditions = await renderVideoRenditions(originalPath, scratchDir, asset.mimeType);
    const persistedRenditions = await persistVideoRenditions(asset.sha256, renditions);

    const updatedAsset: CanonicalAsset = {
      ...asset,
      duration: asset.duration ?? renditions.duration,
      width: asset.width ?? renditions.width,
      height: asset.height ?? renditions.height,
      variants: {
        ...asset.variants,
        preview: persistedRenditions.previewUrl || asset.variants.preview,
        thumbnail: persistedRenditions.thumbnailUrl || asset.variants.thumbnail,
        playback: persistedRenditions.playbackVariants.length > 0
          ? persistedRenditions.playbackVariants
          : asset.variants.playback,
        streaming: persistedRenditions.streamingManifests.length > 0
          ? persistedRenditions.streamingManifests
          : asset.variants.streaming
      }
    };

    await replaceAsset(updatedAsset);

    return {
      assetId: asset.assetId,
      status: 'repaired',
      repairs
    };
  } finally {
    await cleanupWorkerScratchDir(scratchDir);
  }
}

async function identifyMissingVideoArtifacts(asset: CanonicalAsset): Promise<MissingVideoArtifacts> {
  const playbackVariants = asset.variants.playback || [];
  const streamingManifests = asset.variants.streaming || [];

  const playbackMissing = playbackVariants.length === 0
    || !(await allUrlsExist(playbackVariants.map((variant) => variant.url)));
  const streamingMissing = streamingManifests.length < 2
    || !(await allUrlsExist([
      ...streamingManifests.map((manifest) => manifest.url),
      ...streamingManifests.flatMap((manifest) => manifest.variants.map((variant) => variant.url))
    ]));

  return {
    preview: !(await objectExistsForUrl(asset.variants.preview)),
    thumbnail: !(await objectExistsForUrl(asset.variants.thumbnail)),
    playback: playbackMissing,
    streaming: streamingMissing
  };
}

async function allUrlsExist(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    if (!(await objectExistsForUrl(url))) {
      return false;
    }
  }

  return true;
}

async function objectExistsForUrl(url: string | undefined): Promise<boolean> {
  if (!url) {
    return false;
  }

  const key = objectKeyFromCanonicalMediaUrl(url);
  if (!key) {
    return false;
  }

  const object = await headFilebaseObject(key);
  return object.exists;
}
