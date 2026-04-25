import { createHash } from "node:crypto";

export interface InteropMediaFixtureAccess {
  method: string;
  receivedAt: number;
  userAgent?: string;
  remoteAddress?: string;
  range?: string;
  accept?: string;
}

export interface InteropMediaFixtureResponse {
  statusCode: number;
  body: Buffer;
  headers: Record<string, string>;
}

interface InteropMediaFixtureDefinition {
  contentType: string;
  body: Buffer;
  lastModified: string;
  cacheControl: string;
}

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9nXn0AAAAASUVORK5CYII=";
const SAMPLE_MP4_BASE64 = [
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAARnbW9vdgAAAGxtdmhkAAAAAAAAAAAA",
  "AAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA",
  "AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA5J0cmFrAAAAXHRraGQAAAADAAAA",
  "AAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA",
  "AAAAAAAAAABAAAAAAUAAAAC0AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAA",
  "AAMKbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAMgBVxAAAAAAALWhkbHIAAAAAAAAAAHZp",
  "ZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACtW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAA",
  "ACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAnVzdGJsAAAAwXN0c2QAAAAAAAAA",
  "AQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAAtABIAAAASAAAAAAAAAABFUxhdmM2",
  "Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAM/+EAGmdkAAys2UFBn58B",
  "EAAAAwAQAAADAyDxQplgAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAA",
  "ACLAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAZAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAA2GN0",
  "dHMAAAAAAAAAGQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAK",
  "AAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIA",
  "AAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAA",
  "AAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAHHN0c2MAAAAAAAAAAQAA",
  "AAEAAAAZAAAAAQAAAHhzdHN6AAAAAAAAAAAAAAAZAAAC5gAAABAAAAANAAAADQAAAA0AAAAWAAAA",
  "DwAAAA0AAAANAAAAFgAAAA8AAAANAAAADQAAABYAAAAPAAAADQAAAA0AAAAWAAAADwAAAA0AAAAN",
  "AAAAFgAAAA8AAAANAAAADQAAABRzdGNvAAAAAAAAAAEAAASXAAAAYXVkdGEAAABZbWV0YQAAAAAA",
  "AAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEA",
  "AAABAAAAAExhdmY2Mi4zLjEwMAAAAAhmcmVlAAAEYG1kYXQAAAKmBgX//6LcRem95tlIt5Ys2CDZ",
  "I+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHls",
  "ZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlv",
  "bnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXgg",
  "c3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNo",
  "cm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bz",
  "a2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTYgbG9va2FoZWFkX3RocmVhZHM9MSBz",
  "bGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBh",
  "dD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBi",
  "X2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1",
  "MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9",
  "NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBx",
  "cHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAOGWIhAA7//73Tr8Cm1TCKgOSVwr2",
  "yqQmWblSawHypgAA80pZob97y17o8AUIAABsxLMd0SGlOI6vAAAADEGaJGxDv/6plgACBgAAAAlB",
  "nkJ4hf8AAm8AAAAJAZ5hdEK/AANSAAAACQGeY2pCvwADUwAAABJBmmhJqEFomUwId//+qZYAAgcA",
  "AAALQZ6GRREsL/8AAm8AAAAJAZ6ldEK/AANTAAAACQGep2pCvwADUgAAABJBmqxJqEFsmUwId//+",
  "qZYAAgYAAAALQZ7KRRUsL/8AAm8AAAAJAZ7pdEK/AANSAAAACQGe62pCvwADUgAAABJBmvBJqEFs",
  "mUwIb//+p4QAA/0AAAALQZ8ORRUsL/8AAm8AAAAJAZ8tdEK/AANTAAAACQGfL2pCvwADUgAAABJB",
  "mzRJqEFsmUwIZ//+nhAAD5gAAAALQZ9SRRUsL/8AAm8AAAAJAZ9xdEK/AANSAAAACQGfc2pCvwAD",
  "UgAAABJBm3hJqEFsmUwIV//+OEAAPSEAAAALQZ+WRRUsL/8AAm4AAAAJAZ+1dEK/AANTAAAACQGf",
  "t2pCvwADUw=="
].join("");

