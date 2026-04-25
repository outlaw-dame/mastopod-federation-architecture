export interface ParsedCookies {
  readonly [name: string]: string;
}

export interface SerializeCookieOptions {
  name: string;
  value: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
  domain?: string;
}

export function parseCookieHeader(header: string | undefined): ParsedCookies {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!name || rawValue.length > 4096) continue;

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

export function serializeCookie(options: SerializeCookieOptions): string {
  const parts = [
    `${options.name}=${encodeURIComponent(options.value)}`,
    `Path=${options.path}`,
  ];

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (typeof options.maxAge === "number" && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  return parts.join("; ");
}
