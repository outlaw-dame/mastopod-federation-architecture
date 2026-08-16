import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createEffectiveClientIpResolver,
  type EffectiveClientIpResolver,
} from "../security/EffectiveClientIp.js";

const STREAMING_CONTROL_PATH = "/streaming/control";
const STREAMING_STREAM_PATH = "/streaming/stream";

function isFep3ab2Path(request: FastifyRequest): boolean {
  const rawUrl = request.raw.url ?? "";
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  return path === STREAMING_CONTROL_PATH
    || path.startsWith(`${STREAMING_CONTROL_PATH}/`)
    || path === STREAMING_STREAM_PATH;
}

/**
 * Normalize FEP-3ab2's forwarded authentication metadata at the Fastify socket
 * boundary. Existing route/client code can keep the xForwardedFor payload field,
 * but it will contain only one resolver-derived effective client address rather
 * than caller-controlled forwarding chains.
 */
export function installFep3ab2ClientIpBoundary(
  app: FastifyInstance,
  resolver: EffectiveClientIpResolver = createEffectiveClientIpResolver(),
): void {
  app.addHook("onRequest", async (request) => {
    if (!isFep3ab2Path(request)) return;

    const clientIp = resolver(request);
    if (clientIp === "unknown") {
      delete request.headers["x-forwarded-for"];
      return;
    }

    // Overwrite after Fastify parsed caller headers. This makes the existing
    // downstream FEP authority payload seam compatible while stripping caller
    // authority over the forwarded address value.
    request.headers["x-forwarded-for"] = clientIp;
  });
}
