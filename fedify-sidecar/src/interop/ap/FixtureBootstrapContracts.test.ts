import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("real federation fixture bootstrap contracts", () => {
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
    expect(script).not.toContain("LRANGE");
  });
});
