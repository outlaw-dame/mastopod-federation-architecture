import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  environment?: Record<string, string>;
  extra_hosts?: string[];
  depends_on?: Record<string, unknown>;
  networks?: Record<string, { aliases?: string[]; ipv4_address?: string }> | string[];
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
    expect(sidecar?.environment?.["ACTIVITYPODS_PUBLIC_URL"]).toBe("https://activitypods");
    expect(sidecar?.environment?.["SIDECAR_STARTUP_MODE"]).toBe("blocking");
    expect(sidecar?.environment?.["ENABLE_FEP_3AB2_STREAMING"]).toBe("false");
    expect(sidecar?.extra_hosts).toEqual([
      "activitypods-internal:${AP_SIGNING_PROXY_DOCKER_HOST:-host-gateway}",
    ]);
  });

  it("publishes the relay actor on the exact TLS authority used by its local signer", () => {
    const overlay = parse(readFileSync(
      resolve("interop/ap/docker-compose.real-activitypods.yml"),
      "utf8",
    )) as ComposeOverlay;
    const sidecar = overlay.services?.["fedify-sidecar"];
    const router = overlay.services?.["ap-proof-router"];
    const recorder = overlay.services?.["mastodon-wire-recorder"];

    expect(sidecar?.environment?.["DOMAIN"]).toBe("sidecar");
    expect(sidecar?.environment?.["AP_RELAY_LOCAL_ACTOR_URI"]).toBe("https://sidecar/users/relay");
    expect(sidecar?.environment?.["ENABLE_FEDIFY_RUNTIME_INTEGRATION"]).toBe("true");
    expect(sidecar?.environment?.["ATPROTO_PASSWORD_VERIFY_TOKEN"]).toBe(
      "${ATPROTO_PASSWORD_VERIFY_TOKEN:-}",
    );

    expect(router?.depends_on?.["mastodon-wire-recorder"]).toBeDefined();
    expect(router?.environment?.["ACTIVITYPODS_RETURN_HOST"]).toBe(
      "${ACTIVITYPODS_RETURN_HOST:-host.docker.internal}",
    );
    expect(router?.environment?.["ACTIVITYPODS_RETURN_PORT"]).toBe(
      "${ACTIVITYPODS_RETURN_PORT:-3000}",
    );
    expect(router?.networks).not.toBeInstanceOf(Array);
    if (router?.networks && !Array.isArray(router.networks)) {
      expect(router.networks["ap-interop"]?.ipv4_address).toBe("172.31.240.254");
      expect(router.networks["ap-interop"]?.aliases).toContain("sidecar");
      expect(router.networks["ap-interop"]?.aliases).toContain("mastodon");
      expect(router.networks["ap-interop"]?.aliases).toContain("activitypods");
    }

    expect(recorder?.environment?.["AP_WIRE_RECORDER_UPSTREAM"]).toBe(
      "http://mastodon-web-app:3000",
    );
    expect(recorder?.environment?.["AP_WIRE_RECORDER_EVIDENCE_PATH"]).toBe(
      "/evidence/mastodon.jsonl",
    );
  });

  it("keeps the recorder on the validated private bridge and bootstraps governed topics", () => {
    const workflow = readFileSync(
      resolve("../.github/workflows/activitypub-real-two-mode-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("resolve-private-docker-gateway.mjs");
    expect(workflow).toContain("ps -aq ap-proof-router");
    expect(workflow).toContain("ActivityPub proof router container is unavailable");
    expect(workflow).toContain(
      'echo "AP_SIGNING_PROXY_DOCKER_HOST=${signing_proxy_host}" >> "${GITHUB_ENV}"',
    );
    expect(workflow).toContain("run --rm --no-deps fedify-sidecar npm run topics:bootstrap");
    expect(workflow).toContain("AP_INTEROP_ENABLE_INBOUND_WORKER=true docker compose");
    expect(workflow).toContain("ACTIVITYPODS_RETURN_HOST=fedify-sidecar ACTIVITYPODS_RETURN_PORT=8080");
    expect(workflow).not.toContain("AP_SIGNING_PROXY_HOST=0.0.0.0");
    expect(workflow).toContain("Reset ActivityPods state between authority modes");
    expect(workflow).toContain("sudo rm -rf data/fuseki_test data/redis_test");
  });

  it("requires direct wire evidence for native, ActivityPods-signed external, and sidecar-service delivery", () => {
    const workflow = readFileSync(
      resolve("../.github/workflows/activitypub-real-two-mode-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("configure-proof-router-hosts.sh mastodon activitypods sidecar");
    expect(workflow).toContain("Assert native wire signature authority");
    expect(workflow).toContain("Assert external wire signature matches the ActivityPods signing result");
    expect(workflow).toContain("Prove sidecar-owned service actor federates with its local key");
    expect(workflow).toContain("assert-real-wire-signature.mjs");
    expect(workflow).toContain("prove-sidecar-service-actor.mjs");
    expect(workflow).toContain("activityPodsSigningApiCalls: 0");
    expect(workflow).not.toMatch(/Assert Mastodon accepted native signed Follow[\s\S]{0,200}continue-on-error:\s*true/u);
  });

  it("enforces governed Redpanda topics in the real multi-implementation lane", () => {
    const workflow = readFileSync(
      resolve("../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("npm run --prefix fedify-sidecar topics:bootstrap");
    expect(workflow).toContain("REDPANDA_ENFORCE_TOPIC_GOVERNANCE=true");
    expect(workflow).not.toContain("REDPANDA_ENFORCE_TOPIC_GOVERNANCE=false");
    expect(workflow).toContain("Reset ActivityPods state between authority modes");
    expect(workflow).toContain('ACTIVITYPODS_RETURN_HOST="${AP_PROOF_SIDECAR_HOST}"');
  });

  it("keeps SSRF-protected target tunnels path-restricted and readiness-gated", () => {
    const overlay = parse(readFileSync(
      resolve("interop/ap/docker-compose.real-activitypods.yml"),
      "utf8",
    )) as ComposeOverlay;
    const recorder = overlay.services?.["peertube-wire-recorder"];
    expect(recorder?.environment?.["AP_WIRE_RECORDER_UPSTREAM"]).toBe("http://peertube-app:9000");
    expect(recorder?.environment?.["AP_WIRE_RECORDER_EVIDENCE_PATH"]).toBe("/evidence/peertube.jsonl");

    const workflow = readFileSync(
      resolve("../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );
    expect(workflow).toContain("target: peertube");
    expect(workflow).toContain("public-activitypub-tunnel-proxy.mjs");
    expect(workflow).toContain("start-cloudflare-quick-tunnel.sh");
    expect(workflow).toContain("friendica\",\"loops\",\"peertube");
    expect(workflow).toContain("/.well-known/ap-proof-health");
    expect(workflow).toContain("AP_FEDERATION_REQUIRE_PUBLIC_ACTOR_READY=true");
    expect(workflow).toContain("AP_FEDERATION_PUBLIC_ACTOR_FETCH_TRANSPORT=curl");
    expect(workflow).toContain("healthStatus\":204");
    expect(workflow).toContain("AP_INTEROP_TUNNEL_ORIGIN=http://127.0.0.1:18002");
    expect(readFileSync("interop/ap/scripts/start-cloudflare-quick-tunnel.sh", "utf8")).toContain(
      "tunnel --protocol http2 --no-autoupdate",
    );
    expect(workflow).toContain("AP_PUBLIC_PROXY_DOCUMENT_TARGET_PORT=3000");
    expect(workflow).toContain('AP_PUBLIC_PROXY_INBOX_TARGET_HOST="${recorder_host}"');
    expect(workflow).toContain('AP_INTEROP_TUNNEL_CONTAINER="ap-${TARGET}-tunnel-external"');
    expect(workflow).toContain("authority_strategy=fresh-bounded-preflight-selection");
    expect(workflow).toContain("for candidate in 1 2 3");
    expect(workflow).toContain('if [[ "${consecutive_health_checks}" -eq 5 ]]');
    expect(workflow).toContain("no signed cross-authority retry");
    expect(workflow).toContain("AP_PUBLIC_PROXY_INBOX_MODE_FILE=");
    expect(workflow).toContain("AP_PUBLIC_PROXY_NATIVE_INBOX_TARGET_PORT=3001");
    expect(workflow).toContain("AP_PUBLIC_PROXY_EXTERNAL_INBOX_TARGET_PORT=8080");
    expect(workflow).toContain("public-inbox-route-mode");
    expect(workflow).toContain("external-public-proxy.pid");
    expect(workflow.match(/reconfigure-loops-proof-authority\.sh/g)).toHaveLength(2);
    const loopsOverlay = readFileSync("interop/ap/docker-compose.loops.yml", "utf8");
    expect(loopsOverlay).toContain("LOOPS_LOCAL_DOMAINS: ${LOOPS_LOCAL_DOMAINS:-}");
    const loopsAuthorityScript = readFileSync("interop/ap/scripts/reconfigure-loops-proof-authority.sh", "utf8");
    expect(loopsAuthorityScript).toContain("config(\"loops.local_domains\") !== $expected");
    expect(loopsAuthorityScript).toContain("^[a-z0-9-]+\\.trycloudflare\\.com$");
    expect(workflow).toContain("tail -n 5000 /var/log/friendica/friendica.log");
    const friendicaBootstrap = readFileSync("interop/ap/scripts/bootstrap-friendica-account.sh", "utf8");
    expect(friendicaBootstrap).toContain("ensure_config system logger_config stream");
    expect(friendicaBootstrap).toContain("ensure_config system logfile /var/log/friendica/friendica.log");
    expect(friendicaBootstrap).toContain("ensure_config system loglevel info");
    expect(workflow).toContain("AP_RELAY_ACTOR_URLS=''");
    expect(workflow).not.toContain("PEERTUBE_FEDERATION_PREVENT_SSRF=false");
    expect(workflow).not.toMatch(/AP_INTEROP_TUNNEL_ORIGIN=http:\/\/[^\s]*:(?:3000|3001|8080)/u);
  });
});
