import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../activitypods-integration/scripts/bootstrap-local-dev.sh", import.meta.url),
);
const source = readFileSync(bootstrapPath, "utf8");

function sourceIndex(fragment: string): number {
  const index = source.indexOf(fragment);
  expect(index, `expected bootstrap source to contain ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("integrated ActivityPods federation authority profile", () => {
  it("selects one explicit sidecar external preview authority for local development", () => {
    expect(source).toContain("NODE_ENV=development");
    expect(source).toContain("SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external");
    expect(source).toContain("SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true");
    expect(source).toContain("SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=false");
  });

  it("uses the host-local durable handoff endpoint because both processes run on the host", () => {
    expect(source).toContain(
      "SIDECAR_DELIVERY_HANDOFF_URL=http://127.0.0.1:8080/webhook/outbox",
    );
    expect(source).not.toContain(
      "SIDECAR_DELIVERY_HANDOFF_URL=http://fedify-sidecar:8080/webhook/outbox\n  export",
    );
  });

  it("exports the authority variables into the ActivityPods process environment", () => {
    for (const variable of [
      "NODE_ENV",
      "SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE",
      "SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW",
      "SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER",
      "SIDECAR_DELIVERY_HANDOFF_URL",
      "SIDECAR_TOKEN",
    ]) {
      expect(source).toContain(`export ${variable}`);
    }
  });

  it("starts the canonical sidecar before ActivityPods to avoid avoidable handoff retries", () => {
    const sidecarStart = sourceIndex('start_bg_if_needed "Fedify sidecar"');
    const activityPodsStart = sourceIndex('start_bg_if_needed "ActivityPods backend"');
    expect(sidecarStart).toBeLessThan(activityPodsStart);
  });
});
