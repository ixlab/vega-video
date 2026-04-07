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
  test("annotation config references Vega data source", () => {
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
        annotation: {
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
    expect(player.annotation.data).toBe("detections");
    expect(player.annotation.marks[0].type).toBe("boundingbox");
  });

  test("per-mark transforms are passed through to derived Vega data sources", () => {
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
        annotation: {
          data: "detections",
          marks: [
            {
              type: "boundingbox",
              transform: [
                { type: "filter", expr: "datum.confidence >= 0.3" }
              ],
              encode: { update: { class_id: { field: "class_id" } } }
            },
            {
              type: "label",
              transform: [
                { type: "filter", expr: "datum.confidence >= minConf" }
              ],
              encode: { update: { label: { signal: "datum.class_name" } } }
            }
          ]
        }
      }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    const dataNames = rewritten.data.map(d => d.name);
    expect(dataNames).toContain("main_annotation_0");
    expect(dataNames).toContain("main_annotation_1");

    // Transforms are passed through as-is
    const derived0 = rewritten.data.find(d => d.name === "main_annotation_0");
    expect(derived0.source).toBe("detections");
    expect(derived0.transform[0]).toEqual({ type: "filter", expr: "datum.confidence >= 0.3" });

    // Signal encode becomes a formula transform appended after filters
    const derived1 = rewritten.data.find(d => d.name === "main_annotation_1");
    expect(derived1.transform[0]).toEqual({ type: "filter", expr: "datum.confidence >= minConf" });
    expect(derived1.transform[1]).toEqual({ type: "formula", as: "_label", expr: "datum.class_name" });

    const player = rewritten.usermeta.players[0];
    expect(player.annotation.marks[1].encode.update.label).toEqual({ field: "_label" });

    expect(player.annotation.marks[0].from.data).toBe("main_annotation_0");
    expect(player.annotation.marks[0].transform).toBeUndefined();
    expect(player.annotation.marks[1].from.data).toBe("main_annotation_1");
  });

  test("marks without transforms or signal encodes keep using base data source", () => {
    const spec = {
      data: [{ name: "detections", url: "detections.json" }],
      players: [{
        name: "main",
        fps: 24,
        annotation: {
          data: "detections",
          marks: [
            { type: "boundingbox" },
            {
              type: "label",
              transform: [{ type: "filter", expr: "datum.confidence >= 0.5" }]
            }
          ]
        }
      }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    const player = rewritten.usermeta.players[0];
    expect(player.annotation.marks[0].from).toBeUndefined();
    expect(player.annotation.marks[1].from.data).toBe("main_annotation_1");
  });

  test("signal encodes without transforms still get a derived data source", () => {
    const spec = {
      data: [{ name: "detections", url: "detections.json" }],
      players: [{
        name: "main",
        fps: 24,
        annotation: {
          data: "detections",
          marks: [
            {
              type: "label",
              encode: { update: {
                label: { signal: "datum.class_name + ' ' + format(datum.confidence, '.2f')" }
              }}
            }
          ]
        }
      }]
    };

    const rewritten = rewriteSpec(spec, { videos: [{ name: "main" }] });

    // Should create a derived data source with the formula transform
    const derived = rewritten.data.find(d => d.name === "main_annotation_0");
    expect(derived).toBeDefined();
    expect(derived.source).toBe("detections");
    expect(derived.transform).toHaveLength(1);
    expect(derived.transform[0].type).toBe("formula");
    expect(derived.transform[0].as).toBe("_label");

    // Encode should now be a field reference
    const player = rewritten.usermeta.players[0];
    expect(player.annotation.marks[0].encode.update.label).toEqual({ field: "_label" });
    expect(player.annotation.marks[0].from.data).toBe("main_annotation_0");
  });
});
