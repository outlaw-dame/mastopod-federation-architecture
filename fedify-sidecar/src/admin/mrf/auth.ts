import crypto from "node:crypto";
import { unauthorized } from "./errors.js";

// HMAC-based comparison: both inputs are hashed to fixed-length digests before
// timingSafeEqual, so neither string length nor character content leaks timing.
const _HMAC_CMP_KEY = Buffer.alloc(32);
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHmac("sha256", _HMAC_CMP_KEY).update(a).digest();
  const hb = crypto.createHmac("sha256", _HMAC_CMP_KEY).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function assertBearerToken(headers: Headers, expectedToken: string): void {
  const auth = headers.get("authorization") || "";
  const [scheme, token] = auth.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw unauthorized("Missing bearer token");
  }

  if (!safeEqual(token, expectedToken)) {
    throw unauthorized("Invalid bearer token");
  }
}

export function assertAdminBearer(headers: Headers, expectedToken: string): void {
  assertBearerToken(headers, expectedToken);
}
