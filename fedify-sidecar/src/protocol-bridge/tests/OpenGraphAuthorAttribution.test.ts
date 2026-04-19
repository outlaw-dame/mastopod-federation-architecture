import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("undici", () => ({
  request: requestMock,
}));

import { fetchOpenGraph } from "../../utils/opengraph.js";

describe("OpenGraph author attribution", () => {
  beforeEach(() => {
    requestMock.mockReset();
    delete process.env["ALLOW_PRIVATE_PREVIEW_FETCHES"];
    delete process.env["GOOGLE_SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_FAIL_CLOSED"];
  });

  it("resolves fediverse:creator into a Mastodon-style preview author and verifies allowed domains", async () => {
    requestMock
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: mockHtmlBody(`
          <html>
            <head>
              <meta property="og:title" content="Author Test" />
              <meta name="fediverse:creator" content="@alice@social.example" />
            </head>
            <body></body>
          </html>
        `),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/jrd+json" },
        body: mockJsonBody({
          subject: "acct:alice@social.example",
          links: [
            {
              rel: "self",
              type: "application/activity+json",
              href: "https://social.example/users/alice",
            },
            {
              rel: "http://webfinger.net/rel/profile-page",
              href: "https://social.example/@alice",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { "content-type": "application/activity+json" },
        body: mockJsonBody({
          id: "https://social.example/users/alice",
          type: "Person",
          name: "Alice Example",
          url: "https://social.example/@alice",
          icon: {
            type: "Image",
            url: "https://social.example/media/alice.png",
          },
          attributionDomains: ["example.com"],
        }),
      });

    const parsed = await fetchOpenGraph("https://example.com/articles/1");

    expect(parsed).toEqual({
      uri: "https://example.com/articles/1",
      title: "Author Test",
      description: undefined,
      thumbUrl: undefined,
      authorName: "Alice Example",
      authorUrl: "https://social.example/@alice",
      authors: [
        {
          name: "Alice Example",
          url: "https://social.example/@alice",
          handle: "@alice@social.example",
          verified: true,
          verificationState: "verified",
          verificationReason: "domain_authorized",
          account: {
            acct: "alice@social.example",
            uri: "https://social.example/users/alice",
            url: "https://social.example/@alice",
            displayName: "Alice Example",
            avatarUrl: "https://social.example/media/alice.png",
            attributionDomains: ["example.com"],
          },
        },
      ],
    });
  });
});

function mockHtmlBody(html: string) {
  let emitted = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (!emitted) {
        emitted = true;
        yield Buffer.from(html, "utf8");
      }
    },
    destroy: vi.fn(),
    on: vi.fn(),
    dump: vi.fn(async () => undefined),
    text: vi.fn(async () => html),
  };
}

function mockJsonBody(value: Record<string, unknown>) {
  return {
    text: vi.fn(async () => JSON.stringify(value)),
    dump: vi.fn(async () => undefined),
  };
}
