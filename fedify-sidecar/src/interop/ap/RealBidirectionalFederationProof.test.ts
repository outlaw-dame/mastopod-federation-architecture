import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("real bidirectional ActivityPub federation proof", () => {
  it("requires both the remote Follow persistence and returning Accept state transition", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("Prove native bidirectional federation and remote persistence");
    expect(workflow).toContain("Prove sidecar bidirectional federation, remote persistence, and real ActivityPods signer");
    expect(workflow).toContain("native-bidirectional.json");
    expect(workflow).toContain("external-bidirectional.json");
    expect(workflow).toContain("nativeBidirectional?.returnAcceptApplied === true");
    expect(workflow).toContain("nativeBidirectional?.followingContainsRemote === true");
    expect(workflow).toContain("externalBidirectional?.returnAcceptApplied === true");
    expect(workflow).toContain("externalBidirectional?.followingContainsRemote === true");
    expect(workflow).toContain("externalBidirectional?.sidecarInboundAcceptObserved === true");
    expect(workflow).toContain("activitypods.activitypub.real-multi-implementation.v2");
  });

  it("does not confuse the remote fixture username with the local ActivityPods dataset", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );
    const helper = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/assert-real-return-accept.mjs"),
      "utf8",
    );

    expect(workflow).toContain('"${TARGET_USERNAME}" "${persisted_count}"');
    expect(helper).toContain("<remote-username> <persisted-follow-count>");
    expect(helper).toContain("localUsername: origin.senderUsername");
    expect(helper).toContain("remoteUsername,");
    expect(helper).not.toContain("origin.senderUsername !== localUsername");
    expect(helper).toContain("encodeURIComponent(origin.senderUsername)");
  });

  it("runs the real external return leg through the existing sidecar inbound worker", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );
    const caddy = readFileSync(
      resolve(process.cwd(), "interop/ap/caddy/Caddyfile.real-activitypods"),
      "utf8",
    );
    const proxy = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/activitypods-signing-recording-proxy.mjs"),
      "utf8",
    );

    expect(workflow).toContain("ENABLE_INBOUND_WORKER=true");
    expect(workflow).not.toContain("ENABLE_INBOUND_WORKER=false ENABLE_ORIGIN_RECONCILIATION=false");
    expect(caddy).toContain("method POST");
    expect(caddy).toContain("path_regexp actor_inbox ^/(users/)?[^/]+/inbox/?$");
    expect(caddy).toContain("reverse_proxy host.docker.internal:8080 host.docker.internal:3000");
    expect(proxy).toContain("return 'inbound'");
    expect(proxy).toContain("the sidecar Redis");
    expect(proxy).not.toContain("schema: 'ap.real-inbound-api-call.v1'");
  });

  it("matches the returning Accept to the exact remote actor and outgoing Follow", () => {
    const helper = "interop/ap/scripts/assert-real-return-accept.mjs";
    const result = spawnSync(process.execPath, [helper, "--self-test"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
    expect(result.stderr).toBe("");
  });
});
