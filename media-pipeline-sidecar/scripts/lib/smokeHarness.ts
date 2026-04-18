import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetch } from 'undici';
import type { CanonicalAsset } from '../../src/contracts/CanonicalAsset';

interface SmokeHarnessOptions {
  sourceUrl: string;
  runSsrfValidation: boolean;
  expectedKind?: 'image' | 'video';
  requestTimeoutMs?: number;
  maxDownloadBytes?: number;
  envOverrides?: Record<string, string>;
}

interface CanonicalAssetRecord {
  assetId: string;
  variants?: {
    playback?: Array<unknown>;
    streaming?: Array<unknown>;
  };
}

interface QueueMessage {
  [key: string]: string;
}

export interface SmokeHarnessResult {
  assetId: string;
  indexedCount: number;
  persistedCount: number;
  mediaKind: 'image' | 'video';
  playbackVariantCount: number;
  streamingManifestCount: number;
  streamingProtocols: string[];
  projectedDeliveryKind?: 'original' | 'playback' | 'streaming';
  projectedMediaType?: string;
  projectedUrl?: string;
  firstPartyProjectedDeliveryKind?: 'original' | 'playback' | 'streaming';
  firstPartyProjectedMediaType?: string;
  firstPartyProjectedUrl?: string;
}

interface StoredObjectRecord {
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  tagging?: string;
}

export interface SmokeHarnessRuntime {
  tmpDir: string;
  runPipeline: () => Promise<SmokeHarnessResult>;
}

let importFreshCounter = 0;

function createServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate server port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function applyEnv(overrides: Record<string, string>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function normalizeExpectedKind(input?: string): 'image' | 'video' | undefined {
  if (!input) return undefined;
  if (input === 'image' || input === 'video') return input;
  throw new Error('SMOKE_PUBLIC_EXPECT_KIND must be either image or video when provided');
}

function sanitizeSourceForLogs(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  return `${parsed.protocol}//${parsed.hostname}`;
}

export function expectedKindFromEnv(value?: string): 'image' | 'video' | undefined {
  return normalizeExpectedKind(value);
}

async function importFresh<TModule>(relativePath: string): Promise<TModule> {
  const url = new URL(relativePath, import.meta.url);
  url.searchParams.set('fresh', String(importFreshCounter++));
  return import(url.href) as Promise<TModule>;
}

export async function withSmokeHarnessEnvironment<T>(
  options: SmokeHarnessOptions,
  callback: (runtime: SmokeHarnessRuntime) => Promise<T>
): Promise<T> {
  const runtime = await createSmokeHarnessEnvironment(options);
  try {
    return await callback(runtime);
  } finally {
    await runtime.cleanup();
  }
}

export async function runSmokeHarness(options: SmokeHarnessOptions): Promise<SmokeHarnessResult> {
  return withSmokeHarnessEnvironment(options, async ({ runPipeline }) => runPipeline());
}

async function createSmokeHarnessEnvironment(
  options: SmokeHarnessOptions
): Promise<SmokeHarnessRuntime & { cleanup: () => Promise<void> }> {
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  const maxDownloadBytes = options.maxDownloadBytes ?? 10 * 1024 * 1024;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'media-pipeline-smoke-'));
  const indexedDocuments: unknown[] = [];
  const storedObjects = new Map<string, StoredObjectRecord>();

  let s3Mock: { server: http.Server; port: number } | undefined;
  let openSearchMock: { server: http.Server; port: number } | undefined;
  let restoreEnv: (() => void) | undefined;
  let reloadConfigFromEnv: (() => void) | undefined;

    try {
      s3Mock = await createServer(async (req, res) => {
        const objectKey = new URL(req.url || '/', 'http://smoke.local').pathname;

        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const rawBody = Buffer.concat(chunks);
          const decodedBody = decodeAwsChunkedPayload(rawBody, req.headers);

          const metadata = Object.fromEntries(
            Object.entries(req.headers)
              .flatMap(([headerName, headerValue]) => {
                if (!headerName.toLowerCase().startsWith('x-amz-meta-')) {
                  return [];
                }

                return [[headerName.slice('x-amz-meta-'.length), Array.isArray(headerValue) ? headerValue[0] : headerValue || '']];
              })
              .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
          );

          storedObjects.set(objectKey, {
            body: decodedBody,
            contentType: Array.isArray(req.headers['content-type'])
              ? req.headers['content-type'][0]
              : req.headers['content-type'] || 'application/octet-stream',
            cacheControl: Array.isArray(req.headers['cache-control'])
              ? req.headers['cache-control'][0]
              : req.headers['cache-control'] || undefined,
            contentDisposition: Array.isArray(req.headers['content-disposition'])
              ? req.headers['content-disposition'][0]
              : req.headers['content-disposition'] || undefined,
            metadata,
            tagging: Array.isArray(req.headers['x-amz-tagging'])
              ? req.headers['x-amz-tagging'][0]
              : req.headers['x-amz-tagging'] || undefined
          });

          res.statusCode = 200;
          res.setHeader('content-type', 'application/xml');
          res.end('<PutObjectResult/>');
          return;
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
          const stored = storedObjects.get(objectKey);
          if (!stored) {
            res.statusCode = 404;
            res.end('not-found');
            return;
          }

          res.statusCode = 200;
          res.setHeader('content-type', stored.contentType);
          res.setHeader('content-length', String(stored.body.byteLength));
          if (stored.cacheControl) {
            res.setHeader('cache-control', stored.cacheControl);
          }
          if (stored.contentDisposition) {
            res.setHeader('content-disposition', stored.contentDisposition);
          }
          res.end(req.method === 'HEAD' ? undefined : stored.body);
          return;
        }

        if (req.method === 'DELETE') {
          storedObjects.delete(objectKey);
          res.statusCode = 204;
          res.end();
          return;
        }

        res.statusCode = 405;
        res.end('method-not-allowed');
      });

    openSearchMock = await createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
      }

      if (req.method === 'POST' && req.url === '/_bulk') {
        const lines = body
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        if (lines.length % 2 !== 0) {
          res.statusCode = 400;
          res.end('invalid-bulk-payload');
          return;
        }

        const items: Array<{ index: { _id: string; status: number } }> = [];
        for (let i = 0; i < lines.length; i += 2) {
          const action = JSON.parse(lines[i]) as { index?: { _id?: string } };
          const document = JSON.parse(lines[i + 1]);
          indexedDocuments.push(document);
          items.push({
            index: {
              _id: action.index?._id || `doc-${i / 2}`,
              status: 201
            }
          });
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ errors: false, items }));
        return;
      }

      if (req.method === 'PUT') {
        indexedDocuments.push(JSON.parse(body));
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: 'created' }));
        return;
      }

      res.statusCode = 405;
      res.end('method-not-allowed');
    });

    restoreEnv = applyEnv({
      OPENSEARCH_URL: `http://127.0.0.1:${openSearchMock.port}`,
      S3_ENDPOINT: `http://127.0.0.1:${s3Mock.port}`,
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'smoke-media',
      S3_ACCESS_KEY_ID: 'smoke',
      S3_SECRET_ACCESS_KEY: 'smoke',
      MEDIA_DATA_DIR: tmpDir,
      ASSET_STORE_BACKEND: 'file',
      REQUEST_TIMEOUT_MS: String(timeoutMs),
      ...options.envOverrides
    });

    ({ reloadConfigFromEnv } = await import('../../src/config/config'));
    reloadConfigFromEnv();

    const runPipeline = async (): Promise<SmokeHarnessResult> => {
      try {

    const [
      { retryAsync },
      { assertSafeRemoteUrl },
      { validateMediaPayload },
      { processImage, sha256 },
      { processVideoFile, renderVideoRenditions, videoExtensionForMime },
      { generateBlurPreview },
      { downloadFromFilebaseToPath, uploadFileToFilebase, uploadToFilebase },
      { buildCanonicalMediaUrl, buildGatewayUrl },
      { config },
      { loadAllAssets, saveAsset },
      { indexMediaAsset },
      { parsePlaybackVariants, parseStreamingManifests, serializePlaybackVariants, serializeStreamingManifests },
      { projectToActivityPubMedia }
    ] = await Promise.all([
      importFresh<typeof import('../../src/utils/retry')>('../../src/utils/retry'),
      importFresh<typeof import('../../src/security/ssrfGuard')>('../../src/security/ssrfGuard'),
      importFresh<typeof import('../../src/ingest/mimeValidation')>('../../src/ingest/mimeValidation'),
      importFresh<typeof import('../../src/processing/image')>('../../src/processing/image'),
      importFresh<typeof import('../../src/processing/video')>('../../src/processing/video'),
      importFresh<typeof import('../../src/processing/blurPreview')>('../../src/processing/blurPreview'),
      importFresh<typeof import('../../src/storage/filebaseClient')>('../../src/storage/filebaseClient'),
      importFresh<typeof import('../../src/storage/cdnUrlBuilder')>('../../src/storage/cdnUrlBuilder'),
      importFresh<typeof import('../../src/config/config')>('../../src/config/config'),
      importFresh<typeof import('../../src/storage/assetStore')>('../../src/storage/assetStore'),
      importFresh<typeof import('../../src/indexing/openSearchMediaIndexer')>('../../src/indexing/openSearchMediaIndexer'),
      importFresh<typeof import('../../src/utils/playbackVariants')>('../../src/utils/playbackVariants'),
      importFresh<typeof import('../../src/projection/activitypubMedia')>('../../src/projection/activitypubMedia')
    ]);

    const ingestQueue: QueueMessage[] = [];
    const fetchQueue: QueueMessage[] = [];
    const processImageQueue: QueueMessage[] = [];
    const processVideoQueue: QueueMessage[] = [];
    const videoRenditionQueue: QueueMessage[] = [];
    const finalizeQueue: QueueMessage[] = [];
    let observedKind: 'image' | 'video' | undefined;

    ingestQueue.push({
      traceId: 'smoke-trace-1',
      sourceUrl: options.sourceUrl,
      ownerId: 'smoke-owner',
      alt: 'smoke-alt',
      contentWarning: '',
      isSensitive: 'false'
    });

    while (ingestQueue.length > 0) {
      fetchQueue.push(ingestQueue.shift()!);
    }

    while (fetchQueue.length > 0) {
      const message = fetchQueue.shift()!;
      const safeUrl = options.runSsrfValidation
        ? await assertSafeRemoteUrl(message.sourceUrl)
        : new URL(message.sourceUrl);

      const response = await retryAsync(async () => {
        const candidate = await fetch(safeUrl, {
          headers: { 'user-agent': 'media-pipeline-sidecar-smoke/1.0' },
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (candidate.status >= 500 || candidate.status === 429) {
          throw new Error(`Transient fetch failure: ${candidate.status}`);
        }

        return candidate;
      }, {
        retries: 3,
        baseDelayMs: 250,
        maxDelayMs: 4000
      });

      if (!response.ok) {
        throw new Error(`Fetch failed in smoke test: ${response.status}`);
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && Number(contentLengthHeader) > maxDownloadBytes) {
        throw new Error('Smoke fixture exceeds max download bytes before body read');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxDownloadBytes) {
        throw new Error('Smoke fixture exceeds max download bytes after body read');
      }

      const validated = await validateMediaPayload({
        buffer,
        declaredMimeType: response.headers.get('content-type') || 'application/octet-stream'
      });

      if (options.expectedKind && validated.kind !== options.expectedKind) {
        throw new Error(`Expected ${options.expectedKind} fixture but received ${validated.kind}`);
      }

      observedKind = validated.kind;

      const payload: QueueMessage = {
        traceId: message.traceId,
        ownerId: message.ownerId,
        alt: message.alt,
        contentWarning: message.contentWarning,
        isSensitive: message.isSensitive,
        sourceUrl: safeUrl.toString(),
        mimeType: validated.mimeType,
        bytesBase64: buffer.toString('base64'),
        signals: '[]'
      };

      if (validated.kind === 'video') {
        processVideoQueue.push(payload);
      } else {
        processImageQueue.push(payload);
      }
    }

    while (processImageQueue.length > 0) {
      const message = processImageQueue.shift()!;
      const input = Buffer.from(message.bytesBase64, 'base64');
      const processed = await processImage(input);
      const blurPreview = await generateBlurPreview(processed.buffer);

      const fileHash = sha256(processed.buffer);
      const originalKey = `${fileHash}.webp`;
      const previewKey = `${fileHash}-preview.webp`;

      const original = await uploadToFilebase({
        key: originalKey,
        body: processed.buffer,
        contentType: 'image/webp',
        objectClass: 'canonical-original'
      });

      const preview = await uploadToFilebase({
        key: previewKey,
        body: blurPreview,
        contentType: 'image/webp',
        objectClass: 'image-preview'
      });

      finalizeQueue.push({
        traceId: message.traceId,
        ownerId: message.ownerId,
        alt: message.alt,
        contentWarning: message.contentWarning,
        isSensitive: message.isSensitive,
        sha256: fileHash,
        cid: original.cid || '',
        canonicalUrl: buildCanonicalMediaUrl(original.key),
        gatewayUrl: buildGatewayUrl(original.cid) || '',
        previewUrl: buildCanonicalMediaUrl(preview.key),
        thumbnailUrl: '',
        mimeType: 'image/webp',
        size: String(processed.buffer.byteLength),
        width: String(processed.width || ''),
        height: String(processed.height || ''),
        signals: '[]'
      });
    }

    while (processVideoQueue.length > 0) {
      const message = processVideoQueue.shift()!;
      const input = Buffer.from(message.bytesBase64, 'base64');
      const inputPath = path.join(tmpDir, `${message.traceId}-video-input.bin`);
      await writeFile(inputPath, input);

      const processed = await processVideoFile(inputPath, message.mimeType);
      const original = await uploadToFilebase({
        key: `${processed.sha256}.${videoExtensionForMime(processed.mimeType)}`,
        body: await readFile(inputPath),
        contentType: processed.mimeType,
        objectClass: 'canonical-original'
      });

      videoRenditionQueue.push({
        traceId: message.traceId,
        ownerId: message.ownerId,
        alt: message.alt,
        contentWarning: message.contentWarning,
        isSensitive: message.isSensitive,
        sha256: processed.sha256,
        cid: original.cid || '',
        originalObjectKey: original.key,
        canonicalUrl: buildCanonicalMediaUrl(original.key),
        gatewayUrl: buildGatewayUrl(original.cid) || '',
        mimeType: processed.mimeType,
        size: String(processed.size),
        signals: '[]'
      });
    }

    while (videoRenditionQueue.length > 0) {
      const message = videoRenditionQueue.shift()!;
      const renditionDir = path.join(tmpDir, `${message.traceId}-video-rendition`);
      await mkdir(renditionDir, { recursive: true });
      const inputPath = path.join(renditionDir, 'canonical-video.bin');
      await downloadFromFilebaseToPath(message.originalObjectKey, inputPath);

      let renditions: Awaited<ReturnType<typeof renderVideoRenditions>>;
      try {
        renditions = await renderVideoRenditions(inputPath, renditionDir, message.mimeType);
      } catch {
        renditions = {};
      }
      const preview = renditions.previewPath
        ? await uploadToFilebase({
            key: `${message.sha256}-preview.webp`,
            body: await readFile(renditions.previewPath),
            contentType: 'image/webp',
            objectClass: 'image-preview'
          })
        : null;
      const thumbnail = renditions.thumbnailPath
        ? await uploadToFilebase({
            key: `${message.sha256}-thumb.webp`,
            body: await readFile(renditions.thumbnailPath),
            contentType: 'image/webp',
            objectClass: 'image-thumbnail'
          })
        : null;
      const playbackVariants = await Promise.all((renditions.playbackVariants || []).map(async (variant) => {
        const uploaded = await uploadFileToFilebase({
          key: `${message.sha256}-${variant.label}.mp4`,
          filePath: variant.filePath,
          contentType: variant.mimeType,
          objectClass: 'video-playback'
        });

        return {
          label: variant.label,
          url: buildCanonicalMediaUrl(uploaded.key),
          mimeType: variant.mimeType,
          width: variant.width,
          height: variant.height,
          bitrateKbps: variant.bitrateKbps
        };
      }));
      const streamingManifests = await Promise.all((renditions.streamingManifests || []).map(async (manifest) => {
        const basePrefix = `${message.sha256}/${manifest.protocol}`;

        await Promise.all(manifest.artifactFiles.map((artifact) => uploadFileToFilebase({
          key: `${basePrefix}/${artifact.relativePath}`,
          filePath: artifact.filePath,
          contentType: artifact.contentType,
          objectClass: artifact.relativePath.endsWith('.m3u8')
            || artifact.relativePath.endsWith('.mpd')
            || artifact.contentType === 'application/vnd.apple.mpegurl'
            || artifact.contentType === 'application/dash+xml'
            ? 'streaming-manifest'
            : 'streaming-segment'
        })));

        return {
          protocol: manifest.protocol,
          url: buildCanonicalMediaUrl(`${basePrefix}/${manifest.relativePath}`),
          mimeType: manifest.mimeType,
          defaultVariantLabel: manifest.defaultVariantLabel,
          variants: manifest.variants.map((variant) => ({
            label: variant.label,
            url: buildCanonicalMediaUrl(`${basePrefix}/${variant.relativePath}`),
            mimeType: variant.mimeType,
            width: variant.width,
            height: variant.height,
            bitrateKbps: variant.bitrateKbps
          }))
        };
      }));

      finalizeQueue.push({
        traceId: message.traceId,
        ownerId: message.ownerId,
        alt: message.alt,
        contentWarning: message.contentWarning,
        isSensitive: message.isSensitive,
        sha256: message.sha256,
        cid: message.cid || '',
        canonicalUrl: message.canonicalUrl,
        gatewayUrl: message.gatewayUrl || '',
        previewUrl: preview ? buildCanonicalMediaUrl(preview.key) : '',
        thumbnailUrl: thumbnail ? buildCanonicalMediaUrl(thumbnail.key) : '',
        playbackVariants: serializePlaybackVariants(playbackVariants),
        streamingManifests: serializeStreamingManifests(streamingManifests),
        mimeType: message.mimeType,
        size: message.size,
        duration: renditions.duration || '',
        width: renditions.width ? String(renditions.width) : '',
        height: renditions.height ? String(renditions.height) : '',
        signals: '[]'
      });
    }

    while (finalizeQueue.length > 0) {
      const message = finalizeQueue.shift()!;
      const asset = {
        assetId: message.sha256,
        ownerId: message.ownerId,
        sha256: message.sha256,
        cid: message.cid || undefined,
        mimeType: message.mimeType,
        size: Number(message.size),
        width: message.width ? Number(message.width) : undefined,
        height: message.height ? Number(message.height) : undefined,
        canonicalUrl: message.canonicalUrl,
        gatewayUrl: message.gatewayUrl || undefined,
        variants: {
          original: message.canonicalUrl,
          preview: message.previewUrl || undefined,
          thumbnail: message.thumbnailUrl || undefined,
          playback: parsePlaybackVariants(message.playbackVariants),
          streaming: parseStreamingManifests(message.streamingManifests)
        },
        alt: message.alt || undefined,
        contentWarning: message.contentWarning || undefined,
        isSensitive: message.isSensitive === 'true',
        createdAt: new Date().toISOString()
      };

      await saveAsset(asset);
      await indexMediaAsset(asset, []);
    }

    const store = {
      assets: await loadAllAssets() as CanonicalAssetRecord[]
    };

    if (store.assets.length !== 1) {
      throw new Error(`Expected 1 canonical asset, found ${store.assets.length}`);
    }

    if (indexedDocuments.length !== 1) {
      throw new Error(`Expected 1 indexed document, found ${indexedDocuments.length}`);
    }

    const streamingManifests = store.assets[0].variants?.streaming || [];
    for (const manifest of streamingManifests) {
      await verifyStreamingManifest(manifest.protocol, manifest.url, storedObjects);
    }

    const projected = projectToActivityPubMedia(store.assets[0] as CanonicalAsset);
    const firstPartyProjected = projectToActivityPubMedia(
      store.assets[0] as CanonicalAsset,
      { deliveryProfile: 'first-party' }
    );
    if ((observedKind || options.expectedKind) === 'video' && projected.deliveryKind === 'streaming' && projected.url) {
      const projectedProtocol = projected.mediaType === 'application/dash+xml' ? 'dash' : 'hls';
      await verifyStreamingManifest(projectedProtocol, projected.url, storedObjects);
    }
    if ((observedKind || options.expectedKind) === 'video' && firstPartyProjected.deliveryKind === 'streaming' && firstPartyProjected.url) {
      const projectedProtocol = firstPartyProjected.mediaType === 'application/dash+xml' ? 'dash' : 'hls';
      await verifyStreamingManifest(projectedProtocol, firstPartyProjected.url, storedObjects);
    }

    verifyStoredObjectPolicies(store.assets[0] as CanonicalAsset, storedObjects, {
      immutableAssetCacheControl: config.immutableAssetCacheControl,
      streamingManifestCacheControl: config.streamingManifestCacheControl
    });

    return {
      assetId: store.assets[0].assetId,
      indexedCount: indexedDocuments.length,
      persistedCount: store.assets.length,
      mediaKind: observedKind || options.expectedKind || 'image',
      playbackVariantCount: store.assets[0].variants?.playback?.length || 0,
      streamingManifestCount: store.assets[0].variants?.streaming?.length || 0,
      streamingProtocols: streamingManifests.map((manifest) => manifest.protocol),
      projectedDeliveryKind: projected.deliveryKind,
      projectedMediaType: projected.mediaType,
      projectedUrl: projected.url,
      firstPartyProjectedDeliveryKind: firstPartyProjected.deliveryKind,
      firstPartyProjectedMediaType: firstPartyProjected.mediaType,
      firstPartyProjectedUrl: firstPartyProjected.url
    };
  } catch (err) {
    const source = sanitizeSourceForLogs(options.sourceUrl);
    if (err instanceof Error) {
      err.message = `[smoke-harness source=${source}] ${err.message}`;
    }
    throw err;
      }
    };

    const cleanup = async (): Promise<void> => {
      if (restoreEnv) {
        restoreEnv();
      }
      reloadConfigFromEnv?.();

      const closers: Array<Promise<void>> = [];
      if (s3Mock) {
        closers.push(closeServer(s3Mock.server));
      }
      if (openSearchMock) {
        closers.push(closeServer(openSearchMock.server));
      }

      await Promise.allSettled(closers);
      await rm(tmpDir, { recursive: true, force: true });
    };

    return {
      tmpDir,
      runPipeline,
      cleanup
    };
  } catch (error) {
    if (restoreEnv) {
      restoreEnv();
    }
    reloadConfigFromEnv?.();
    const closers: Array<Promise<void>> = [];
    if (s3Mock) {
      closers.push(closeServer(s3Mock.server));
    }
    if (openSearchMock) {
      closers.push(closeServer(openSearchMock.server));
    }
    await Promise.allSettled(closers);
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function verifyStreamingManifest(
  protocol: 'hls' | 'dash',
  manifestUrl: string,
  storedObjects: Map<string, StoredObjectRecord>
): Promise<void> {
  if (protocol === 'dash') {
    await verifyDashManifest(manifestUrl, storedObjects);
    return;
  }

  await verifyHlsManifest(manifestUrl, storedObjects);
}

async function verifyHlsManifest(
  manifestUrl: string,
  storedObjects: Map<string, StoredObjectRecord>
): Promise<void> {
  const masterResponse = await fetch(manifestUrl);
  if (!masterResponse.ok) {
    throw new Error(`Projected streaming manifest fetch failed: ${masterResponse.status}`);
  }

  const masterBody = await masterResponse.text();
  if (!masterBody.includes('#EXTM3U')) {
    throw new Error('Projected streaming manifest is missing EXT headers');
  }

  const firstVariantPath = masterBody
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!firstVariantPath) {
    throw new Error(`Projected streaming manifest does not contain any variant playlists body=${JSON.stringify(masterBody)}`);
  }

  const variantUrl = new URL(firstVariantPath, manifestUrl).toString();
  const variantResponse = await fetch(variantUrl);
  if (!variantResponse.ok) {
    throw new Error(`Projected variant playlist fetch failed: ${variantResponse.status} (${variantUrl}) firstVariantPath=${JSON.stringify(firstVariantPath)} masterBody=${JSON.stringify(masterBody)} available=${summarizeStoredObjectKeys(storedObjects, manifestUrl)}`);
  }

  const variantBody = await variantResponse.text();
  if (!variantBody.includes('#EXTM3U')) {
    throw new Error('Projected variant playlist is missing EXT headers');
  }

  const firstSegmentPath = variantBody
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!firstSegmentPath) {
    throw new Error(`Projected variant playlist does not contain any segments body=${JSON.stringify(variantBody)}`);
  }

  const segmentUrl = new URL(firstSegmentPath, variantUrl).toString();
  const segmentResponse = await fetch(segmentUrl);
  if (!segmentResponse.ok) {
    throw new Error(`Projected streaming segment fetch failed: ${segmentResponse.status} (${segmentUrl}) available=${summarizeStoredObjectKeys(storedObjects, variantUrl)}`);
  }

  const segmentBytes = await segmentResponse.arrayBuffer();
  if (segmentBytes.byteLength === 0) {
    throw new Error('Projected streaming segment is empty');
  }
}

