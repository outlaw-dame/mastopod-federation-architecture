/**
 * AT-side Markdown + OpenGraph + Live Preview Proof Script
 *
 * Validates without a running server, live network, or real ATProto accounts:
 *
 *   1. looksLikeMarkdown() — detects Markdown syntax correctly
 *   2. renderMarkdownToHtml() — renders GFM to HTML (no MFM)
 *   3. linkifyHashtagsInHtml() — linkifies #tags in rendered HTML
 *   4. fetchOpenGraph() — returns null gracefully on failures / non-HTML
 *   5. BskyPostTranslator — Markdown detection + linkPreview wired in
 *   6. StandardSiteDocumentTranslator — always-Markdown + linkPreview
 *   7. PostCreateToAtProjector — app.bsky.embed.external emitted for notes
 *
 * Usage:
 *   npx tsx src/at-adapter/tests/MarkdownOGLivePreviewProof.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

// Allow fetching from the ephemeral localhost servers spawned in this proof.
process.env["ALLOW_PRIVATE_PREVIEW_FETCHES"] = "1";

import {
  looksLikeMarkdown,
  renderMarkdownToHtml,
  linkifyHashtagsInHtml,
} from "../../utils/markdown.js";
import { fetchOpenGraph } from "../../utils/opengraph.js";
import { BskyPostTranslator } from "../../protocol-bridge/atproto/translators/BskyPostTranslator.js";
import { StandardSiteDocumentTranslator } from "../../protocol-bridge/atproto/translators/StandardSiteDocumentTranslator.js";
import { PostCreateToAtProjector } from "../../protocol-bridge/projectors/atproto/PostCreateToAtProjector.js";
import type { TranslationContext } from "../../protocol-bridge/ports/ProtocolBridgePorts.js";
import type { CanonicalPostCreateIntent } from "../../protocol-bridge/canonical/CanonicalIntent.js";
import type { ProjectionContext } from "../../protocol-bridge/ports/ProtocolBridgePorts.js";

// ============================================================================
// § 1  looksLikeMarkdown()
// ============================================================================

assert.equal(looksLikeMarkdown("Hello world"), false, "plain text → not Markdown");
assert.equal(looksLikeMarkdown("# Heading"), true,   "ATX heading → Markdown");
assert.equal(looksLikeMarkdown("**bold**"), true,     "bold → Markdown");
assert.equal(looksLikeMarkdown("- item"), true,       "unordered list → Markdown");
assert.equal(looksLikeMarkdown("`code`"), true,       "inline code → Markdown");
assert.equal(looksLikeMarkdown("[text](url)"), true,  "link → Markdown");
assert.equal(looksLikeMarkdown("> blockquote"), true, "blockquote → Markdown");
assert.equal(looksLikeMarkdown("1. item"), true,      "ordered list → Markdown");

console.log("  [ok] looksLikeMarkdown");

// ============================================================================
// § 2  renderMarkdownToHtml()
// ============================================================================

const boldHtml = renderMarkdownToHtml("**bold text**");
assert.ok(boldHtml.includes("<strong>bold text</strong>"), "bold renders to <strong>");

const headingHtml = renderMarkdownToHtml("## Heading\n\nParagraph.");
assert.ok(headingHtml.includes("<h2"), "heading renders to <h2>");
assert.ok(headingHtml.includes("<p>"), "paragraph renders to <p>");

// GFM line-break: single newline should produce <br> in breaks mode
const lineBreakHtml = renderMarkdownToHtml("line one\nline two");
assert.ok(
  lineBreakHtml.includes("line one") && lineBreakHtml.includes("line two"),
  "both lines present",
);

// Plain text falls back gracefully
const plainHtml = renderMarkdownToHtml("just text");
assert.ok(plainHtml.includes("just text"), "plain text preserved");

// No MFM: Misskey operator $$[x2 ...] is NOT processed — kept as literal text
const mfmInput = "$[x2 Big text]";
const mfmHtml = renderMarkdownToHtml(mfmInput);
assert.ok(!mfmHtml.includes("mfm-"), "MFM operator NOT processed on AT side");
assert.ok(mfmHtml.includes("Big text") || mfmHtml.includes("x2"), "MFM literal text preserved");

console.log("  [ok] renderMarkdownToHtml");

// ============================================================================
// § 3  linkifyHashtagsInHtml()
// ============================================================================

const rawHtml = "<p>Hello #World and #OpenSource</p>";
const linked = linkifyHashtagsInHtml(rawHtml, "https://pods.example");
assert.ok(linked.includes('href="https://pods.example/tags/world"'),  "World linkified");
assert.ok(linked.includes('href="https://pods.example/tags/opensource"'), "OpenSource linkified");
assert.ok(linked.includes('class="mention hashtag"'), "hashtag class present");
// Tags inside HTML attributes should NOT be linkified
const safeHtml = '<a href="https://example.com/#tag">link</a>';
const noDoubleLink = linkifyHashtagsInHtml(safeHtml, "https://pods.example");
assert.ok(!noDoubleLink.includes("/tags/tag"), "anchor href content not linkified");

console.log("  [ok] linkifyHashtagsInHtml");

// ============================================================================
// § 4  fetchOpenGraph() — failure paths (no live network needed)
// ============================================================================

// 4a. Non-URL → null
const ogNull = await fetchOpenGraph("not-a-url");
assert.equal(ogNull, null, "non-URL returns null");

// 4b. Non-http scheme → null
const ogFtp = await fetchOpenGraph("ftp://example.com/page");
assert.equal(ogFtp, null, "ftp:// returns null");

// 4c. Serve a minimal HTML page from a local server to test success path
const ogHtml = `<!DOCTYPE html><html><head>
  <meta property="og:title" content="Test Page Title" />
  <meta property="og:description" content="A short description." />
  <meta property="og:image" content="https://example.com/thumb.jpg" />
  <meta property="og:url" content="https://example.com/canonical" />
</head><body><p>Content</p></body></html>`;

const localServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(ogHtml);
});
await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
const port = (localServer.address() as { port: number }).port;

try {
  const ogResult = await fetchOpenGraph(`http://127.0.0.1:${port}/test`);
  assert.ok(ogResult !== null, "local OG fetch should succeed");
  assert.equal(ogResult.title, "Test Page Title", "og:title extracted");
  assert.equal(ogResult.description, "A short description.", "og:description extracted");
  assert.equal(ogResult.thumbUrl, "https://example.com/thumb.jpg", "og:image extracted");
  assert.equal(ogResult.uri, "https://example.com/canonical", "og:url used as canonical uri");
  console.log("  [ok] fetchOpenGraph (local server)");
} finally {
  await new Promise<void>((resolve) => localServer.close(() => resolve()));
}

// ============================================================================
// § 5  BskyPostTranslator — Markdown detection + linkPreview
// ============================================================================

const mockCtx: TranslationContext = {
  now: () => new Date("2026-01-01T00:00:00Z"),
  resolveActorRef: async ({ did }) => ({
    canonicalAccountId: `https://pods.test/users/${did ?? "unknown"}`,
    did: did ?? null,
    webId: null,
    activityPubActorUri: null,
    handle: null,
  }),
  resolveObjectRef: async ({ canonicalObjectId, atUri, cid }) => ({
    canonicalObjectId,
    atUri: atUri ?? null,
    cid: cid ?? null,
    activityPubObjectId: null,
    canonicalUrl: null,
  }),
};

const translator = new BskyPostTranslator();
assert.ok(translator.supports({
  repoDid: "did:plc:test0001",
  record: { $type: "app.bsky.feed.post", text: "hello" },
}), "translator supports bsky post envelope");

// 5a. Plain text — no Markdown rendering, no linkPreview
const plainIntent = await translator.translate(
  {
    repoDid: "did:plc:test0001",
    record: { $type: "app.bsky.feed.post", text: "Hello world" },
  },
  mockCtx,
) as CanonicalPostCreateIntent;

assert.ok(plainIntent !== null, "plain post translates");
assert.equal(plainIntent.content.html, null, "plain text → html is null");
assert.equal(plainIntent.content.linkPreview, null, "plain text → no linkPreview");

// 5b. Markdown text → html is rendered
const mdIntent = await translator.translate(
  {
    repoDid: "did:plc:test0001",
    record: { $type: "app.bsky.feed.post", text: "**bold** and _italic_" },
  },
  mockCtx,
) as CanonicalPostCreateIntent;

assert.ok(mdIntent.content.html !== null, "Markdown text → html is populated");
assert.ok(mdIntent.content.html!.includes("<strong>bold</strong>"), "html contains <strong>");

console.log("  [ok] BskyPostTranslator Markdown");

// 5c. Post with a link facet → linkPreview populated (via local mock server)
const ogServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head>
    <meta property="og:title" content="Linked Article" />
    <meta property="og:description" content="Description here." />
  </head><body></body></html>`);
});
await new Promise<void>((resolve) => ogServer.listen(0, "127.0.0.1", resolve));
const ogPort = (ogServer.address() as { port: number }).port;

try {
  const linkUrl = `http://127.0.0.1:${ogPort}/article`;
  const byteStart = 0;
  const byteEnd = linkUrl.length;
  const linkFacetIntent = await translator.translate(
    {
      repoDid: "did:plc:test0001",
      record: {
        $type: "app.bsky.feed.post",
        text: linkUrl,
        facets: [
          {
            index: { byteStart, byteEnd },
            features: [{ $type: "app.bsky.richtext.facet#link", uri: linkUrl }],
          },
        ],
      },
    },
    mockCtx,
  ) as CanonicalPostCreateIntent;

  assert.ok(linkFacetIntent.content.linkPreview !== null, "link facet → linkPreview populated");
  assert.equal(linkFacetIntent.content.linkPreview!.title, "Linked Article", "OG title in linkPreview");
  assert.equal(linkFacetIntent.content.linkPreview!.description, "Description here.", "OG description in linkPreview");
  console.log("  [ok] BskyPostTranslator linkPreview via link facet");
} finally {
  await new Promise<void>((resolve) => ogServer.close(() => resolve()));
}

// ============================================================================
// § 6  StandardSiteDocumentTranslator — always-Markdown + linkPreview
// ============================================================================

const docTranslator = new StandardSiteDocumentTranslator();
assert.ok(docTranslator.supports({
  repoDid: "did:plc:test0001",
  record: { $type: "site.standard.document", text: "# Hello", title: "Hello" },
}), "translator supports site.standard.document envelope");

const docServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head>
    <meta property="og:title" content="Doc Preview Title" />
  </head><body></body></html>`);
});
await new Promise<void>((resolve) => docServer.listen(0, "127.0.0.1", resolve));
const docPort = (docServer.address() as { port: number }).port;

try {
  const docUrl = `http://127.0.0.1:${docPort}/doc`;
  const docIntent = await docTranslator.translate(
    {
      repoDid: "did:plc:test0001",
      record: {
        $type: "site.standard.document",
        title: "My Document",
        text: "## Section\n\nBody with **bold** and #Fediverse.",
        url: docUrl,
        publishedAt: "2026-01-01T00:00:00Z",
      },
    },
    mockCtx,
  ) as CanonicalPostCreateIntent;

  assert.equal(docIntent.content.kind, "article", "document → article kind");
  assert.ok(docIntent.content.html !== null, "document → html always rendered");
  assert.ok(docIntent.content.html!.includes("<h2"), "Markdown heading rendered");
  assert.ok(docIntent.content.html!.includes("<strong>bold</strong>"), "bold rendered");
  assert.ok(docIntent.content.linkPreview !== null, "document → linkPreview from url");
  assert.equal(docIntent.content.linkPreview!.title, "Doc Preview Title", "OG title for document");
  console.log("  [ok] StandardSiteDocumentTranslator always-Markdown + linkPreview");
} finally {
  await new Promise<void>((resolve) => docServer.close(() => resolve()));
}

// ============================================================================
// § 7  PostCreateToAtProjector — app.bsky.embed.external emitted for notes
// ============================================================================

const projector = new PostCreateToAtProjector();

const noteIntentWithPreview: CanonicalPostCreateIntent = {
  kind: "PostCreate",
  canonicalIntentId: "urn:test:proof:001",
  sourceProtocol: "atproto",
  sourceEventId: "at://did:plc:test0001/app.bsky.feed.post/proof001",
  sourceAccountRef: {
    canonicalAccountId: "https://pods.test/users/alice",
    did: "did:plc:test0001",
    webId: null,
    activityPubActorUri: null,
    handle: null,
  },
  object: {
    canonicalObjectId: "at://did:plc:test0001/app.bsky.feed.post/proof001",
    atUri: "at://did:plc:test0001/app.bsky.feed.post/proof001",
    cid: null,
    activityPubObjectId: null,
    canonicalUrl: null,
  },
  createdAt: "2026-01-01T00:00:00Z",
  observedAt: "2026-01-01T00:00:00Z",
  visibility: "public",
  provenance: {
    originProtocol: "atproto",
    originEventId: "at://did:plc:test0001/app.bsky.feed.post/proof001",
    originAccountId: "did:plc:test0001",
    mirroredFromCanonicalIntentId: null,
    projectionMode: "native",
  },
  warnings: [],
  inReplyTo: null,
  content: {
    kind: "note",
    title: null,
    summary: null,
    plaintext: "Check out https://example.com/page",
    html: null,
    language: "en",
    blocks: [],
    facets: [],
    attachments: [],
    externalUrl: null,
    linkPreview: {
      uri: "https://example.com/page",
      title: "Example Page",
      description: "A description.",
      thumbUrl: null,
    },
  },
};

const mockProjCtx: ProjectionContext = {
  resolveActorRef: async (ref) => ({
    did: ref.did ?? "did:plc:test0001",
    handle: "alice.test",
    canonicalAccountId: ref.canonicalAccountId ?? null,
    webId: ref.webId ?? null,
    activityPubActorUri: ref.activityPubActorUri ?? null,
  }),
  resolveObjectRef: async (ref) => ref,
  buildIntentId: () => "urn:test:projection",
  now: () => new Date("2026-01-01T00:00:00Z"),
};

const projResult = await projector.project(noteIntentWithPreview, mockProjCtx);
assert.equal(projResult.kind, "success", `projector returned success, got: ${JSON.stringify(projResult)}`);
if (projResult.kind === "success") {
  const postCmd = projResult.commands.find(
    (c) => c.kind === "createRecord" && c.collection === "app.bsky.feed.post",
  );
  assert.ok(postCmd, "createRecord command for app.bsky.feed.post emitted");
  if (postCmd?.kind === "createRecord") {
    const record = postCmd.record as Record<string, unknown>;
    assert.ok(record["embed"], "embed field present on post record");
    const embed = record["embed"] as Record<string, unknown>;
    assert.equal(embed["$type"], "app.bsky.embed.external", "embed type is app.bsky.embed.external");
    const external = embed["external"] as Record<string, unknown>;
    assert.equal(external["uri"], "https://example.com/page", "embed.external.uri");
    assert.equal(external["title"], "Example Page", "embed.external.title");
    assert.equal(external["description"], "A description.", "embed.external.description");
  }
}
console.log("  [ok] PostCreateToAtProjector embed.external for notes");

// 7b. Article intent → teaser post carries embed.external from article link preview
const articleIntent: CanonicalPostCreateIntent = {
  ...noteIntentWithPreview,
  canonicalIntentId: "urn:test:proof:002",
  content: {
    ...noteIntentWithPreview.content,
    kind: "article",
    title: "My Article",
    summary: "Summary.",
    externalUrl: "https://pods.test/articles/1",
    linkPreview: {
      uri: "https://example.com/article-page",
      title: "Article Preview",
      description: null,
      thumbUrl: null,
    },
  },
};

const articleProjResult = await projector.project(articleIntent, mockProjCtx);
assert.equal(articleProjResult.kind, "success", "article projector returned success");
if (articleProjResult.kind === "success") {
  const postCmd = articleProjResult.commands.find(
    (c) => c.kind === "createRecord" && c.collection === "app.bsky.feed.post",
  );
  if (postCmd?.kind === "createRecord") {
    const record = postCmd.record as Record<string, unknown>;
    assert.ok(record["embed"], "article teaser post record has embed");
    const embed = record["embed"] as Record<string, unknown>;
    assert.equal(embed["$type"], "app.bsky.embed.external", "article embed type is app.bsky.embed.external");
  }
}
console.log("  [ok] PostCreateToAtProjector embed.external for article teaser posts");

// ============================================================================
// Done
// ============================================================================

console.log("\nat_side_markdown_og_live_preview_proof_ok");
