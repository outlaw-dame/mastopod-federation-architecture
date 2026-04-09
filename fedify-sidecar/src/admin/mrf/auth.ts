import crypto from "node:crypto";
import { unauthorized } from "./errors.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function assertAdminBearer(headers: Headers, expectedToken: string): void {
  const auth = headers.get("authorization") || "";
  const [scheme, token] = auth.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw unauthorized("Missing bearer token");
  }

  if (!safeEqual(token, expectedToken)) {
    throw unauthorized("Invalid bearer token");
  }
}
