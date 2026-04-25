import type { FastifyReply } from "fastify";

export const supportedLocales = ["en", "es"] as const;

export type Locale = (typeof supportedLocales)[number];

const defaultLocale: Locale = "en";

const messages: Record<Locale, Record<string, string>> = {
  en: {
    "common.unauthorized": "Unauthorized",
    "common.forbidden": "Forbidden",
    "common.serviceUnavailable": "Service unavailable",
    "common.invalidJsonBody": "Invalid JSON body",
    "common.missingStringActorField": "Missing string actor field",
    "common.notFound": "Not Found",
    "common.internalServerError": "Internal server error",
    "admin.missingReadPermission": "Missing required permission: provider:read",
  },
  es: {
    "common.unauthorized": "No autorizado",
    "common.forbidden": "Prohibido",
    "common.serviceUnavailable": "Servicio no disponible",
    "common.invalidJsonBody": "Cuerpo JSON no válido",
    "common.missingStringActorField": "Falta un campo actor de tipo string",
    "common.notFound": "No encontrado",
    "common.internalServerError": "Error interno del servidor",
    "admin.missingReadPermission": "Falta el permiso requerido: provider:read",
  },
};

export function resolveLocale(headerValue: string | string[] | undefined): Locale {
  const normalized = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  if (!normalized) {
    return defaultLocale;
  }

  const candidates = normalized
    .split(",")
    .map((part) => part.trim().split(";")[0]?.toLowerCase())
    .filter(Boolean);

  for (const candidate of candidates) {
    const direct = supportedLocales.find((locale) => locale === candidate);
    if (direct) {
      return direct;
    }

    const prefix = supportedLocales.find((locale) => candidate?.startsWith(`${locale}-`));
    if (prefix) {
      return prefix;
    }
  }

  return defaultLocale;
}

export function t(locale: Locale, key: string): string {
  return messages[locale][key] ?? messages[defaultLocale][key] ?? key;
}

export function applyLocaleHeaders(reply: FastifyReply, locale: Locale): void {
  reply.header("content-language", locale);
  const currentVary = reply.getHeader("vary");
  const varyValues = new Set(
    String(Array.isArray(currentVary) ? currentVary.join(",") : currentVary ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  varyValues.add("Accept-Language");
  reply.header("vary", Array.from(varyValues).join(", "));
}
