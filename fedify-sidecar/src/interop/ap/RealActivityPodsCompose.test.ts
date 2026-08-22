import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  environment?: Record<string, string>;
  extra_hosts?: string[];
}

interface ComposeOverlay {
  services?: Record<string, ComposeService>;
}

describe("real ActivityPods sidecar compose authority", () => {
  it("uses a dedicated single-label alias for the host-only signing recorder", () => {
    const overlay = parse(readFileSync(
      resolve("interop/ap/docker-compose.real-activitypods.yml"),
      "utf8",
    )) as ComposeOverlay;
    const sidecar = overlay.services?.["fedify-sidecar"];

    expect(sidecar?.environment?.["ACTIVITYPODS_URL"]).toBe("http://activitypods-internal:3001");
    expect(sidecar?.environment?.["SIDECAR_STARTUP_MODE"]).toBe("blocking");
    expect(sidecar?.environment?.["ENABLE_FEP_3AB2_STREAMING"]).toBe("false");
    expect(sidecar?.extra_hosts).toEqual([
      "activitypods-internal:${AP_SIGNING_PROXY_DOCKER_HOST:-host-gateway}",
    ]);
  });

  it("keeps the recorder on the validated private bridge and bootstraps governed topics", () => {
    const workflow = readFileSync(
      resolve("../.github/workflows/activitypub-real-two-mode-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("Signing proxy must bind only to the private Docker gateway");
    expect(workflow).toContain("ps -aq ap-proof-router");
    expect(workflow).toContain("ActivityPub proof router container is unavailable");
    expect(workflow).toContain(
      'echo "AP_SIGNING_PROXY_DOCKER_HOST=${signing_proxy_host}" >> "${GITHUB_ENV}"',
    );
    expect(workflow).toContain("run --rm --no-deps fedify-sidecar npm run topics:bootstrap");
    expect(workflow).not.toContain("AP_SIGNING_PROXY_HOST=0.0.0.0");
  });
});
