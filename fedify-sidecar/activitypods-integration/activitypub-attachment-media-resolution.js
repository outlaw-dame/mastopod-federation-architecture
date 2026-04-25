"use strict";

const { normalizeUrl } = require("./activitypub-recipient-resolution");

const ACCEPT_HEADER = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/avif",
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "video/*;q=0.9",
  "image/*;q=0.8",
  "*/*;q=0.1",
].join(", ");

const ALLOWED_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

class AttachmentMediaResolutionError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "AttachmentMediaResolutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function resolveAttachmentMedia({
  mediaUrl,
  timeoutMs,
  maxResponseBytes,
  fetchImpl = fetch,
}) {
  const normalizedMediaUrl = normalizeUrl(mediaUrl);
  if (!normalizedMediaUrl) {
    throw new AttachmentMediaResolutionError(
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
    throw new AttachmentMediaResolutionError(
      "upstream_unavailable",
      `Failed to fetch remote attachment media: ${error?.message || String(error)}`,
      503,
    );
  }

  if (response.status === 404) {
    throw new AttachmentMediaResolutionError(
      "not_found",
      "Remote attachment media could not be resolved.",
      404,
    );
  }

  if (!response.ok) {
    throw new AttachmentMediaResolutionError(
      response.status === 429 || response.status >= 500
        ? "upstream_unavailable"
        : "resolution_failed",
      `Remote attachment media lookup returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500 ? 503 : 502,
    );
  }

  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength != null && declaredLength > maxResponseBytes) {
    throw new AttachmentMediaResolutionError(
      "payload_too_large",
      `Remote attachment media exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.byteLength === 0) {
    throw new AttachmentMediaResolutionError(
      "invalid_media",
      "Remote attachment media response was empty.",
      422,
    );
  }
  if (bytes.byteLength > maxResponseBytes) {
    throw new AttachmentMediaResolutionError(
      "payload_too_large",
      `Remote attachment media exceeded ${maxResponseBytes} bytes.`,
      422,
    );
  }

  const headerMimeType = normalizeMimeType(response.headers.get("content-type"));
  const detectedMimeType = sniffMediaMimeType(bytes);
  const mimeType = chooseMimeType(headerMimeType, detectedMimeType);
  if (!mimeType) {
    throw new AttachmentMediaResolutionError(
      "unsupported_media_type",
      "Remote attachment media must be a supported image or video type (JPEG, PNG, GIF, WebP, MP4, WebM, or QuickTime).",
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
  if (detectedMimeType && headerMimeType && headerMimeType !== "application/octet-stream" && detectedMimeType !== headerMimeType) {
    return null;
  }

  const candidate = detectedMimeType || headerMimeType;
  if (!candidate || !ALLOWED_MEDIA_MIME_TYPES.has(candidate)) {
    return null;
  }

  return candidate;
}

function sniffMediaMimeType(bytes) {
  const imageMimeType = sniffImageMimeType(bytes);
  if (imageMimeType) {
    return imageMimeType;
  }

  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = bytes.subarray(8, 12).toString("ascii");
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }

  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }

  return null;
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
  AttachmentMediaResolutionError,
  resolveAttachmentMedia,
};