const FIXTURE_TIMESTAMP = "Mon, 13 Apr 2026 00:00:00 GMT";
const ACCESS_LOG_LIMIT = 64;

function createFixtureMap(): Record<string, InteropMediaFixtureDefinition> {
  return {
    "pixel.png": {
      contentType: "image/png",
      body: Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
      lastModified: FIXTURE_TIMESTAMP,
      cacheControl: "public, max-age=300"
    },
    "sample.mp4": {
      contentType: "video/mp4",
      body: Buffer.from(SAMPLE_MP4_BASE64, "base64"),
      lastModified: FIXTURE_TIMESTAMP,
      cacheControl: "public, max-age=300"
    }
  };
}

const FIXTURES = createFixtureMap();
const accessLog = new Map<string, InteropMediaFixtureAccess[]>();

export function isApInteropMediaFixtureEnabled(): boolean {
  return process.env["AP_INTEROP_ENABLE_MEDIA_FIXTURES"] === "true";
}

export function resolveApInteropMediaFixtureResponse(
  fixtureName: string,
  rangeHeader?: string
): InteropMediaFixtureResponse | null {
  const fixture = FIXTURES[fixtureName];
  if (!fixture) {
    return null;
  }

  const etag = buildFixtureEtag(fixture.body);
  const baseHeaders: Record<string, string> = {
    "content-type": fixture.contentType,
    "accept-ranges": "bytes",
    "cache-control": fixture.cacheControl,
    etag,
    "last-modified": fixture.lastModified
  };

  if (!rangeHeader) {
    return {
      statusCode: 200,
      body: fixture.body,
      headers: {
        ...baseHeaders,
        "content-length": String(fixture.body.byteLength)
      }
    };
  }

  const range = parseByteRange(rangeHeader, fixture.body.byteLength);
  if (!range) {
    return {
      statusCode: 416,
      body: Buffer.alloc(0),
      headers: {
        ...baseHeaders,
        "content-range": `bytes */${fixture.body.byteLength}`,
        "content-length": "0"
      }
    };
  }

  const body = fixture.body.subarray(range.start, range.end + 1);
  return {
    statusCode: 206,
    body,
    headers: {
      ...baseHeaders,
      "content-range": `bytes ${range.start}-${range.end}/${fixture.body.byteLength}`,
      "content-length": String(body.byteLength)
    }
  };
}

export function recordApInteropMediaFixtureAccess(
  fixtureName: string,
  access: InteropMediaFixtureAccess
): void {
  const existing = accessLog.get(fixtureName) ?? [];
  existing.push(access);
  if (existing.length > ACCESS_LOG_LIMIT) {
    existing.splice(0, existing.length - ACCESS_LOG_LIMIT);
  }
  accessLog.set(fixtureName, existing);
}

export function listApInteropMediaFixtureAccesses(
  fixtureName: string
): InteropMediaFixtureAccess[] {
  return [...(accessLog.get(fixtureName) ?? [])];
}

export function resetApInteropMediaFixtureAccesses(fixtureName?: string): void {
  if (fixtureName) {
    accessLog.delete(fixtureName);
    return;
  }

  accessLog.clear();
}

function parseByteRange(
  headerValue: string,
  size: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const rawStart = match[1];
  const rawEnd = match[2];

  if (!rawStart && !rawEnd) {
    return null;
  }

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd || "", 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    const boundedLength = Math.min(suffixLength, size);
    return {
      start: size - boundedLength,
      end: size - 1
    };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return null;
  }

  const end = rawEnd
    ? Number.parseInt(rawEnd, 10)
    : size - 1;
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function buildFixtureEtag(body: Buffer): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}
