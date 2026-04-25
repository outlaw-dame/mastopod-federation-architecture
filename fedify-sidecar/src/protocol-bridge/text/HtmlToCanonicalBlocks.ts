import type { CanonicalBlock } from "../canonical/CanonicalContent.js";

export interface HtmlToCanonicalBlocksResult {
  plaintext: string;
  blocks: CanonicalBlock[];
  warning?: string;
}

const BLOCK_TAG_PATTERN =
  /<(h[1-6]|blockquote|pre|ul|ol|p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

export function htmlToCanonicalBlocks(html: string): HtmlToCanonicalBlocksResult {
  const source = html.replace(/\r\n/g, "\n").trim();
  if (source.length === 0) {
    return { plaintext: "", blocks: [] };
  }

  const blocks: CanonicalBlock[] = [];
  const warning = /<[^>]+>/.test(source) ? "Rich HTML was normalized into canonical blocks." : undefined;
  let cursor = 0;

  for (const match of source.matchAll(BLOCK_TAG_PATTERN)) {
    const matched = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      appendLooseTextBlocks(stripHtml(source.slice(cursor, index)), blocks);
    }

    const tag = match[1]?.toLowerCase() ?? "p";
    const attributes = match[2] ?? "";
    const innerHtml = match[3] ?? "";
    appendTaggedBlock(tag, attributes, innerHtml, blocks);
    cursor = index + matched.length;
  }

  if (cursor < source.length) {
    appendLooseTextBlocks(stripHtml(source.slice(cursor)), blocks);
  }

  if (blocks.length === 0) {
    appendLooseTextBlocks(stripHtml(source), blocks);
  }

  const plaintext = blocksToPlaintext(blocks);
  return { plaintext, blocks, warning };
}

function appendTaggedBlock(
  tag: string,
  attributes: string,
  innerHtml: string,
  blocks: CanonicalBlock[],
): void {
  if (tag.startsWith("h")) {
    const level = Number.parseInt(tag.slice(1), 10);
    const text = stripHtml(innerHtml);
    if (text) {
      blocks.push({ type: "heading", level: clampHeadingLevel(level), text });
    }
    return;
  }

  if (tag === "blockquote") {
    const text = stripHtml(innerHtml);
    if (text) {
      blocks.push({ type: "blockquote", text });
    }
    return;
  }

  if (tag === "pre") {
    const languageMatch = attributes.match(/language-([\w-]+)/i) ?? innerHtml.match(/language-([\w-]+)/i);
    const text = decodeEntities(innerHtml.replace(/<code\b[^>]*>/gi, "").replace(/<\/code>/gi, ""));
    if (text.trim()) {
      blocks.push({ type: "code", language: languageMatch?.[1] ?? null, text: text.trimEnd() });
    }
    return;
  }

  if (tag === "ul" || tag === "ol") {
    const items = Array.from(innerHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi))
      .map((match) => stripHtml(match[1] ?? ""))
      .filter((item) => item.length > 0);
    if (items.length > 0) {
      blocks.push({ type: "list", ordered: tag === "ol", items });
      return;
    }
  }

  appendLooseTextBlocks(stripHtml(innerHtml), blocks);
}

function appendLooseTextBlocks(text: string, blocks: CanonicalBlock[]): void {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return;
  }

  for (const paragraph of normalized.split(/\n{2,}/)) {
    const cleaned = paragraph.trim();
    if (cleaned.length > 0) {
      blocks.push({ type: "paragraph", text: cleaned });
    }
  }
}

function stripHtml(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function clampHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (level < 1) return 1;
  if (level > 6) return 6;
  return level as 1 | 2 | 3 | 4 | 5 | 6;
}

function blocksToPlaintext(blocks: readonly CanonicalBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
        case "blockquote":
        case "code":
          return block.text;
        case "heading":
          return block.text;
        case "list":
          return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n");
        case "media":
          return "";
        case "embed":
          return block.url;
      }
    })
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}
