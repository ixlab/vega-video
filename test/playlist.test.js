// test/playlist.test.js
import { describe, it, expect } from "bun:test";
import { buildHLSManifest } from "../src/playlist.js";

describe("buildHLSManifest", () => {
  it("builds a simple VOD playlist and timeline", () => {
    const rows = [
      {
        video_segments: [
          { duration: 2, uri: "a.ts" },
          { duration: 3, uri: "b.ts" }
        ]
      }
    ];

    const { manifest, timeline } = buildHLSManifest(rows, {});

    expect(manifest).toContain("#EXTM3U");
    expect(manifest).toContain("a.ts");
    expect(manifest).toContain("b.ts");
    expect(timeline[0]).toEqual(
      expect.objectContaining({ start: 0, end: 5 })
    );
  });

  it("includes fingerprint in timeline entries", () => {
    const rows = [
      {
        video_segments: [
          { duration: 2, uri: "a.ts" },
          { duration: 3, uri: "b.ts" }
        ]
      }
    ];
    const { timeline } = buildHLSManifest(rows, {});
    expect(timeline[0].fingerprint).toBe("a.ts:2|b.ts:3");
  });

  it("gives distinct fingerprints to different events", () => {
    const rows = [
      { video_segments: [{ duration: 4, uri: "x.ts" }] },
      { video_segments: [{ duration: 6, uri: "y.ts" }] }
    ];
    const { timeline } = buildHLSManifest(rows, {});
    expect(timeline[0].fingerprint).toBe("x.ts:4");
    expect(timeline[1].fingerprint).toBe("y.ts:6");
    expect(timeline[0].fingerprint).not.toBe(timeline[1].fingerprint);
  });
});
