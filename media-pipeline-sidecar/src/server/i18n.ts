export const supportedLocales = ['en', 'es'] as const

export type Locale = (typeof supportedLocales)[number]

const defaultLocale: Locale = 'en'

const messages: Record<Locale, Record<string, string>> = {
  en: {
    'ingress.sourceUrlCredentials': 'sourceUrl must not contain credentials',
    'ingress.contentTypeJson': 'content-type must be application/json',
    'ingress.invalidBody': 'invalid body',
    'ingress.ownerPrintable': 'ownerId must contain at least one printable character',
  },
  es: {
    'ingress.sourceUrlCredentials': 'sourceUrl no debe contener credenciales',
    'ingress.contentTypeJson': 'content-type debe ser application/json',
    'ingress.invalidBody': 'cuerpo no válido',
    'ingress.ownerPrintable': 'ownerId debe contener al menos un carácter imprimible',
  },
}

export function resolveLocale(headerValue: string | string[] | undefined): Locale {
  const normalized = Array.isArray(headerValue) ? headerValue.join(',') : headerValue
  if (!normalized) return defaultLocale

  const candidates = normalized
    .split(',')
    .map(part => part.trim().split(';')[0]?.toLowerCase())
    .filter(Boolean)

  for (const candidate of candidates) {
    const direct = supportedLocales.find(locale => locale === candidate)
    if (direct) return direct

    const prefix = supportedLocales.find(locale => candidate?.startsWith(`${locale}-`))
    if (prefix) return prefix
  }

  return defaultLocale
}

export function t(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const template = messages[locale][key] ?? messages[defaultLocale][key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, token: string) => String(params?.[token] ?? `{${token}}`))
}

export function appendVaryHeader(current: string | number | string[] | undefined, value: string): string {
  const raw = Array.isArray(current) ? current.join(',') : String(current || '')
  const items = new Set(raw.split(',').map(item => item.trim()).filter(Boolean))
  items.add(value)
  return Array.from(items).join(', ')
}
