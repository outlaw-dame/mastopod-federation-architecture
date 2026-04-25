import { fetch } from 'undici';
import { deleteFromFilebase, headFilebaseObject } from '../src/storage/filebaseClient';
import { objectKeyFromCanonicalMediaUrl } from '../src/storage/cdnUrlBuilder';
import { reconcileCanonicalAssets } from '../src/repair/reconcileCanonicalAssets';
import { withSmokeHarnessEnvironment } from './lib/smokeHarness';
import { createVideoSmokeFixtureServer } from './lib/videoSmokeFixture';
import { closeFixtureServer } from './lib/staticFixtureServer';

async function main(): Promise<void> {
  let scratchDir: string | undefined;
  let mediaMock: Awaited<ReturnType<typeof createVideoSmokeFixtureServer>>['mediaMock'] | undefined;

  try {
    const fixture = await createVideoSmokeFixtureServer();
    scratchDir = fixture.scratchDir;
    mediaMock = fixture.mediaMock;

    await withSmokeHarnessEnvironment({
      sourceUrl: mediaMock.url,
      runSsrfValidation: false,
      expectedKind: 'video'
    }, async ({ runPipeline }) => {
      const initial = await runPipeline();
      const auditBefore = await reconcileCanonicalAssets({ auditOnly: true, assetId: initial.assetId });
      const before = auditBefore.results[0];
      if (!before || before.status !== 'unchanged') {
        throw new Error(`Expected clean asset before induced drift, received ${before?.status || 'missing'}`);
      }

      await deleteRequiredArtifacts(initial);

      const auditAfterDelete = await reconcileCanonicalAssets({ auditOnly: true, assetId: initial.assetId });
      const deleted = auditAfterDelete.results[0];
      if (!deleted || deleted.status !== 'needs-repair') {
        throw new Error(`Expected needs-repair after deletion, received ${deleted?.status || 'missing'}`);
      }

      const repair = await reconcileCanonicalAssets({ assetId: initial.assetId });
      const repaired = repair.results[0];
      if (!repaired || repaired.status !== 'repaired') {
        throw new Error(`Expected repaired result, received ${repaired?.status || 'missing'}`);
      }

      await verifyRestoredArtifacts(initial);
      console.log(`assetId=${initial.assetId}`);
      console.log(`repairs=${repaired.repairs.join(',')}`);
      console.log(`streamingProtocols=${initial.streamingProtocols.join(',')}`);
    });
  } finally {
    if (mediaMock) {
      await closeFixtureServer(mediaMock.server);
    }
    if (scratchDir) {
      await import('node:fs/promises').then(({ rm }) =>
        rm(scratchDir!, { recursive: true, force: true })
      );
    }
  }
}

async function deleteRequiredArtifacts(result: {
  projectedUrl?: string;
  firstPartyProjectedUrl?: string;
}): Promise<void> {
  const urlsToDelete = [result.projectedUrl, result.firstPartyProjectedUrl].filter((value): value is string => Boolean(value));
  if (urlsToDelete.length === 0) {
    throw new Error('No projected media URLs were available to delete for reconcile smoke');
  }

  for (const url of urlsToDelete) {
    const key = objectKeyFromCanonicalMediaUrl(url);
    if (!key) {
      throw new Error(`Projected URL ${url} could not be mapped to an object key`);
    }

    await deleteFromFilebase(key);
  }
}

async function verifyRestoredArtifacts(result: {
  projectedUrl?: string;
  firstPartyProjectedUrl?: string;
}): Promise<void> {
  const urls = [result.projectedUrl, result.firstPartyProjectedUrl].filter((value): value is string => Boolean(value));
  for (const url of urls) {
    const key = objectKeyFromCanonicalMediaUrl(url);
    if (!key) {
      throw new Error(`Restored URL ${url} could not be mapped to an object key`);
    }

    const metadata = await headFilebaseObject(key);
    if (!metadata.exists) {
      throw new Error(`Expected restored object ${key} to exist`);
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Expected restored URL ${url} to be fetchable, received ${response.status}`);
    }
  }
}

main().catch((error) => {
  console.error('smokeRuntimeReconcile failed');
  console.error(error);
  process.exit(1);
});
