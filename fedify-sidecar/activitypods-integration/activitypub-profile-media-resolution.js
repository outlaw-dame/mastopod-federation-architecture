"use strict";

const { normalizeUrl } = require("./activitypub-recipient-resolution");

const ACCEPT_HEADER = [
  "image/avif",
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/*;q=0.8",
  "*/*;q=0.1",
].join(", ");

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

class ProfileMediaResolutionError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ProfileMediaResolutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function resolveProfileMedia({
  mediaUrl,
  timeoutMs,
  maxResponseBytes,
  fetchImpl = fetch,
}) {
  const normalizedMediaUrl = normalizeUrl(mediaUrl);
  if (!normalizedMediaUrl) {
    throw new ProfileMediaResolutionError(
      "invalid_request",
      "mediaUrl must be a valid https URL or localhost http URL",
      400,
    );
  }

  let response;
  try {
    response = await fetchImpl(normalizedMediaUrl, {
      method: "GET",
      headers: {
        Accept: ACCEPT_HEADER,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProfileMediaResolutionError(
      "upstream_unavailable",
      `Failed to fetch remote profile media: ${error?.message || String(error)}`,
      503,
    );
  }

  if (response.status === 404) {
    throw new ProfileMediaResolutionError(
      "not_found",
      "Remote profile media could not be resolved.",
      404,
    );
  }

  if (!response.ok) {
    throw new ProfileMediaResolutionError(
      response.status === 429 || response.status >= 500
        ? "upstream_unavailable"
        : "resolution_failed",
      `Remote profile media lookup returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500 ? 503 : 502,
    );
  }

  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength != null && declaredLength > maxResponseBytes) {
    throw new ProfileMediaResolutionError(
      "payload_too_large",
      `Remote profile media exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.byteLength === 0) {
    throw new ProfileMediaResolutionError(
      "invalid_media",
      "Remote profile media response was empty.",
      422,
    );
  }
  if (bytes.byteLength > maxResponseBytes) {
    throw new ProfileMediaResolutionError(
      "payload_too_large",
      `Remote profile media exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  const headerMimeType = normalizeMimeType(response.headers.get("content-type"));
  const detectedMimeType = sniffImageMimeType(bytes);
  const mimeType = chooseMimeType(headerMimeType, detectedMimeType);
  if (!mimeType) {
    throw new ProfileMediaResolutionError(
      "unsupported_media_type",
      "Remote profile media must be a supported raster image type (JPEG, PNG, GIF, or WebP).",
      415,
    );
  }

  return {
    mediaUrl: normalizedMediaUrl,
    mimeType,
    bytesBase64: bytes.toString("base64"),
    size: bytes.byteLength,
  };
}

function normalizeMimeType(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return value.split(";")[0].trim().toLowerCase();
}

function chooseMimeType(headerMimeType, detectedMimeType) {
  if (detectedMimeType && headerMimeType && detectedMimeType !== headerMimeType) {
    return null;
  }

  const candidate = detectedMimeType || headerMimeType;
  if (!candidate || !ALLOWED_IMAGE_MIME_TYPES.has(candidate)) {
    return null;
  }

  return candidate;
}

function sniffImageMimeType(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.byteLength >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }

  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function parseContentLength(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

module.exports = {
  ProfileMediaResolutionError,
  resolveProfileMedia,
};
