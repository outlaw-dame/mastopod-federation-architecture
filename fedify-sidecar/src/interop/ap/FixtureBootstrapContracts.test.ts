import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("real federation fixture bootstrap contracts", () => {
  it("gives only Misskey a longer bounded post-setup actor readiness window", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("readiness_attempts=90");
    expect(workflow).toContain('if [[ "${TARGET}" == "misskey" ]]');
    expect(workflow).toContain("readiness_attempts=270");
    expect(workflow).toContain('seq 1 "${readiness_attempts}"');
    expect(workflow).toContain("former seven-minute bound");
  });

  it("bounds retries for transient Pixelfed image-build downloads", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/build-pixelfed-fixture.sh"),
      "utf8",
    );

    expect(script).toContain("MAX_ATTEMPTS=${AP_INTEROP_BUILD_MAX_ATTEMPTS:-3}");
    expect(script).toContain("MAX_ATTEMPTS > 5");
    expect(script).toContain('! -f "${CONTEXT}/Dockerfile"');
    expect(script).toContain('while ! docker build --tag "${IMAGE}" "${CONTEXT}"');
    expect(script).toContain("delay=$((5 * (2 ** (attempt - 1))))");
    expect(script).toContain('docker image inspect "${IMAGE}"');
  });

  it("runs Pixelfed actor-fetch diagnostics without malformed PHP namespaces", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
      "utf8",
    );

    expect(script).toContain("App\\Services\\ActivityPubFetchService::fetchRequest");
    expect(script).toContain("App\\Util\\ActivityPub\\HttpSignature::instanceActorSign");
    expect(script).toContain('"contentType" => $response->header("Content-Type")');
    expect(script).not.toContain("App\\\\Services\\\\ActivityPubFetchService");
    expect(script).not.toContain('dump(["type" => gettype($response), "bytes" => is_string($response) ? strlen($response) : 0, "body" => $response])');
  });

  it("keeps TLS verification enabled for PHP implementation actor fetches", () => {
    const pixelfedCompose = readFileSync(
      resolve(process.cwd(), "interop/ap/docker-compose.pixelfed.yml"),
      "utf8",
    );
    const friendicaCompose = readFileSync(
      resolve(process.cwd(), "interop/ap/docker-compose.friendica.yml"),
      "utf8",
    );
    const phpConfig = readFileSync(
      resolve(process.cwd(), "interop/ap/fixtures/php/interop-ca.ini"),
      "utf8",
    );

    expect(pixelfedCompose.match(/fixtures\/php\/interop-ca\.ini:.*:ro/g)).toHaveLength(2);
    expect(friendicaCompose.match(/fixtures\/php\/interop-ca\.ini:.*:ro/g)).toHaveLength(2);
    expect(phpConfig).toContain("curl.cainfo=/interop/runtime/certs/rootCA.crt");
    expect(phpConfig).toContain("openssl.cafile=/interop/runtime/certs/rootCA.crt");
    expect(pixelfedCompose).not.toContain("GuzzleHttp\\RequestOptions::VERIFY: false");
    expect(friendicaCompose).not.toContain("GuzzleHttp\\RequestOptions::VERIFY: false");
    expect(`${pixelfedCompose}\n${friendicaCompose}`).not.toContain("CURLOPT_SSL_VERIFYPEER");
  });

  it("bootstraps Misskey without exposing directional credentials", () => {
    const prepare = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/prepare-misskey-config.sh"),
      "utf8",
    );
    const bootstrap = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/bootstrap-misskey-account.sh"),
      "utf8",
    );
    const compose = readFileSync(
      resolve(process.cwd(), "interop/ap/docker-compose.misskey.yml"),
      "utf8",
    );

    expect(prepare).toContain("umask 077");
    expect(prepare).toContain("allowedPrivateNetworks:");
    expect(prepare).toContain("172.31.240.0/24");
    expect(bootstrap).toContain('-e AP_INTEROP_SETUP_PASSWORD="${MISSKEY_SETUP_PASSWORD}"');
    expect(bootstrap).not.toContain("console.log");
    expect(bootstrap).toContain('/api/admin/update-meta');
    expect(bootstrap).toContain('authorization: `Bearer ${value.token}`');
    expect(bootstrap).toContain('JSON.stringify({ federation: "all" })');
    expect(bootstrap).toContain("TARGET_ACTOR_URI=https://misskey.test/users/%s");
    expect(compose).toContain("misskey/misskey:2026.7.0@sha256:2fd5c68f");
    expect(compose).toContain("postgres:18-alpine@sha256:d3e1620b");
    expect(compose).toContain("ap_interop_misskey_db:/var/lib/postgresql");
    expect(compose).not.toContain("ap_interop_misskey_db:/var/lib/postgresql/data");
    expect(compose).toContain("misskey-config-init:");
    expect(compose).toContain('user: "0:0"');
    expect(compose).toContain("chmod 0600 /target/default.yml");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("ap_interop_misskey_config:/misskey/.config:ro");
  });

  it("uses Friendica's official installer and required background worker", () => {
    const bootstrap = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/bootstrap-friendica-account.sh"),
      "utf8",
    );
    const compose = readFileSync(
      resolve(process.cwd(), "interop/ap/docker-compose.friendica.yml"),
      "utf8",
    );
    const corefile = readFileSync(
      resolve(process.cwd(), "interop/ap/fixtures/friendica/Corefile"),
      "utf8",
    );

    expect(compose).toContain("friendica:2026.05@sha256:e496eeb3");
    expect(compose).toContain("entrypoint: /cron.sh");
    expect(compose).toContain("FRIENDICA_URL: https://friendica.test\n");
    expect(compose).not.toContain("FRIENDICA_URL: https://friendica.test/\n");
    expect(compose).toContain("CURL_CA_BUNDLE: /interop/runtime/certs/rootCA.crt");
    expect(compose).toContain("FRIENDICA_LOGFILE: /var/log/friendica/friendica.log");
    expect(compose).toContain("FRIENDICA_LOGLEVEL: info");
    expect(compose).toContain("FRIENDICA_LOGGER: stream");
    expect(compose).toContain("coredns/coredns:1.11.3@sha256:9caabbf6");
    expect(compose.match(/dns:\n\s+- 172\.31\.240\.253/g)).toHaveLength(2);
    expect(compose).toContain("ipv4_address: 172.31.240.253");
    expect(corefile).toContain("172.31.240.254 activitypods.test");
    expect(corefile).toContain("forward . 127.0.0.11");
    expect(corefile).not.toContain("tls://");
    expect(compose).toContain("friendica-log-init:");
    expect(compose.match(/ap_interop_friendica_log:\/var\/log\/friendica/g)).toHaveLength(3);
    expect(compose).toContain("./fixtures/friendica/actor-jsonld-diagnostic.php:/interop/actor-jsonld-diagnostic.php:ro");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).not.toContain("FRIENDICA_NO_VALIDATION");
    expect(bootstrap).toContain("php bin/console.php user add");
    expect(bootstrap).toContain("compose up -d friendica-worker");
  });

  it("records each mode outcome and fails closed on incomplete evidence", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );

    expect(workflow).toContain("id: native-proof");
    expect(workflow).toContain("id: external-proof");
    expect(workflow).toContain("NATIVE_PROOF_OUTCOME: ${{ steps.native-proof.outcome }}");
    expect(workflow).toContain("EXTERNAL_PROOF_OUTCOME: ${{ steps.external-proof.outcome }}");
    expect(workflow).toContain("complete: false, stepOutcome:");
    expect(workflow).toContain("if (!complete) throw new Error");
  });

  it("creates a Castopod actor through the production podcast model", () => {
    const bootstrap = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/bootstrap-castopod-account.sh"),
      "utf8",
    );
    const command = readFileSync(
      resolve(process.cwd(), "interop/ap/castopod/InteropCreatePodcast.php"),
      "utf8",
    );
    const bootConfig = readFileSync(
      resolve(process.cwd(), "interop/ap/fixtures/castopod/interop-boot.ini"),
      "utf8",
    );
    const compose = readFileSync(
      resolve(process.cwd(), "interop/ap/docker-compose.castopod.yml"),
      "utf8",
    );

    expect(compose).toContain("castopod/castopod:1.9.0@sha256:3ad8970f");
    expect(compose).not.toContain("CP_DISABLE_HTTPS");
    expect(bootstrap).toContain('grep -qx "cache.redis.database=0" .env');
    expect(bootstrap).toContain("http://127.0.0.1:8000/");
    expect(compose).toContain("fixtures/php/interop-ca.ini");
    expect(compose).toContain("fixtures/castopod/interop-boot.ini");
    expect(bootConfig).toContain(
      "auto_prepend_file=/var/www/castopod/app/Config/Boot/production.php",
    );
    expect(bootstrap).toContain("spark install:init-database");
    expect(bootstrap).toContain("spark install:create-superadmin");
    expect(bootstrap).toContain("-n interopadmin");
    expect(bootstrap).not.toContain("interop-admin");
    expect(bootstrap).toContain("spark interop:create-podcast");
    expect(bootstrap).not.toContain("define('CI_DEBUG'");
    expect(bootstrap).not.toContain("-d auto_prepend_file=");
    expect(command).toContain("new PodcastModel()");
    expect(command).toContain("where('username', 'interopadmin')");
    expect(command).not.toContain("interop-admin");
    expect(command).toContain("imagecreatetruecolor(1400, 1400)");
    expect(command).not.toContain("private_key' =>");
    expect(command).not.toContain("public_key' =>");
  });

  it("does not mislabel hosted-service blockers or unproven candidates as coverage", () => {
    const coverage = readFileSync(
      resolve(process.cwd(), "interop/ap/EXTERNAL-IMPLEMENTATION-COVERAGE.md"),
      "utf8",
    );

    expect(coverage).toContain("Pixelfed's MySQL database | Covered at architecture `9a2fd328d779cef178e56af06c64f9717bd5e23a`");
    expect(coverage).toContain("Exact-head candidate lane; not covered until CI proves both modes");
    expect(coverage).toContain("Hosted Micro.blog blocker");
    expect(coverage).toContain("Hosted write.as blocker");
    expect(coverage).toContain("must not be reported as write.as coverage");
    for (const target of ["Misskey", "Friendica", "Castopod", "Micro.blog", "write.as"]) {
      const row = coverage.split("\n").find(line => line.startsWith(`| ${target} |`));
      expect(row).toBeDefined();
      expect(row).not.toMatch(/\| Covered\s*\|$/);
    }
  });

  it("uses an MX-reachable default for Mastodon CLI account validation", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/bootstrap-mastodon-account.sh"),
      "utf8",
    );

    expect(script).toContain(
      'EMAIL="${AP_INTEROP_MASTODON_EMAIL:-interop-ci@mastodon.social}"',
    );
    expect(script).not.toMatch(/EMAIL=.*@(example\.(?:com|net|org)|localhost)/);
  });

  it("migrates Bonfire with its documented release task before app startup", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/bootstrap-bonfire-account.sh"),
      "utf8",
    );
    const migrateIndex = script.indexOf(
      "compose run --rm bonfire-app bin/bonfire eval 'Bonfire.Common.Repo.migrate()'",
    );
    const startIndex = script.indexOf("compose up -d bonfire-app");

    expect(migrateIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(migrateIndex);
  });

  it("resolves CI compose overlays from the repository workspace before querying persistence", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
      "utf8",
    );

    expect(script).toContain('[ -f "${GITHUB_WORKSPACE}/${path}" ]');
    expect(script).toContain('COMPOSE_FILE=$(canonicalize_compose_path "${COMPOSE_FILE}")');
    expect(script).toContain('COMPOSE_OVERLAY=$(canonicalize_compose_path "${COMPOSE_OVERLAY}")');
  });

  it("fails closed when every remote persistence query fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "ap-follow-query-failure-"));
    try {
      const composePath = join(directory, "compose.yml");
      const dockerPath = join(directory, "docker");
      writeFileSync(composePath, "services: {}\n");
      writeFileSync(dockerPath, "#!/bin/sh\necho 'database unavailable' >&2\nexit 17\n");
      chmodSync(dockerPath, 0o700);
      const result = spawnSync("sh", [
        resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
        "mastodon",
        "https://activitypods.example/users/alice",
        "interop",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          AP_INTEROP_COMPOSE_FILE: composePath,
          AP_INTEROP_FOLLOW_ASSERT_ATTEMPTS: "1",
          AP_INTEROP_FOLLOW_ASSERT_DELAY_SECONDS: "0",
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("remote state is unknown");
      expect(result.stderr).not.toContain("observed count=0");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records bounded Pixelfed processing diagnostics without dumping queued payloads", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
      "utf8",
    );

    expect(script).toContain("remote_profile_count=");
    expect(script).toContain("follow_request_count=");
    expect(script).toContain("failed_job_count=");
    expect(script).toContain('LLEN "queues:${queue}"');
    expect(script).toContain("ActivityPubFetchService::fetchRequest");
    expect(script).toContain('"bytes" => is_string($response) ? strlen($response) : 0');
    expect(script).not.toContain("LRANGE");
  });

  it("records Friendica inbox and relationship state without exposing queued payloads", () => {
    const script = readFileSync(
      resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
      "utf8",
    );
    const workflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-multi-implementation-federation.yml"),
      "utf8",
    );
    const twoModeWorkflow = readFileSync(
      resolve(process.cwd(), "../.github/workflows/activitypub-real-two-mode-federation.yml"),
      "utf8",
    );
    const actorDiagnostic = readFileSync(
      resolve(process.cwd(), "interop/ap/fixtures/friendica/actor-jsonld-diagnostic.php"),
      "utf8",
    );

    expect(script).toContain("Friendica fail-closed persistence diagnostics:");
    expect(script).toContain("remote_contact_count=");
    expect(script).toContain("apcontact_count=");
    expect(script).toContain("actor_uri_cache_count=");
    expect(script).toContain("inbox_entry_count=");
    expect(script).toContain("inbox_receiver_count=");
    expect(script).toContain("introduction_count=");
    expect(script).toContain("pending_worker_count=");
    expect(script).toContain("actor_fetch_discard_count");
    expect(script).toContain("invalid_http_signature_count");
    expect(script).toContain("valid_http_signature_count");
    expect(script).toContain("friendica_log_line_count");
    expect(script).toContain("php /interop/actor-jsonld-diagnostic.php");
    expect(script).toContain('AP_INTEROP_EXPECTED_ACTOR_HOST="${ACTIVITYPODS_HOST:?ACTIVITYPODS_HOST is required}"');
    expect(script).toContain('fopen("/var/log/friendica/friendica.log", "rb")');
    expect(script).not.toContain("select parameter from workerqueue");
    expect(script).not.toContain("select activity from \\`inbox-entry\\`");
    expect(script).not.toContain("compose logs --no-color friendica-app friendica-worker");
    expect(workflow).not.toContain("logs --no-color friendica-app friendica-worker");
    expect(workflow).toContain("ps friendica-app friendica-worker");
    expect(workflow).not.toContain('cat "${EVIDENCE_DIR}/signing-api.jsonl"');
    expect(twoModeWorkflow).not.toContain('cat "${EVIDENCE_DIR}/signing-api.jsonl"');
    expect(actorDiagnostic).toContain("AP_INTEROP_EXPECTED_ACTOR_HOST");
    expect(actorDiagnostic).toContain("actor_compact_public_key_pem_present");
    expect(actorDiagnostic).not.toContain("CURLOPT_HEADER");
    expect(actorDiagnostic).not.toMatch(/(?:echo|print|fwrite|printf).*publicKeyPem/);
  });

  it("passes quoted Friendica table names to MariaDB as SQL, not shell substitutions", () => {
    const directory = mkdtempSync(join(tmpdir(), "ap-friendica-diagnostics-"));
    try {
      const composePath = join(directory, "compose.yml");
      const dockerPath = join(directory, "docker");
      const capturePath = join(directory, "diagnostics.sql");
      writeFileSync(composePath, "services: {}\n");
      writeFileSync(dockerPath, `#!/bin/sh
case "$*" in
  *"select count(*) from contact c join user"*) printf '0\\n'; exit 0 ;;
  *"mariadb --batch --skip-column-names -u friendica friendica"*) cat > "$AP_INTEROP_SQL_CAPTURE"; exit 0 ;;
  *) exit 0 ;;
esac
`);
      chmodSync(dockerPath, 0o700);

      const result = spawnSync("sh", [
        resolve(process.cwd(), "interop/ap/scripts/assert-real-follow-accepted.sh"),
        "friendica",
        "https://activitypods.example/users/alice",
        "interop",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          AP_INTEROP_COMPOSE_FILE: composePath,
          AP_INTEROP_FOLLOW_ASSERT_ATTEMPTS: "1",
          AP_INTEROP_FOLLOW_ASSERT_DELAY_SECONDS: "0",
          AP_INTEROP_SQL_CAPTURE: capturePath,
          ACTIVITYPODS_HOST: "activitypods.example",
        },
      });

      expect(result.status).toBe(1);
      const sql = readFileSync(capturePath, "utf8");
      expect(sql).toContain("from `inbox-entry`");
      expect(sql).toContain("from `inbox-entry-receiver`");
      expect(sql).toContain("r.`queue-id`");
      expect(result.stderr).not.toContain("not found");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
