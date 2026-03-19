// test/annotation.test.js
import { expect, test, describe } from "bun:test";
import { rewriteSpec } from "../src/compile.js";

describe("compile.js signal rewriting", () => {
  test("rewrites @player:signal references", () => {
    const spec = {
      players: [{ name: "main" }],
      marks: [{
        type: "rule",
        encode: {
          update: {
            x: { signal: "@main:time * 10" }
          }
        }
      }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    expect(rewritten.usermeta.__vegaVideoRewritten).toBe(true);
    expect(rewritten.marks[0].encode.update.x.signal).toBe("main_time * 10");
  });

  test("injects default signals for player namespace", () => {
    const spec = {
      players: [{ name: "main" }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    const signalNames = rewritten.signals.map(s => s.name);
    expect(signalNames).toContain("main_time");
    expect(signalNames).toContain("main_frame_index");
    expect(signalNames).toContain("main_duration");
  });

  test("moves players to usermeta", () => {
    const spec = {
      players: [{ name: "main", fps: 24 }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    expect(rewritten.players).toBeUndefined();
    expect(rewritten.usermeta.players).toBeDefined();
    expect(rewritten.usermeta.players[0].name).toBe("main");
  });
});

describe("new annotation grammar", () => {
  test("overlay config references Vega data source", () => {
    const spec = {
      data: [{
        name: "detections",
        url: "detections.json",
        transform: [
          { type: "filter", expr: "datum.frame_index == main_frame_index" }
        ]
      }],
      players: [{
        name: "main",
        fps: 24,
        overlay: {
          data: "detections",
          marks: [{ type: "boundingbox" }]
        }
      }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    // Data should remain in spec (Vega handles it)
    expect(rewritten.data[0].name).toBe("detections");
    expect(rewritten.data[0].transform[0].type).toBe("filter");

    // Overlay config should be preserved in usermeta
    const player = rewritten.usermeta.players[0];
    expect(player.overlay.data).toBe("detections");
    expect(player.overlay.marks[0].type).toBe("boundingbox");
  });
});
