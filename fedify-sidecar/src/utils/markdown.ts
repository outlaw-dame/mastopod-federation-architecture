/**
 * AT-side Markdown rendering utility.
 *
 * Renders CommonMark / GitHub-Flavored Markdown to HTML.
 * No MFM (Misskey Flavored Markdown) — AT side only.
 * Hashtags in the rendered HTML are linkified to /tags/<tag> when a baseUrl
 * is provided.
 *
 * Uses `marked` (GFM + line-break mode).
 */

import { createRequire } from "node:module";

type MarkedRenderer = {
  use(options: Record<string, unknown>): void;
  parse(input: string, options?: Record<string, unknown>): string | Promise<string>;
};

const marked = loadMarkedRenderer();

/**
 * Detect whether the given text string is likely Markdown.
 * Conservative heuristic — only triggers on unambiguous Markdown markers.
 */
export function looksLikeMarkdown(text: string): boolean {
  // ATX headings, bold/italic, inline code, fenced code, blockquote, lists, links
  return /^#{1,6}\s|`{1,3}|\*\*[^*]|__[^_]|\[.+\]\(|^\s*[-*+]\s|\n\s*[-*+]\s|^\s*>\s|\n\s*>\s|^\s*\d+\.\s|\n\s*\d+\.\s/m.test(
    text,
  );
}

/**
 * Render Markdown text to an HTML string.
 *
 * @param text    Raw Markdown (or plain text – renders gracefully as <p>).
 * @param options.baseUrl  When provided, inline #hashtags are linkified to
 *                         `{origin}/tags/{tag}`.
 */
export function renderMarkdownToHtml(
  text: string,
  options?: { baseUrl?: string },
): string {
  const html = marked
    ? (marked.parse(text, { async: false }) as string)
    : renderEscapedHtml(text);
  return options?.baseUrl ? linkifyHashtagsInHtml(html, options.baseUrl) : html;
}

/**
 * Linkify #hashtags found in HTML text nodes.
 * Segments inside HTML tags (attributes, tag names) are left untouched.
 *
 * @param html     Raw HTML string from the Markdown renderer.
 * @param baseUrl  Origin used to build href, e.g. "https://example.com".
 */
export function linkifyHashtagsInHtml(html: string, baseUrl: string): string {
  const origin = safeOrigin(baseUrl);
  if (!origin) return html;

  // Unicode-aware hashtag regex: 
  // Matches # followed by alphanumeric Unicode characters/underscores, 
  // but ensures the body is not purely numeric to match Mastodon behavior.
  const HASHTAG_REGEX = /(^|[^\p{L}\p{N}_&;\/])#(?!\d+\b)([\p{L}\p{N}_]+)/gu;

  const segments = html.split(/(<[^>]+>)/g);
  let insideExcluded = 0;

  return segments.map(segment => {
    if (!segment) return "";
    if (segment.startsWith("<")) {
      const tagName = segment.match(/^<\/?([a-z0-9]+)/i)?.[1]?.toLowerCase();
      if (tagName && ["pre", "code", "a"].includes(tagName)) {
        if (segment.startsWith("</")) {
          insideExcluded = Math.max(0, insideExcluded - 1);
        } else if (!segment.endsWith("/>")) {
          insideExcluded++;
        }
      }
      return segment;
    }

    if (insideExcluded > 0) return segment;

    return segment.replace(HASHTAG_REGEX, (match, prefix, tag: string) => {
      const normalized = tag.toLowerCase();
      return `${prefix}<a href="${escapeAttr(origin)}/tags/${encodeURIComponent(normalized)}" class="mention hashtag" rel="tag">#${escapeHtml(tag)}</a>`;
    });
  }).join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeOrigin(url: string): string | undefined {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    return new URL(normalized).origin;
  } catch {
    return undefined;
  }
}

function loadMarkedRenderer(): MarkedRenderer | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require("marked") as { marked?: MarkedRenderer };
    if (!loaded?.marked) {
      return null;
    }
    loaded.marked.use({ gfm: true, breaks: true, async: false });
    return loaded.marked;
  } catch {
    return null;
  }
}

function renderEscapedHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split("\n").map((line) => escapeHtml(line)).join("<br>"));
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
