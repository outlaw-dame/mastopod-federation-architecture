import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real federation fixture bootstrap contracts", () => {
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
});
