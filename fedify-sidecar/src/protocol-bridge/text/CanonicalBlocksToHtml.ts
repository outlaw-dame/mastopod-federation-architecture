import type { CanonicalBlock } from "../canonical/CanonicalContent.js";

export function canonicalBlocksToHtml(blocks: readonly CanonicalBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return `<p>${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
        case "heading":
          return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
        case "blockquote":
          return `<blockquote>${escapeHtml(block.text).replace(/\n/g, "<br>")}</blockquote>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
          return `<${tag}>${items}</${tag}>`;
        }
        case "code": {
          const className = block.language ? ` class="language-${escapeHtml(block.language)}"` : "";
          return `<pre><code${className}>${escapeHtml(block.text)}</code></pre>`;
        }
        case "media":
          return "";
        case "embed":
          return `<p><a href="${escapeHtml(block.url)}">${escapeHtml(block.url)}</a></p>`;
      }
    })
    .filter((fragment) => fragment.length > 0)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
