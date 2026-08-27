#!/usr/bin/env node

import { createHash } from "node:crypto";

// Friendica's Apache/PHP container output can include complete ActivityPub
// requests. Emit only bounded error fingerprints and source locations.
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Friendica diagnostic input exceeded the bounded limit");
  }
}

let emitted = 0;
for (const line of input.split(/\r?\n/u)) {
  if (!/(?:PHP (?:Fatal error|Warning|Notice|Parse error)|Uncaught [A-Za-z_\\][A-Za-z0-9_\\]*)/u.test(line)) continue;
  const location = line.match(/\/var\/www\/html\/([^:\s]+)(?::| on line )(\d+)/u);
  const kind = line.match(/PHP (Fatal error|Warning|Notice|Parse error)/u)?.[1]
    ?? (line.includes("Uncaught ") ? "Uncaught" : "PHP error");
  const errorClass = line.match(/Uncaught ([A-Za-z_\\][A-Za-z0-9_\\]*)/u)?.[1] ?? "unknown";
  const sourcePath = location?.[1] ?? "unknown";
  const fingerprint = createHash("sha256").update(line).digest("hex");
  process.stdout.write(JSON.stringify({
    schema: "ap.interop.friendica-redacted-error.v1",
    kind,
    errorClassSha256: createHash("sha256").update(errorClass).digest("hex"),
    sourcePathSha256: createHash("sha256").update(sourcePath).digest("hex"),
    sourceLine: location ? Number.parseInt(location[2], 10) : null,
    fingerprint,
  }) + "\n");
  emitted += 1;
  if (emitted >= 50) break;
}

if (emitted === 0) {
  process.stdout.write('{"schema":"ap.interop.friendica-redacted-error.v1","errorEvents":0}\n');
}
