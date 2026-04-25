import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("undici", () => ({
  request: requestMock,
}));

import { fetchOpenGraph } from "../../utils/opengraph.js";

describe("OpenGraph preview fetching security", () => {
  beforeEach(() => {
    requestMock.mockReset();
    delete process.env["ALLOW_PRIVATE_PREVIEW_FETCHES"];
    delete process.env["GOOGLE_SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_API_KEY"];
    delete process.env["SAFE_BROWSING_FAIL_CLOSED"];
  });

  it("refuses obvious loopback and private literal targets before making a request", async () => {
    await expect(fetchOpenGraph("http://127.0.0.1/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://localhost/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://[::1]/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://192.168.1.20/private")).resolves.toBeNull();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it("drops unsafe OG canonical/image URLs from parsed metadata", async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: mockHtmlBody(`
        <html>
          <head>
            <meta property="og:title" content="Unsafe OG" />
            <meta property="og:url" content="javascript:alert(1)" />
            <meta property="og:image" content="data:text/plain;base64,Zm9v" />
          </head>
          <body></body>
        </html>
      `),
    });

    const parsed = await fetchOpenGraph("https://example.com/post");
    expect(parsed).toEqual({
      uri: "https://example.com/post",
      title: "Unsafe OG",
      description: undefined,
      thumbUrl: undefined,
    });
  });

  it("blocks malicious targets when Google Safe Browsing reports threats", async () => {
    process.env["GOOGLE_SAFE_BROWSING_API_KEY"] = "test-api-key";

    requestMock.mockImplementationOnce(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        text: async () => JSON.stringify({
          threats: [
            {
              threatType: "MALWARE",
            },
          ],
        }),
      },
    }));

    await expect(fetchOpenGraph("https://malicious.example/phishing")).resolves.toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0]).toContain("safebrowsing.googleapis.com");
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
