import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetch } from 'undici';

interface SmokeHarnessOptions {
  sourceUrl: string;
  runSsrfValidation: boolean;
  expectedKind?: 'image' | 'video';
  requestTimeoutMs?: number;
  maxDownloadBytes?: number;
}

interface CanonicalAssetRecord {
  assetId: string;
}

interface QueueMessage {
  [key: string]: string;
}

export interface SmokeHarnessResult {
  assetId: string;
  indexedCount: number;
  persistedCount: number;
  mediaKind: 'image' | 'video';
}

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

export async function runSmokeHarness(options: SmokeHarnessOptions): Promise<SmokeHarnessResult> {
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  const maxDownloadBytes = options.maxDownloadBytes ?? 10 * 1024 * 1024;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'media-pipeline-smoke-'));
  const indexedDocuments: unknown[] = [];

  let s3Mock: { server: http.Server; port: number } | undefined;
  let openSearchMock: { server: http.Server; port: number } | undefined;
  let restoreEnv: (() => void) | undefined;

  try {
    s3Mock = await createServer(async (req, res) => {
      if (req.method !== 'PUT') {
        res.statusCode = 405;
        res.end('method-not-allowed');
        return;
      }

      for await (const _chunk of req) {
        // consume body
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/xml');
      res.end('<PutObjectResult/>');
    });

    openSearchMock = await createServer(async (req, res) => {
      if (req.method !== 'PUT') {
        res.statusCode = 405;
        res.end('method-not-allowed');
        return;
      }

      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
      }

      indexedDocuments.push(JSON.parse(body));
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: 'created' }));
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
      REQUEST_TIMEOUT_MS: String(timeoutMs)
    });

    const [
      { retryAsync },
      { assertSafeRemoteUrl },
      { validateMediaPayload },
      { processImage, sha256 },
      { processVideo },
      { generateBlurPreview },
      { uploadToFilebase },
      { buildCanonicalMediaUrl, buildGatewayUrl },
      { loadAllAssets, saveAsset },
      { indexMediaAsset }
    ] = await Promise.all([
      import('../../src/utils/retry'),
      import('../../src/security/ssrfGuard'),
      import('../../src/ingest/mimeValidation'),
      import('../../src/processing/image'),
      import('../../src/processing/video'),
      import('../../src/processing/blurPreview'),
      import('../../src/storage/filebaseClient'),
      import('../../src/storage/cdnUrlBuilder'),
      import('../../src/storage/assetStore'),
      import('../../src/indexing/openSearchMediaIndexer')
    ]);

    const ingestQueue: QueueMessage[] = [];
    const fetchQueue: QueueMessage[] = [];
    const processImageQueue: QueueMessage[] = [];
    const processVideoQueue: QueueMessage[] = [];
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
        contentType: 'image/webp'
      });

      const preview = await uploadToFilebase({
        key: previewKey,
        body: blurPreview,
        contentType: 'image/webp'
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
      const processed = await processVideo(input, message.mimeType);

      const fileHash = sha256(processed.buffer);
      const extension = processed.mimeType === 'video/webm'
        ? 'webm'
        : processed.mimeType === 'video/quicktime'
          ? 'mov'
          : 'mp4';

      const original = await uploadToFilebase({
        key: `${fileHash}.${extension}`,
        body: processed.buffer,
        contentType: processed.mimeType
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
        previewUrl: '',
        thumbnailUrl: '',
        mimeType: processed.mimeType,
        size: String(processed.buffer.byteLength),
        width: '',
        height: '',
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
          thumbnail: message.thumbnailUrl || undefined
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

    return {
      assetId: store.assets[0].assetId,
      indexedCount: indexedDocuments.length,
      persistedCount: store.assets.length,
      mediaKind: observedKind || options.expectedKind || 'image'
    };
  } catch (err) {
    const source = sanitizeSourceForLogs(options.sourceUrl);
    if (err instanceof Error) {
      err.message = `[smoke-harness source=${source}] ${err.message}`;
    }
    throw err;
  } finally {
    if (restoreEnv) {
      restoreEnv();
    }

    const closers: Array<Promise<void>> = [];
    if (s3Mock) {
      closers.push(closeServer(s3Mock.server));
    }
    if (openSearchMock) {
      closers.push(closeServer(openSearchMock.server));
    }

    await Promise.allSettled(closers);
    await rm(tmpDir, { recursive: true, force: true });
  }
}
