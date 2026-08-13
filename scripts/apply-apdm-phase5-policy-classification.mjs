import fs from 'node:fs';

function replaceOnce(path, before, after) {
  let text = fs.readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`Missing anchor in ${path}: ${before.slice(0, 100)}`);
  text = text.replace(before, after);
  fs.writeFileSync(path, text);
}

replaceOnce(
  'fedify-sidecar/src/delivery/outbound-worker.ts',
  'import { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";',
  'import { isUnsafeActivityPubTargetError, secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
);
replaceOnce(
  'fedify-sidecar/src/delivery/outbound-worker.ts',
  '    } catch (err: any) {\n      if (err instanceof OutboundResidenceExpiredError) throw err;\n      return {\n        jobId: job.jobId,\n        success: false,\n        error: `Network error: ${sanitizeErrorText(err?.message ?? err)}`,\n        permanent: false,',
  '    } catch (err: any) {\n      if (err instanceof OutboundResidenceExpiredError) throw err;\n      const unsafeTarget = isUnsafeActivityPubTargetError(err);\n      return {\n        jobId: job.jobId,\n        success: false,\n        error: `${unsafeTarget ? "Unsafe target" : "Network error"}: ${sanitizeErrorText(err?.message ?? err)}`,\n        permanent: unsafeTarget,'
);

replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  'import { secureActivityPubRequest } from "../security/activitypub-egress-policy.js";',
  'import { isUnsafeActivityPubTargetError, secureActivityPubRequest } from "../security/activitypub-egress-policy.js";'
);
replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  '    } catch (error) {\n      return {\n        jobId: input.jobId,\n        success: false,\n        error: `Network error: ${error instanceof Error ? error.message : String(error)}`,\n        permanent: false,\n      };\n    }\n  }',
  '    } catch (error) {\n      const unsafeTarget = isUnsafeActivityPubTargetError(error);\n      return {\n        jobId: input.jobId,\n        success: false,\n        error: `${unsafeTarget ? "Unsafe target" : "Network error"}: ${error instanceof Error ? error.message : String(error)}`,\n        permanent: unsafeTarget,\n      };\n    }\n  }'
);
replaceOnce(
  'fedify-sidecar/src/federation/FedifyFederationAdapter.ts',
  '    } catch (err) {\n      return {\n        jobId: input.jobId,\n        success: false,\n        error: `Network error (local-signed): ${err instanceof Error ? err.message : String(err)}`,\n        permanent: false,\n      };\n    }\n  }',
  '    } catch (err) {\n      const unsafeTarget = isUnsafeActivityPubTargetError(err);\n      return {\n        jobId: input.jobId,\n        success: false,\n        error: `${unsafeTarget ? "Unsafe target" : "Network error (local-signed)"}: ${err instanceof Error ? err.message : String(err)}`,\n        permanent: unsafeTarget,\n      };\n    }\n  }'
);

console.log('Unsafe-target classification wiring applied.');
