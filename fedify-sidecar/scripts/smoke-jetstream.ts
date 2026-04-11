/**
 * smoke-jetstream
 *
 * Deterministic smoke test for Jetstream intake.
 *
 * Connects directly to the Jetstream WebSocket and waits for the first
 * app.bsky.feed.post commit event. On receipt it prints the parsed event
 * and exits 0.  Exits 1 if no event arrives within the timeout.
 *
 * No Redis, RedPanda, or ActivityPods dependencies — this validates
 * connectivity and event parsing only.
 *
 * Usage:
 *   npm run smoke:jetstream
 *
 * Environment variables:
 *   JETSTREAM_URL        — override the default endpoint
 *   JETSTREAM_MAX_EVENTS — number of events to wait for (default: 1)
 *   JETSTREAM_TIMEOUT_MS — timeout in ms before failing (default: 30000)
 */

import { WebSocket } from "ws";

const JETSTREAM_URL =
  process.env["JETSTREAM_URL"] ||
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";

const MAX_EVENTS = Math.max(
  1,
  Number.parseInt(process.env["JETSTREAM_MAX_EVENTS"] ?? "1", 10) || 1,
);

const TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env["JETSTREAM_TIMEOUT_MS"] ?? "30000", 10) || 30_000,
);

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

console.log("=".repeat(60));
console.log(" Jetstream Smoke Test");
console.log("=".repeat(60));
console.log(` URL:        ${JETSTREAM_URL}`);
console.log(` Max events: ${MAX_EVENTS}`);
console.log(` Timeout:    ${TIMEOUT_MS}ms`);
console.log("=".repeat(60));
console.log();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let forwarded = 0;
let done = false;

const timeoutHandle = setTimeout(() => {
  if (done) return;
  done = true;
  console.error(`\n[FAIL] No events received within ${TIMEOUT_MS}ms.`);
  process.exit(1);
}, TIMEOUT_MS);

console.log(`[smoke] Connecting to ${JETSTREAM_URL} ...`);

const ws = new WebSocket(JETSTREAM_URL, { maxPayload: 5 * 1024 * 1024 });

ws.on("open", () => {
  console.log("[smoke] Connected. Waiting for events...\n");
});

ws.on("message", (data, isBinary) => {
  if (isBinary || done) return;

  let payload: unknown;
  try {
    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
    payload = JSON.parse(text);
  } catch {
    return;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as Record<string, unknown>)["kind"] !== "commit"
  ) {
    return;
  }

  const p = payload as Record<string, unknown>;
  const commit = p["commit"] as Record<string, unknown> | null | undefined;
  const did = typeof p["did"] === "string" ? p["did"] : null;
  const collection = commit && typeof commit["collection"] === "string" ? commit["collection"] : null;
  const rkey = commit && typeof commit["rkey"] === "string" ? commit["rkey"] : null;
  const operation = commit?.["operation"] ?? "create";
  const timeUs = typeof p["time_us"] === "number" ? p["time_us"] : null;

  if (!did || !collection || !rkey) return;

  forwarded++;
  console.log(`[smoke] Event ${forwarded}/${MAX_EVENTS} received:`);
  console.log(`  did:        ${did}`);
  console.log(`  collection: ${collection}`);
  console.log(`  rkey:       ${rkey}`);
  console.log(`  operation:  ${String(operation)}`);
  console.log(`  time_us:    ${timeUs}`);
  console.log();

  if (forwarded >= MAX_EVENTS) {
    done = true;
    clearTimeout(timeoutHandle);
    ws.close(1000, "max events reached");
    console.log(`[smoke] SUCCESS — received ${forwarded} event(s).`);
    process.exit(0);
  }
});

ws.on("error", (err) => {
  if (done) return;
  done = true;
  clearTimeout(timeoutHandle);
  console.error(`[smoke] WebSocket error: ${err.message}`);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  if (done) return;
  done = true;
  clearTimeout(timeoutHandle);
  console.error(`[smoke] Connection closed unexpectedly: ${code} ${reason.toString()}`);
  process.exit(1);
});
