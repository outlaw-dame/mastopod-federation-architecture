import { describe, expect, it } from "vitest";
import { FEP_C16B_CONTEXT, FEP_C16B_HTML_MFM_URI, looksLikeMfm, renderMfmToHtml } from "../mfm.js";

// Spec examples are taken directly from FEP-c16b.

describe("FEP-c16b MFM renderer", () => {
  // ---------------------------------------------------------------------------
  // FEP_C16B_CONTEXT
  // ---------------------------------------------------------------------------
  describe("FEP_C16B_CONTEXT", () => {
    it("maps htmlMfm to the canonical URI", () => {
      expect(FEP_C16B_CONTEXT.htmlMfm).toBe("https://w3id.org/fep/c16b#htmlMfm");
    });

    it("FEP_C16B_HTML_MFM_URI equals the canonical URI", () => {
      expect(FEP_C16B_HTML_MFM_URI).toBe(FEP_C16B_CONTEXT.htmlMfm);
    });
  });

  // ---------------------------------------------------------------------------
  // looksLikeMfm
  // ---------------------------------------------------------------------------
  describe("looksLikeMfm", () => {
    it("returns true for a basic MFM function (no attributes)", () => {
      expect(looksLikeMfm("$[x2 text]")).toBe(true);
    });

    it("returns true for an MFM function with attributes", () => {
      expect(looksLikeMfm("$[spin.x,speed=0.5s text]")).toBe(true);
    });

    it("returns true when MFM appears mid-sentence", () => {
      expect(looksLikeMfm("Hello $[x2 world]!")).toBe(true);
    });

    it("returns false for plain text", () => {
      expect(looksLikeMfm("Hello world")).toBe(false);
    });

    it("returns false for a bare dollar sign", () => {
      expect(looksLikeMfm("$100")).toBe(false);
    });

    it("returns false for $[ without a valid name start", () => {
      expect(looksLikeMfm("$[ invalid]")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // renderMfmToHtml — spec examples
  // ---------------------------------------------------------------------------
  describe("renderMfmToHtml", () => {
    it("renders $[x2 …] (no attributes)", () => {
      expect(renderMfmToHtml("$[x2 Misskey expands the world of the Fediverse]")).toBe(
        '<span class="mfm-x2">Misskey expands the world of the Fediverse</span>',
      );
    });

    it("renders $[jelly.speed=2s …] (single valued attribute)", () => {
      expect(renderMfmToHtml("$[jelly.speed=2s Misskey expands the world of the Fediverse]")).toBe(
        '<span class="mfm-jelly" data-mfm-speed="2s">Misskey expands the world of the Fediverse</span>',
      );
    });

    it("renders $[spin.x,speed=0.5s …] (flag attr + valued attr)", () => {
      // FEP-c16b example uses $[spin.x,speed=0.5s …] — note: spec shows mfm-flip in one
      // example but the function name in the input here is "spin".
      expect(renderMfmToHtml("$[spin.x,speed=0.5s Misskey expands the world of the Fediverse]")).toBe(
        '<span class="mfm-spin" data-mfm-x data-mfm-speed="0.5s">Misskey expands the world of the Fediverse</span>',
      );
    });

    it("renders $[center …] (no attributes)", () => {
      expect(renderMfmToHtml("$[center Hello]")).toBe('<span class="mfm-center">Hello</span>');
    });

    it("renders multiple MFM functions in one string", () => {
      const input = "$[x2 Hello] and $[jelly.speed=1s world]";
      const expected =
        '<span class="mfm-x2">Hello</span> and <span class="mfm-jelly" data-mfm-speed="1s">world</span>';
      expect(renderMfmToHtml(input)).toBe(expected);
    });

    it("leaves plain text unchanged", () => {
      expect(renderMfmToHtml("Hello world")).toBe("Hello world");
    });

    it("leaves HTML that is not MFM unchanged", () => {
      const html = '<p>Hello <strong>world</strong></p>';
      expect(renderMfmToHtml(html)).toBe(html);
    });

    it("escapes special characters in attribute values", () => {
      expect(renderMfmToHtml('$[jelly.speed=2s<&"> text]')).toBe(
        '<span class="mfm-jelly" data-mfm-speed="2s&lt;&amp;&quot;&gt;">text</span>',
      );
    });

    it("handles a flag-only attribute list", () => {
      expect(renderMfmToHtml("$[flip.h,v text]")).toBe(
        '<span class="mfm-flip" data-mfm-h data-mfm-v>text</span>',
      );
    });

    it("is idempotent on non-MFM content (multiple calls)", () => {
      const plain = "No MFM here.";
      expect(renderMfmToHtml(renderMfmToHtml(plain))).toBe(plain);
    });

    it("sanitises the function name to lowercase alphanumeric", () => {
      // Names are already required to be [A-Za-z0-9_-] by the regex,
      // but safeMfmName also lowercases.
      expect(renderMfmToHtml("$[X2 text]")).toBe('<span class="mfm-x2">text</span>');
    });
  });
});
