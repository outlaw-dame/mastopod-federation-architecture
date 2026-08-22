import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import {
  OpenSearchBootstrapService,
  type OpenSearchBootstrapConfig,
} from '../src/search/service/OpenSearchBootstrapService.js';
import {
  DefaultOpenSearchAuthorClient,
  DefaultOpenSearchClient,
} from '../src/search/writer/OpenSearchClient.js';

const url = process.env['OPENSEARCH_URL'] ?? 'http://127.0.0.1:19200';
const native = new OpenSearchNativeClient({ node: url });

const bootstrapConfig: OpenSearchBootstrapConfig = {
  opensearchUrl: url,
  opensearchSslVerify: false,
  maxRetries: 10,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 2_000,
  bootstrapTimeoutMs: 60_000,
};

const bootstrap = new OpenSearchBootstrapService(bootstrapConfig);
const contentStore = new DefaultOpenSearchClient(native);
const authorStore = new DefaultOpenSearchAuthorClient(native);

try {
  const info = await native.info();
  const version = String(info.body?.version?.number ?? '');
  assert(version.startsWith('3.8.'), `expected OpenSearch 3.8.x, got ${version}`);

  await bootstrap.bootstrap();

  const mappingResponse = await native.indices.getMapping({ index: 'public-content-v1' });
  const contentMapping = mappingResponse.body?.['public-content-v1']?.mappings as any;
  assert(contentMapping, 'public-content-v1 mapping missing');
  assert(contentMapping.properties?.embedding === undefined, 'active mapping must not contain embedding');
  assert(contentMapping.properties?.embeddingStatus === undefined, 'active mapping must not contain embeddingStatus');
  assert(contentMapping.properties?.embeddingUpdatedAt === undefined, 'active mapping must not contain embeddingUpdatedAt');

  const settingsResponse = await native.indices.getSettings({ index: 'public-content-v1' });
  const indexSettings = settingsResponse.body?.['public-content-v1']?.settings?.index as Record<string, unknown> | undefined;
  assert(indexSettings, 'public-content-v1 settings missing');
  assert(indexSettings['knn'] !== 'true', 'active index must not enable k-NN');
  assert(indexSettings['default_pipeline'] === undefined, 'active index must not require an ingest pipeline');

  const now = new Date().toISOString();
  await contentStore.upsert('os3-doc-1', {
    stableDocId: 'os3-doc-1',
    canonicalContentId: 'https://example.test/posts/os3-doc-1',
    protocolPresence: ['activitypub'],
    sourceKind: 'remote',
    author: {
      canonicalId: 'os3-author-1',
      apUri: 'https://example.test/users/os3-author-1',
      displayName: 'OS3 Search Author',
    },
    text: 'OS3 lexical compatibility sentinel kiwi-orbit',
    createdAt: now,
    indexedAt: now,
    langs: ['en'],
    tags: ['os3'],
    hasMedia: false,
    mediaCount: 0,
    engagement: { likeCount: 0, repostCount: 0, replyCount: 0 },
    isDeleted: false,
  });

  await authorStore.upsert('os3-author-1', {
    stableAuthorId: 'os3-author-1',
    canonicalAccountId: 'os3-author-1',
    apUri: 'https://example.test/users/os3-author-1',
    handle: 'os3-author@example.test',
    displayName: 'OS3 Search Author',
    summaryText: 'OpenSearch 3.8 smoke fixture',
    labels: [],
    langs: ['en'],
    searchConsentPublic: true,
    searchConsentExplicit: true,
    searchConsentSource: 'fixture',
    protocolPresence: ['activitypub'],
    sourceKind: 'remote',
    updatedAt: now,
  } as any);

  await native.indices.refresh({ index: 'public-content-v1,public-author-v1' });

  const stored = await contentStore.get('os3-doc-1');
  assert(stored?.text?.includes('kiwi-orbit'), 'content wrapper failed round-trip');

  const author = await authorStore.get('os3-author-1');
  assert(author?.displayName === 'OS3 Search Author', 'author wrapper failed round-trip');

  const lexical = await native.search({
    index: 'public-content-v1',
    body: {
      size: 5,
      query: {
        bool: {
          must: [{ match: { text: 'kiwi-orbit' } }],
          filter: [{ term: { isDeleted: false } }],
        },
      },
    },
  });
  const lexicalIds = (lexical.body?.hits?.hits ?? []).map((hit: any) => String(hit._id));
  assert(lexicalIds.includes('os3-doc-1'), 'lexical query did not return smoke document');

  await contentStore.updateScripted(
    'os3-doc-1',
    'ctx._source.engagement.likeCount += params.likeDelta',
    { likeDelta: 2 },
  );
  await native.indices.refresh({ index: 'public-content-v1' });
  const updated = await contentStore.get('os3-doc-1');
  assert(updated?.engagement?.likeCount === 2, 'scripted update failed');

  await contentStore.delete('os3-doc-1');
  await authorStore.delete('os3-author-1');
  await native.indices.refresh({ index: 'public-content-v1,public-author-v1' });
  assert((await contentStore.get('os3-doc-1')) === null, 'content delete failed');
  assert((await authorStore.get('os3-author-1')) === null, 'author delete failed');

  console.log(JSON.stringify({
    openSearchVersion: version,
    lexicalQuery: 'passed',
    contentCrud: 'passed',
    authorCrud: 'passed',
    scriptedUpdate: 'passed',
    vectorFieldsPresent: false,
    defaultPipelinePresent: false,
  }, null, 2));
} finally {
  await bootstrap.close().catch(() => undefined);
  await native.close().catch(() => undefined);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
