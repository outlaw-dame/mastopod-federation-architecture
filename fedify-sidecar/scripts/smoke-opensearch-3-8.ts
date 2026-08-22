import { Client as OpenSearchNativeClient } from '@opensearch-project/opensearch';
import {
  OpenSearchBootstrapService,
  type OpenSearchBootstrapConfig,
} from '../src/search/service/OpenSearchBootstrapService.js';
import { PublicContentMapping } from '../src/search/mappings/PublicContentMapping.js';
import {
  DefaultOpenSearchAuthorClient,
  DefaultOpenSearchClient,
} from '../src/search/writer/OpenSearchClient.js';
import { PublicContentIndexWriter } from '../src/search/writer/PublicContentIndexWriter.js';
import { InMemorySearchDocAliasCache } from '../src/search/writer/SearchDocAliasCache.js';
import { DefaultSearchDedupService } from '../src/search/aliases/SearchDedupService.js';

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
const aliasCache = new InMemorySearchDocAliasCache();
const contentWriter = new PublicContentIndexWriter(
  contentStore,
  aliasCache,
  new DefaultSearchDedupService(aliasCache),
);

try {
  const info = await native.info();
  const version = String(info.body?.version?.number ?? '');
  assert(version.startsWith('3.8.'), `expected OpenSearch 3.8.x, got ${version}`);

  await bootstrap.bootstrap();
  await assertFreshLexicalMapping();
  await exerciseRepositoryWriterAndClients();
  await assertLegacyPipelineMigration();

  console.log(JSON.stringify({
    openSearchVersion: version,
    realContentWriter: 'passed',
    lexicalQuery: 'passed',
    contentCrud: 'passed',
    authorCrud: 'passed',
    scriptedUpdate: 'passed',
    vectorFieldsPresent: false,
    freshDefaultPipelinePresent: false,
    legacyDefaultPipelineCleared: true,
  }, null, 2));
} finally {
  await bootstrap.close().catch(() => undefined);
  await native.close().catch(() => undefined);
}

async function assertFreshLexicalMapping(): Promise<void> {
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
  assert(indexSettings['default_pipeline'] === undefined, 'fresh active index must not require an ingest pipeline');
}

async function exerciseRepositoryWriterAndClients(): Promise<void> {
  const now = new Date().toISOString();

  // Use the real writer rather than a hand-built store upsert. This is the
  // contract that caught the OS3 review regression where embeddingStatus was
  // still projected into the new strict lexical-only mapping.
  await contentWriter.onUpsert({
    upsertKind: 'full',
    stableDocId: 'os3-doc-1',
    // Match the test's expected stable ID while still exercising the writer's
    // canonical-ID preference in DefaultSearchDedupService.
    canonicalContentId: 'os3-doc-1',
    protocolSource: 'ap',
    sourceKind: 'remote',
    ap: { objectUri: 'https://example.test/posts/os3-doc-1' },
    author: {
      canonicalId: 'os3-author-1',
      apUri: 'https://example.test/users/os3-author-1',
    },
    content: {
      text: 'OS3 lexical compatibility sentinel kiwi-orbit',
      createdAt: now,
      langs: ['en'],
      tags: ['os3'],
    },
    media: { hasMedia: false, mediaCount: 0 },
    indexedAt: now,
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
  assert(stored?.text?.includes('kiwi-orbit'), 'content writer failed round-trip');
  assert((stored as any).embeddingStatus === undefined, 'real writer reintroduced embeddingStatus');
  assert((stored as any).embedding === undefined, 'real writer reintroduced embedding');

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

  await contentWriter.onPartialUpdate({
    stableDocId: 'os3-doc-1',
    updateKind: 'engagement_delta',
    deltas: { likeCount: 2 },
    indexedAt: new Date().toISOString(),
  });
  await native.indices.refresh({ index: 'public-content-v1' });
  const updated = await contentStore.get('os3-doc-1');
  assert(updated?.engagement?.likeCount === 2, 'writer scripted update failed');

  await contentWriter.onDelete({
    stableDocId: 'os3-doc-1',
    reason: 'moderation',
    deleteMode: 'hard',
    deletedAt: new Date().toISOString(),
  });
  await authorStore.delete('os3-author-1');
  await native.indices.refresh({ index: 'public-content-v1,public-author-v1' });
  assert((await contentStore.get('os3-doc-1')) === null, 'writer content delete failed');
  assert((await authorStore.get('os3-author-1')) === null, 'author delete failed');
}

async function assertLegacyPipelineMigration(): Promise<void> {
  await native.indices.delete({ index: 'public-content-v1' });
  await native.ingest.putPipeline({
    id: 'os3-legacy-embedding-pipeline',
    body: {
      description: 'OS3 migration smoke legacy pipeline',
      processors: [{ set: { field: 'embeddingStatus', value: 'legacy-pipeline-ran' } }],
    },
  });

  await native.indices.create({
    index: 'public-content-v1',
    body: {
      settings: {
        ...PublicContentMapping.settings,
        index: {
          ...PublicContentMapping.settings.index,
          default_pipeline: 'os3-legacy-embedding-pipeline',
        },
      },
      mappings: PublicContentMapping.mappings,
    },
  });

  const before = await native.indices.getSettings({ index: 'public-content-v1' });
  const beforePipeline = before.body?.['public-content-v1']?.settings?.index?.['default_pipeline'];
  assert(beforePipeline === 'os3-legacy-embedding-pipeline', 'failed to construct legacy default-pipeline fixture');

  await bootstrap.bootstrap();

  const after = await native.indices.getSettings({ index: 'public-content-v1' });
  const afterPipeline = after.body?.['public-content-v1']?.settings?.index?.['default_pipeline'];
  assert(afterPipeline === '_none', `legacy default pipeline was not disabled; got ${String(afterPipeline)}`);

  await contentWriter.onUpsert({
    upsertKind: 'full',
    stableDocId: 'os3-migrated-doc',
    protocolSource: 'ap',
    sourceKind: 'remote',
    author: { canonicalId: 'os3-migrated-author' },
    content: {
      text: 'migration sentinel',
      createdAt: new Date().toISOString(),
    },
    indexedAt: new Date().toISOString(),
  });
  await native.indices.refresh({ index: 'public-content-v1' });
  const migrated = await contentStore.get('os3-migrated-doc');
  assert(migrated, 'migrated content writer failed');
  assert((migrated as any).embeddingStatus === undefined, 'legacy ingest pipeline still mutated new content');

  await native.ingest.deletePipeline({ id: 'os3-legacy-embedding-pipeline' });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
