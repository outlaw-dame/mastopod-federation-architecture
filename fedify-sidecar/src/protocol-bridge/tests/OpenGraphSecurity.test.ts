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
  });

  it("refuses obvious loopback and private literal targets before making a request", async () => {
    await expect(fetchOpenGraph("http://127.0.0.1/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://localhost/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://[::1]/private")).resolves.toBeNull();
    await expect(fetchOpenGraph("http://192.168.1.20/private")).resolves.toBeNull();

    expect(requestMock).not.toHaveBeenCalled();
  });
});
