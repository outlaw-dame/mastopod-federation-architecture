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
    expect(sidecar?.extra_hosts).toEqual(["activitypods-internal:host-gateway"]);
  });
});
