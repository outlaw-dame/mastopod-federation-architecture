import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Friendica container error redaction", () => {
  it("retains only the error class, source location, and opaque fingerprint", () => {
    const secret = "https://actor.example/private?token=never-emit";
    const output = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "interop/ap/scripts/redact-friendica-container-errors.mjs")],
      {
        input: `PHP Fatal error: Uncaught TypeError: actor ${secret} in /var/www/html/src/Protocol/ActivityPub/Receiver.php:101\n`,
        encoding: "utf8",
      },
    );
    const result = JSON.parse(output.trim());
    expect(result).toMatchObject({
      schema: "ap.interop.friendica-redacted-error.v1",
      kind: "Fatal error",
      sourceLine: 101,
    });
    expect(result.errorClassSha256).toHaveLength(64);
    expect(result.sourcePathSha256).toHaveLength(64);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("actor.example");
    expect(output).not.toContain("Receiver.php");
    expect(output).not.toContain("TypeError");
  });
});
