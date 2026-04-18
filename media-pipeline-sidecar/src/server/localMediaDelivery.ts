import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/config';
import { getLocalObjectHandle } from '../storage/localObjectStore';

export async function handleLocalMediaDelivery(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>
): Promise<boolean> {
  const parsedUrl = new URL(request.url || '/', 'http://media-pipeline.local');
  if (!parsedUrl.pathname.startsWith('/media/')) {
    return false;
  }

  if (config.mediaObjectStoreBackend !== 'file') {
    writeResponse(response, 404, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }

  const method = request.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    writeResponse(response, 405, {
      allow: 'GET, HEAD',
      'cache-control': 'no-store'
    });
    response.end();
    return true;
  }

  const rawKey = parsedUrl.pathname.slice('/media/'.length);
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    writeResponse(response, 400, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }

  const handle = await getLocalObjectHandle(key);
  if (!handle) {
    writeResponse(response, 404, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }

  const contentLength = handle.contentLength ?? 0;
  const conditionalResult = evaluateConditionalRequest(request, handle.etag, handle.lastModified);
  if (conditionalResult === 'not-modified') {
    writeObjectHeaders(response, handle.contentType, handle.cacheControl, handle.contentDisposition, handle.etag, handle.lastModified, contentLength);
    response.statusCode = 304;
    response.end();
    return true;
  }

  const range = parseRangeHeader(typeof request.headers.range === 'string' ? request.headers.range : undefined, contentLength);
  if (range === 'invalid') {
    writeObjectHeaders(response, handle.contentType, handle.cacheControl, handle.contentDisposition, handle.etag, handle.lastModified, contentLength);
    response.statusCode = 416;
    response.setHeader('content-range', `bytes */${contentLength}`);
    response.end();
    return true;
  }

  if (range) {
    const partialLength = range.end - range.start + 1;
    writeObjectHeaders(response, handle.contentType, handle.cacheControl, handle.contentDisposition, handle.etag, handle.lastModified, partialLength);
    response.statusCode = 206;
    response.setHeader('content-range', `bytes ${range.start}-${range.end}/${contentLength}`);
    if (method === 'HEAD') {
      response.end();
      return true;
    }

    await pipeline(createReadStream(handle.filePath, { start: range.start, end: range.end }), response);
    return true;
  }

  writeObjectHeaders(response, handle.contentType, handle.cacheControl, handle.contentDisposition, handle.etag, handle.lastModified, contentLength);
  response.statusCode = 200;
  if (method === 'HEAD') {
    response.end();
    return true;
  }

  await pipeline(createReadStream(handle.filePath), response);
  return true;
}

function writeObjectHeaders(
  response: ServerResponse<IncomingMessage>,
  contentType: string | undefined,
  cacheControl: string | undefined,
  contentDisposition: string | undefined,
  etag: string | undefined,
  lastModified: Date | undefined,
  contentLength: number
): void {
  writeResponse(response, response.statusCode || 200, {
    'content-type': contentType || 'application/octet-stream',
    'cache-control': cacheControl || 'public, max-age=60',
    'content-disposition': contentDisposition || 'inline',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-length': String(contentLength)
  });

  if (etag) {
    response.setHeader('etag', etag);
  }

  if (lastModified) {
    response.setHeader('last-modified', lastModified.toUTCString());
  }
}

function writeResponse(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  headers: Record<string, string>
): void {
  response.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }
}

function evaluateConditionalRequest(
  request: IncomingMessage,
  etag: string | undefined,
  lastModified: Date | undefined
): 'proceed' | 'not-modified' {
  const ifNoneMatch = typeof request.headers['if-none-match'] === 'string'
    ? request.headers['if-none-match']
    : undefined;
  if (etag && ifNoneMatch && ifNoneMatch.split(',').map((entry) => entry.trim()).includes(etag)) {
    return 'not-modified';
  }

  const ifModifiedSince = typeof request.headers['if-modified-since'] === 'string'
    ? request.headers['if-modified-since']
    : undefined;
  if (lastModified && ifModifiedSince) {
    const parsed = Date.parse(ifModifiedSince);
    if (Number.isFinite(parsed) && lastModified.getTime() <= parsed) {
      return 'not-modified';
    }
  }

  return 'proceed';
}

function parseRangeHeader(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return 'invalid';
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return 'invalid';
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return 'invalid';
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}
