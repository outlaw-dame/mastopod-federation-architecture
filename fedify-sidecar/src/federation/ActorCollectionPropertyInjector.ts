const ACTOR_PATH_RE = /^\/users\/([^/?#]+)$/;

export interface InjectedActorCollectionProperty {
  property: string;
  suffix: string;
}

function pushUniqueContextValue(target: unknown[], value: unknown): void {
  const serialized = JSON.stringify(value);
  const exists = target.some(entry => JSON.stringify(entry) === serialized);
  if (!exists) {
    target.push(value);
  }
}

export function injectActorCollectionProperties(
  requestPath: string,
  body: string,
  domain: string,
  properties: InjectedActorCollectionProperty[],
  contextAdditions: unknown[] = [],
): string {
  const path = requestPath.split("?")[0] ?? requestPath;
  const match = ACTOR_PATH_RE.exec(path);
  if (!match || !match[1]) {
    return body;
  }

  const identifier = match[1];

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

  const docType = doc["type"] ?? doc["@type"];
  if (docType == null) {
    return body;
  }

  for (const property of properties) {
    doc[property.property] = `https://${domain}/users/${encodeURIComponent(identifier)}${property.suffix}`;
  }

  if (contextAdditions.length > 0) {
    const existingContext = doc["@context"];
    const nextContext: unknown[] = Array.isArray(existingContext)
      ? [...existingContext]
      : existingContext != null
        ? [existingContext]
        : [];

    for (const addition of contextAdditions) {
      pushUniqueContextValue(nextContext, addition);
    }

    doc["@context"] = nextContext;
  }

  try {
    return JSON.stringify(doc);
  } catch {
    return body;
  }
}
