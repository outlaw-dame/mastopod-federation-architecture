import { describe, expect, it } from "vitest";

import {
  listApInteropMediaFixtureAccesses,
  recordApInteropMediaFixtureAccess,
  resetApInteropMediaFixtureAccesses,
  resolveApInteropMediaFixtureResponse,
} from "./mediaFixtures.js";

describe("AP interop media fixtures", () => {
  it("serves the full MP4 fixture with stable headers", () => {
    const response = resolveApInteropMediaFixtureResponse("sample.mp4");
    expect(response).not.toBeNull();
    expect(response?.statusCode).toBe(200);
    expect(response?.headers["content-type"]).toBe("video/mp4");
    expect(response?.headers["accept-ranges"]).toBe("bytes");
    expect(response?.body.byteLength).toBeGreaterThan(0);
  });

  it("supports byte-range requests", () => {
    const response = resolveApInteropMediaFixtureResponse("sample.mp4", "bytes=0-31");
    expect(response).not.toBeNull();
    expect(response?.statusCode).toBe(206);
    expect(response?.headers["content-range"]).toMatch(/^bytes 0-31\//);
    expect(response?.body.byteLength).toBe(32);
  });

  it("tracks and resets fixture accesses", () => {
    resetApInteropMediaFixtureAccesses("sample.mp4");
    recordApInteropMediaFixtureAccess("sample.mp4", {
      method: "GET",
      receivedAt: Date.now(),
      userAgent: "fixture-test",
    });

    expect(listApInteropMediaFixtureAccesses("sample.mp4")).toHaveLength(1);
    resetApInteropMediaFixtureAccesses("sample.mp4");
    expect(listApInteropMediaFixtureAccesses("sample.mp4")).toHaveLength(0);
  });
});