async function verifyDashManifest(
  manifestUrl: string,
  storedObjects: Map<string, StoredObjectRecord>
): Promise<void> {
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`Projected DASH manifest fetch failed: ${manifestResponse.status}`);
  }

  const manifestBody = await manifestResponse.text();
  if (!manifestBody.includes('<MPD')) {
    throw new Error('Projected DASH manifest is missing MPD markup');
  }

  const representationId = manifestBody.match(/<Representation[^>]*id="([^"]+)"/)?.[1];
  const initializationTemplate = manifestBody.match(/initialization="([^"]+)"/)?.[1];
  const mediaTemplate = manifestBody.match(/media="([^"]+)"/)?.[1];
  if (!representationId || !initializationTemplate || !mediaTemplate) {
    throw new Error(`Projected DASH manifest is missing representation templates body=${JSON.stringify(manifestBody)}`);
  }

  const initUrl = new URL(resolveDashTemplate(initializationTemplate, representationId), manifestUrl).toString();
  const initResponse = await fetch(initUrl);
  if (!initResponse.ok) {
    throw new Error(`Projected DASH init segment fetch failed: ${initResponse.status} (${initUrl}) available=${summarizeStoredObjectKeys(storedObjects, manifestUrl)}`);
  }

  const mediaUrl = new URL(resolveDashTemplate(mediaTemplate, representationId), manifestUrl).toString();
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error(`Projected DASH media segment fetch failed: ${mediaResponse.status} (${mediaUrl}) available=${summarizeStoredObjectKeys(storedObjects, manifestUrl)}`);
  }

  const mediaBytes = await mediaResponse.arrayBuffer();
  if (mediaBytes.byteLength === 0) {
    throw new Error('Projected DASH media segment is empty');
  }
}

