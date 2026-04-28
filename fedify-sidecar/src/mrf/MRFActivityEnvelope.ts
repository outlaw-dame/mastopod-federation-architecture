import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MRFContentSignals {
  /** Normalized plain text (HTML stripped). Null when no content body present. */
  text: string | null;
  /** Raw href values extracted from HTML <a> tags (AP) or facet link features (AT). */
  urls: string[];
  /** Unique sanitized hostnames derived from urls. */
  domains: string[];
  /** Lowercase hashtag text without leading #. */
  hashtags: string[];
  /** Number of @mention facets / cc recipients excluding AS_Public. */
  mentionCount: number;
}

export interface MRFActorSignals {
  /** Unix ms timestamp of actor creation (null when unavailable). */
  publishedAtMs: number | null;
  /** Known follower count (null when unavailable). */
  followerCount: number | null;
  hasAvatar: boolean;
  hasBio: boolean;
}

export interface MRFActivityEnvelope {
  activityId: string;
  /** Actor URI (AP) or DID (AT). */
  actorId: string;
  /** Hostname extracted from actorId. Null when not derivable. */
  originHost: string | null;
  protocol: "ap" | "at";
  visibility: "public" | "unlisted" | "followers" | "direct" | "unknown";
  content: MRFContentSignals;
  actor: MRFActorSignals;
  requestId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const AS_PUBLIC_SHORT = "as:Public";

const HREF_PATTERN = /<a\b[^>]*\bhref=["']([^"' >]+)["']/gi;

function extractLinksFromHtml(html: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex to be safe (pattern is global)
  HREF_PATTERN.lastIndex = 0;
  const re = new RegExp(HREF_PATTERN.source, "gi");
  while ((m = re.exec(html)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  return urls;
}

function extractDomainsFromUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  for (const url of urls) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname && !seen.has(hostname)) seen.add(hostname);
    } catch {
      // ignore malformed URLs
    }
  }
  return [...seen];
}

function extractOriginHost(actorId: string): string | null {
  // did:web URIs encode the host as the first colon-separated path component.
  // Check before URL parsing because new URL() won't throw on "did:web:..." —
  // it just gives an empty hostname.
  if (actorId.startsWith("did:web:")) {
    const part = actorId.slice("did:web:".length).split(":")[0] ?? "";
    return part || null;
  }
  try {
    return new URL(actorId).hostname || null;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// AP builder
// ---------------------------------------------------------------------------

export function buildEnvelopeFromAP(opts: {
  activityId: string;
  actorUri: string;
  actorDocument: Record<string, unknown> | null;
  activity: Record<string, unknown>;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
  requestId?: string;
}): MRFActivityEnvelope {
  const { activityId, actorUri, actorDocument, activity, visibility, requestId } = opts;

  // --- Content signals ---
  const obj = activity["object"];
  const objRec: Record<string, unknown> | null =
    obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;

  let rawContent: string | null = null;
  if (objRec) {
    if (typeof objRec["content"] === "string" && (objRec["content"] as string).length > 0) {
      rawContent = objRec["content"] as string;
    } else {
      const cm = objRec["contentMap"];
      if (cm !== null && typeof cm === "object" && !Array.isArray(cm)) {
        const first = Object.values(cm as Record<string, unknown>).find(
          (v) => typeof v === "string" && (v as string).length > 0,
        );
        if (typeof first === "string") rawContent = first;
      }
    }
  }

  const urls = rawContent ? extractLinksFromHtml(rawContent) : [];
  const domains = extractDomainsFromUrls(urls);

  const hashtags: string[] = [];
  if (objRec) {
    const tags = objRec["tag"];
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (t === null || typeof t !== "object" || Array.isArray(t)) continue;
        const tag = t as Record<string, unknown>;
        if (tag["type"] === "Hashtag" && typeof tag["name"] === "string") {
          hashtags.push((tag["name"] as string).replace(/^#/, "").toLowerCase());
        }
      }
    }
  }

  let mentionCount = 0;
  const cc = activity["cc"];
  if (Array.isArray(cc)) {
    mentionCount = cc.filter(
      (uri) => typeof uri === "string" && uri !== AS_PUBLIC && uri !== AS_PUBLIC_SHORT,
    ).length;
  }

  const text = rawContent ? stripHtml(rawContent) : null;

  // --- Actor signals ---
  let publishedAtMs: number | null = null;
  let followerCount: number | null = null;
  let hasAvatar = false;
  let hasBio = false;

  if (actorDocument) {
    const pub = actorDocument["published"];
    if (typeof pub === "string") {
      const d = new Date(pub);
      if (!isNaN(d.getTime())) publishedAtMs = d.getTime();
    }

    const followers = actorDocument["followers"];
    if (followers !== null && typeof followers === "object" && !Array.isArray(followers)) {
      const fo = followers as Record<string, unknown>;
      if (typeof fo["totalItems"] === "number") followerCount = fo["totalItems"] as number;
    }

    hasAvatar = !!actorDocument["icon"];
    hasBio = !!actorDocument["summary"];
  }

  return {
    activityId,
    actorId: actorUri,
    originHost: extractOriginHost(actorUri),
    protocol: "ap",
    visibility: visibility ?? "unknown",
    content: { text, urls, domains, hashtags, mentionCount },
    actor: { publishedAtMs, followerCount, hasAvatar, hasBio },
    requestId: requestId ?? randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// AT builder
// ---------------------------------------------------------------------------

export function buildEnvelopeFromAT(opts: {
  did: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
  requestId?: string;
}): MRFActivityEnvelope | null {
  const { did, collection, rkey, record, requestId } = opts;

  if (collection !== "app.bsky.feed.post") return null;

  const text = typeof record["text"] === "string" ? (record["text"] as string) : null;

  const urls: string[] = [];
  const hashtags: string[] = [];
  let mentionCount = 0;

  const facets = record["facets"];
  if (Array.isArray(facets)) {
    for (const facet of facets) {
      if (facet === null || typeof facet !== "object") continue;
      const features = (facet as Record<string, unknown>)["features"];
      if (!Array.isArray(features)) continue;

      for (const feature of features) {
        if (feature === null || typeof feature !== "object") continue;
        const feat = feature as Record<string, unknown>;
        const type = feat["$type"];

        if (type === "app.bsky.richtext.facet#link" && typeof feat["uri"] === "string") {
          urls.push(feat["uri"] as string);
        } else if (type === "app.bsky.richtext.facet#tag" && typeof feat["tag"] === "string") {
          hashtags.push((feat["tag"] as string).toLowerCase());
        } else if (type === "app.bsky.richtext.facet#mention") {
          mentionCount++;
        }
      }
    }
  }

  const domains = extractDomainsFromUrls(urls);

  return {
    activityId: `at://${did}/${collection}/${rkey}`,
    actorId: did,
    originHost: extractOriginHost(did),
    protocol: "at",
    // AT firehose posts are public by definition
    visibility: "public",
    content: { text, urls, domains, hashtags, mentionCount },
    actor: {
      publishedAtMs: null,
      followerCount: null,
      hasAvatar: false,
      hasBio: false,
    },
    requestId: requestId ?? randomUUID(),
  };
}
