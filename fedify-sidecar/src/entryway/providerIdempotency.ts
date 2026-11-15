import { createHash } from "node:crypto";
import type { AccountRoute } from "./types.js";

// The provider's provisioning idempotency scope is deterministic across
// retries and recovery. It contains only an account ID and hash of the
// Entryway-local HMAC, never the user's raw key or credentials.
export function buildProviderIdempotencyKey(route: AccountRoute): string {
  return `entryway:${route.accountId}:${createHash("sha256")
    .update(route.provisioning.idempotencyKeyHash)
    .digest("hex")
    .slice(0, 24)}`;
}
