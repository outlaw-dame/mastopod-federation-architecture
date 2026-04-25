/**
 * FEP-c16b: Formatting MFM functions
 * https://codeberg.org/fediverse/fep/src/branch/main/fep/c16b
 *
 * Renders Misskey Flavored Markdown (MFM) functions to FEP-c16b-compliant HTML.
 *
 * MFM function syntax:
 *   $[name content]
 *   $[name.attr1,attr2=value content]
 *
 * HTML output per spec:
 *   <span class="mfm-name">content</span>
 *   <span class="mfm-name" data-mfm-attr1 data-mfm-attr2="value">content</span>
 *
 * Only non-nested MFM functions are handled; a full recursive parser is not
 * required for FEP-c16b compliance since the spec does not mandate nesting.
 */

/** JSON-LD @context extension term for FEP-c16b */
export const FEP_C16B_CONTEXT = {
  htmlMfm: "https://w3id.org/fep/c16b#htmlMfm",
} as const;

/** Canonical URI for the htmlMfm property */
export const FEP_C16B_HTML_MFM_URI = "https://w3id.org/fep/c16b#htmlMfm" as const;

/**
 * Pattern for one MFM function.
 * Groups:
 *   1 – function name  (e.g. "spin", "x2")
 *   2 – attribute list (e.g. "x,speed=0.5s")  — absent for plain $[name ...]
 *   3 – inner content
 */
const MFM_FUNCTION_RE = /\$\[([A-Za-z0-9_-]+)(?:\.([^\]\s]+))?\s([^\[\]]*)\]/g;

interface MfmAttr {
  name: string;
  value?: string;
}

function parseMfmAttributes(attrStr: string): MfmAttr[] {
  return attrStr.split(",").flatMap((part) => {
    const trimmed = part.trim();
    if (!trimmed) return [];
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return [{ name: trimmed }];
    return [{ name: trimmed.slice(0, eqIdx), value: trimmed.slice(eqIdx + 1) }];
  });
}

function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeMfmName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function renderMfmFunction(name: string, attrStr: string | undefined, content: string): string {
  const safe = safeMfmName(name);
  if (!safe) return content;
  const attrs = attrStr ? parseMfmAttributes(attrStr) : [];
  const dataAttrs = attrs
    .map((a) =>
      a.value !== undefined
        ? ` data-mfm-${a.name}="${escapeAttrValue(a.value)}"`
        : ` data-mfm-${a.name}`,
    )
    .join("");
  return `<span class="mfm-${safe}"${dataAttrs}>${content}</span>`;
}

/**
 * Returns true when the text contains at least one MFM function expression.
 */
export function looksLikeMfm(text: string): boolean {
  return /\$\[[A-Za-z0-9_-]+[\s.]/.test(text);
}

/**
 * Converts MFM function syntax in `text` to FEP-c16b-compliant HTML spans.
 * Non-MFM content is returned unchanged.
 * Only handles non-nested MFM functions.
 */
export function renderMfmToHtml(text: string): string {
  MFM_FUNCTION_RE.lastIndex = 0;
  return text.replace(MFM_FUNCTION_RE, (_match, name, attrStr, content) =>
    renderMfmFunction(name, attrStr, content),
  );
}
