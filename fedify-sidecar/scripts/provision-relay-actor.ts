/**
 * provision-relay-actor
 *
 * Creates the local ActivityPods "relay" bot account that the sidecar uses
 * as the AP_RELAY_LOCAL_ACTOR_URI sender when subscribing to relay servers.
 *
 * The signing service validates that any actorUri submitted for signing is a
 * local actor controlled by this ActivityPods deployment.  The relay actor
 * must therefore exist as a real account before the relay subscription service
 * can send signed Follow activities to relay servers.
 *
 * What this script does:
 *   1. POST /api/accounts/create on the ActivityPods instance
 *   2. Prints the resulting actor URI (= AP_RELAY_LOCAL_ACTOR_URI)
 *   3. If the account already exists (HTTP 409) it resolves the URI and exits cleanly
 *
 * Usage:
 *   npm run provision:relay-actor
 *
 * Optional env vars:
 *   ACTIVITYPODS_URL        — default: http://localhost:3000
 *   ACTIVITYPODS_TOKEN      — Bearer token for the internal API (used for actor-URI lookup)
 *   AP_RELAY_USERNAME       — username for the relay account (default: relay)
 *   AP_RELAY_PASSWORD       — password (default: a strong random value printed on first run)
 *   AP_RELAY_DISPLAY_NAME   — display name (default: "Relay Bot")
 *   AP_RELAY_EMAIL          — email (default: relay@localhost)
 *
 * After running, set:
 *   AP_RELAY_LOCAL_ACTOR_URI=<printed actor URI>
 * in the sidecar's environment.
 */

const ACTIVITYPODS_URL = (process.env["ACTIVITYPODS_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const ACTIVITYPODS_TOKEN = process.env["ACTIVITYPODS_TOKEN"] ?? "";
const USERNAME = process.env["AP_RELAY_USERNAME"] ?? "relay";
const DISPLAY_NAME = process.env["AP_RELAY_DISPLAY_NAME"] ?? "Relay Bot";
const EMAIL = process.env["AP_RELAY_EMAIL"] ?? `relay@localhost`;

// Generate a strong password if not provided. Printed once so operators can
// store it. The account is never used for interactive sign-in, only signing.
function generatePassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const PASSWORD = process.env["AP_RELAY_PASSWORD"] ?? generatePassword();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createRelayAccount(): Promise<{ actorUri: string; created: boolean }> {
  const body = JSON.stringify({
    username: USERNAME,
    email: EMAIL,
    password: PASSWORD,
    profile: {
      displayName: DISPLAY_NAME,
      summary: "System actor used by the fedify sidecar to subscribe to ActivityPub relays.",
    },
    solid: { enabled: true },
    activitypub: { enabled: true },
    atproto: { enabled: false },
  });

  const resp = await fetch(`${ACTIVITYPODS_URL}/api/accounts/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(ACTIVITYPODS_TOKEN ? { Authorization: `Bearer ${ACTIVITYPODS_TOKEN}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (resp.ok) {
    const data = (await resp.json()) as Record<string, unknown>;
    const actorUri =
      (data["actorUri"] as string | undefined) ??
      (data["canonicalAccountId"] as string | undefined) ??
      (data["webId"] as string | undefined);

    if (!actorUri) {
      throw new Error(
        `Account created but response did not include actorUri/canonicalAccountId/webId.\n` +
        `Response: ${JSON.stringify(data)}`,
      );
    }
    return { actorUri, created: true };
  }

  if (resp.status === 409) {
    // Account already exists — resolve the actor URI from the ActivityPods
    // internal actor API using the username.
    const actorUri = await resolveExistingActorUri();
    return { actorUri, created: false };
  }

  const text = await resp.text().catch(() => "(unreadable body)");
  throw new Error(`AccountCreate POST failed with HTTP ${resp.status}:\n${text}`);
}

async function resolveExistingActorUri(): Promise<string> {
  if (!ACTIVITYPODS_TOKEN) {
    // Without a token we can't hit the internal API.  Construct the canonical
    // URI pattern ActivityPods uses: https://{domain}/{username}
    const domain = new URL(ACTIVITYPODS_URL).hostname;
    const guessed = `https://${domain}/${USERNAME}`;
    console.warn(
      `[warn] ACTIVITYPODS_TOKEN not set — cannot confirm actor URI via internal API.\n` +
      `       Guessing: ${guessed}\n` +
      `       Set ACTIVITYPODS_TOKEN if this is wrong.`,
    );
    return guessed;
  }

  // Try the internal actors endpoint.
  const resp = await fetch(
    `${ACTIVITYPODS_URL}/api/internal/actors/${encodeURIComponent(USERNAME)}`,
    {
      headers: {
        Accept: "application/activity+json, application/json",
        Authorization: `Bearer ${ACTIVITYPODS_TOKEN}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (resp.ok) {
    const doc = (await resp.json()) as Record<string, unknown>;
    const id = doc["id"] as string | undefined;
    if (id) return id;
  }

  // Final fallback: construct from URL pattern.
  const domain = new URL(ACTIVITYPODS_URL).hostname;
  return `https://${domain}/${USERNAME}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log(" Relay Actor Provisioner");
  console.log("=".repeat(60));
  console.log(` ActivityPods URL : ${ACTIVITYPODS_URL}`);
  console.log(` Username         : ${USERNAME}`);
  console.log(` Display name     : ${DISPLAY_NAME}`);
  console.log(` Email            : ${EMAIL}`);
  console.log("=".repeat(60));

  let result: { actorUri: string; created: boolean };
  try {
    result = await createRelayAccount();
  } catch (err) {
    console.error("\n[ERROR] Failed to provision relay actor:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log("");
  if (result.created) {
    console.log(`[OK] Relay actor created successfully.`);
    if (!process.env["AP_RELAY_PASSWORD"]) {
      console.log("");
      console.log(` Generated password: ${PASSWORD}`);
      console.log(` (store this securely — it will not be shown again)`);
    }
  } else {
    console.log(`[OK] Relay actor already exists — no changes made.`);
  }

  console.log("");
  console.log(`Actor URI:`);
  console.log(`  ${result.actorUri}`);
  console.log("");
  console.log(`Add the following to your sidecar environment:`);
  console.log(`  AP_RELAY_LOCAL_ACTOR_URI=${result.actorUri}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
