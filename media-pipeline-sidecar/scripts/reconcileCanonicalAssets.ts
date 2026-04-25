#!/usr/bin/env tsx

import { reconcileCanonicalAssets } from '../src/repair/reconcileCanonicalAssets';

interface ScriptOptions {
  auditOnly: boolean;
  assetId?: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await reconcileCanonicalAssets(options);

  for (const result of summary.results) {
    if (result.status === 'needs-repair') {
      console.log(`needs-repair asset=${result.assetId} repairs=${result.repairs.join(',')}`);
      continue;
    }

    if (result.status === 'repaired') {
      console.log(`repaired asset=${result.assetId} repairs=${result.repairs.join(',')}`);
      continue;
    }

    if (result.status === 'unrecoverable') {
      console.log(`unrecoverable asset=${result.assetId} reason=${result.reason || 'unknown'}`);
      continue;
    }
  }

  console.log('reconcile-canonical-assets complete');
  console.log(`assets=${summary.assets}`);
  console.log(`needsRepair=${summary.needsRepair}`);
  console.log(`repaired=${summary.repaired}`);
  console.log(`unchanged=${summary.unchanged}`);
  console.log(`unrecoverable=${summary.unrecoverable}`);
  console.log(`mode=${summary.mode}`);

  if (summary.unrecoverable > 0 || (options.auditOnly && summary.needsRepair > 0)) {
    process.exitCode = 1;
  }
}

function parseOptions(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    auditOnly: false
  };

  for (const arg of argv) {
    if (arg === '--audit') {
      options.auditOnly = true;
      continue;
    }

    if (arg.startsWith('--asset-id=')) {
      options.assetId = arg.slice('--asset-id='.length).trim() || undefined;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

main().catch((error) => {
  console.error('reconcile-canonical-assets failed');
  console.error(error);
  process.exit(1);
});