function summarizeStoredObjectKeys(
  storedObjects: Map<string, StoredObjectRecord>,
  candidateUrl: string
): string {
  try {
    const parsed = new URL(candidateUrl);
    const prefix = parsed.pathname.split('/').slice(0, -1).join('/');
    const matches = [...storedObjects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return JSON.stringify(matches.slice(0, 10));
  } catch {
    return '[]';
  }
}

function verifyStoredObjectPolicies(
  asset: CanonicalAsset,
  storedObjects: Map<string, StoredObjectRecord>,
  expected: {
    immutableAssetCacheControl: string;
    streamingManifestCacheControl: string;
  }
): void {
  const objectForUrl = (url: string | undefined) => {
    if (!url) {
      return undefined;
    }

    try {
      return storedObjects.get(new URL(url).pathname);
    } catch {
      return undefined;
    }
  };

  const requireStoredObject = (url: string | undefined, label: string): StoredObjectRecord => {
    const stored = objectForUrl(url);
    if (!stored) {
      throw new Error(`Expected stored object for ${label}`);
    }
    return stored;
  };

  const requireCacheControl = (
    url: string | undefined,
    label: string,
    expectedCacheControl: string
  ): void => {
    const stored = requireStoredObject(url, label);
    if (stored.cacheControl !== expectedCacheControl) {
      throw new Error(`Unexpected cache policy for ${label}: expected "${expectedCacheControl}", received "${stored.cacheControl || 'missing'}"`);
    }
    if (stored.contentDisposition !== 'inline') {
      throw new Error(`Unexpected content disposition for ${label}: expected inline, received "${stored.contentDisposition || 'missing'}"`);
    }
  };

  requireCacheControl(asset.canonicalUrl, 'canonical original', expected.immutableAssetCacheControl);
  if (asset.variants.preview) {
    requireCacheControl(asset.variants.preview, 'preview', expected.immutableAssetCacheControl);
  }
  if (asset.variants.thumbnail) {
    requireCacheControl(asset.variants.thumbnail, 'thumbnail', expected.immutableAssetCacheControl);
  }

  for (const playbackVariant of asset.variants.playback || []) {
    requireCacheControl(playbackVariant.url, `playback ${playbackVariant.label}`, expected.immutableAssetCacheControl);
  }

  for (const manifest of asset.variants.streaming || []) {
    requireCacheControl(manifest.url, `${manifest.protocol} master manifest`, expected.streamingManifestCacheControl);

    for (const variant of manifest.variants) {
      const expectedCacheControl = variant.url.endsWith('.m3u8') || variant.url.endsWith('.mpd')
        ? expected.streamingManifestCacheControl
        : expected.immutableAssetCacheControl;
      requireCacheControl(variant.url, `${manifest.protocol} variant ${variant.label}`, expectedCacheControl);
    }
  }

  for (const [storedKey, stored] of storedObjects.entries()) {
    if (storedKey.endsWith('.m3u8') || storedKey.endsWith('.mpd')) {
      if (stored.cacheControl !== expected.streamingManifestCacheControl) {
        throw new Error(`Unexpected cache policy for streaming manifest ${storedKey}: ${stored.cacheControl || 'missing'}`);
      }
      continue;
    }

    if (storedKey.endsWith('.ts') || storedKey.endsWith('.m4s')) {
      if (stored.cacheControl !== expected.immutableAssetCacheControl) {
        throw new Error(`Unexpected cache policy for streaming segment ${storedKey}: ${stored.cacheControl || 'missing'}`);
      }
    }
  }
}

function resolveDashTemplate(template: string, representationId: string): string {
  return template
    .replace(/\$RepresentationID\$/g, representationId)
    .replace(/\$Number%0(\d+)d\$/g, (_match, widthText) => String(1).padStart(Number(widthText), '0'))
    .replace(/\$Number\$/g, '1');
}

function decodeAwsChunkedPayload(body: Buffer, headers: http.IncomingHttpHeaders): Buffer {
  const contentEncoding = Array.isArray(headers['content-encoding'])
    ? headers['content-encoding'].join(',')
    : headers['content-encoding'] || '';
  if (!contentEncoding.includes('aws-chunked')) {
    return body;
  }

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset, 'utf8');
    if (lineEnd === -1) {
      throw new Error('Invalid aws-chunked payload: missing chunk header terminator');
    }

    const chunkHeader = body.toString('utf8', offset, lineEnd).trim();
    const chunkSize = Number.parseInt(chunkHeader.split(';', 1)[0], 16);
    if (!Number.isFinite(chunkSize)) {
      throw new Error(`Invalid aws-chunked payload: invalid chunk size ${chunkHeader}`);
    }

    offset = lineEnd + 2;
    if (chunkSize === 0) {
      return Buffer.concat(chunks);
    }

    const chunkEnd = offset + chunkSize;
    chunks.push(body.subarray(offset, chunkEnd));
    offset = chunkEnd + 2;
  }

  throw new Error('Invalid aws-chunked payload: missing terminating chunk');
}
