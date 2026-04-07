// test/compile.test.js
import { describe, it, expect } from "bun:test";
import { rewriteSpec } from "../src/compile.js";

describe("rewriteSpec", () => {
  it("adds default signals for namespaces in usermeta", () => {
    const spec = {
      players: {
        video1: {}
      }
    };

    const rewritten = rewriteSpec(spec);
    const signalNames = rewritten.signals.map((s) => s.name);

    expect(signalNames).toContain("video1_time");
    expect(signalNames).toContain("video1_duration");
    expect(rewritten.usermeta.__vegaVideoRewritten).toBe(true);
  });

  it("does not double-rewrite", () => {
    const spec = { players: { v: {} } };
    const first = rewriteSpec(spec);
    const second = rewriteSpec(first);
    expect(second.signals.length).toBe(first.signals.length);
  });

  it("does not modify non-video specs", () => {
    const spec = {
      "$schema": "https://vega.github.io/schema/vega/v6.json",
      "description": "A basic bar chart example, with value labels shown upon pointer hover.",
      "width": 400,
      "height": 200,
      "padding": 5,

      "data": [
        {
          "name": "table",
          "values": [
            { "category": "A", "amount": 28 },
            { "category": "B", "amount": 55 },
            { "category": "C", "amount": 43 },
            { "category": "D", "amount": 91 },
            { "category": "E", "amount": 81 },
            { "category": "F", "amount": 53 },
            { "category": "G", "amount": 19 },
            { "category": "H", "amount": 87 }
          ]
        }
      ],

      "signals": [
        {
          "name": "tooltip",
          "value": {},
          "on": [
            { "events": "rect:pointerover", "update": "datum" },
            { "events": "rect:pointerout", "update": "{}" }
          ]
        }
      ],

      "scales": [
        {
          "name": "xscale",
          "type": "band",
          "domain": { "data": "table", "field": "category" },
          "range": "width",
          "padding": 0.05,
          "round": true
        },
        {
          "name": "yscale",
          "domain": { "data": "table", "field": "amount" },
          "nice": true,
          "range": "height"
        }
      ],

      "axes": [
        { "orient": "bottom", "scale": "xscale" },
        { "orient": "left", "scale": "yscale" }
      ],

      "marks": [
        {
          "type": "rect",
          "from": { "data": "table" },
          "encode": {
            "enter": {
              "x": { "scale": "xscale", "field": "category" },
              "width": { "scale": "xscale", "band": 1 },
              "y": { "scale": "yscale", "field": "amount" },
              "y2": { "scale": "yscale", "value": 0 }
            },
            "update": {
              "fill": { "value": "steelblue" }
            },
            "hover": {
              "fill": { "value": "red" }
            }
          }
        },
        {
          "type": "text",
          "encode": {
            "enter": {
              "align": { "value": "center" },
              "baseline": { "value": "bottom" },
              "fill": { "value": "#333" }
            },
            "update": {
              "x": { "scale": "xscale", "signal": "tooltip.category", "band": 0.5 },
              "y": { "scale": "yscale", "signal": "tooltip.amount", "offset": -2 },
              "text": { "signal": "tooltip.amount" },
              "fillOpacity": [
                { "test": "datum === tooltip", "value": 0 },
                { "value": 1 }
              ]
            }
          }
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    expect(rewritten.usermeta.__vegaVideoRewritten).toBe(true);

    const rewrittenWithoutUsermeta = { ...rewritten };
    delete rewrittenWithoutUsermeta.usermeta;
    expect(rewrittenWithoutUsermeta).toEqual(spec);
  });

  it("updates video signal references (writes)", () => {
    const spec = {
      players: {
        main: {}
      },
      signals: [
        { name: "@main:time", update: "datum.value" },
        { name: "@main:itime", update: "datum.value + 1" },
      ]
    };

    const rewritten = rewriteSpec(spec);
    expect(rewritten.signals[0].name).toBe("main_seek_to");
    expect(rewritten.signals[1].name).toBe("main_seek_to");

    const playerSignals = rewritten.usermeta.players.main.signals;
    expect(playerSignals.length).toBe(1);
    expect(playerSignals).toContain("seek_to");
  });

  it("updates video signal references (reads)", () => {
    const spec = {
      players: {
        main: {}
      },
      marks: [
        {
          type: "text",
          encode: {
            update: {
              text: { signal: "@main:time" }
            }
          }
        },
        {
          type: "text",
          encode: {
            update: {
              text: { signal: "@main:itime" }
            }
          }
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const textSignals = rewritten.marks
      .filter((m) => m.type === "text")
      .map((m) => m.encode.update.text.signal);
    expect(textSignals[0]).toBe("main_time");
    expect(textSignals[1]).toBe("main_time_intent");

    const playerSignals = rewritten.usermeta.players.main.signals;
    expect(playerSignals.length).toBe(2);
    expect(playerSignals).toContain("time");
    expect(playerSignals).toContain("time_intent");
  });

  it("injects playlist dataset when source and filter are specified", () => {
    const spec = {
      players: [
        {
          name: "main",
          playlist: {
            source: "events",
            filter: ["brush1", "brush2"],
            segmentsField: "video_segments"
          }
        }
      ],
      data: [
        { name: "events", values: [] }
      ]
    };

    const rewritten = rewriteSpec(spec);

    // Should inject a derived dataset
    const dataNames = rewritten.data.map(d => d.name);
    expect(dataNames).toContain("main_playlist_data");

    // The derived dataset should source from "events" and have filter transforms
    const playlistData = rewritten.data.find(d => d.name === "main_playlist_data");
    expect(playlistData.source).toBe("events");
    expect(playlistData.transform).toHaveLength(2);
    expect(playlistData.transform[0].expr).toContain("vlSelectionTest");
    expect(playlistData.transform[0].expr).toContain("brush1_store");
    expect(playlistData.transform[1].expr).toContain("brush2_store");

    // Playlist config should now reference the derived dataset
    const player = rewritten.usermeta.players[0];
    expect(player.playlist.data).toBe("main_playlist_data");
    expect(player.playlist.source).toBeUndefined();
    expect(player.playlist.filter).toBeUndefined();
  });

  it("handles playlist with source but no filter", () => {
    const spec = {
      players: [
        {
          name: "main",
          playlist: {
            source: "events",
            segmentsField: "video_segments"
          }
        }
      ],
      data: [
        { name: "events", values: [] }
      ]
    };

    const rewritten = rewriteSpec(spec);

    // Should inject a derived dataset with no transforms
    const playlistData = rewritten.data.find(d => d.name === "main_playlist_data");
    expect(playlistData.source).toBe("events");
    expect(playlistData.transform).toBeUndefined();
  });

  it("throws error when annotation is specified without fps", () => {
    const spec = {
      players: [
        {
          name: "main",
          annotation: {
            data: "detections",
            marks: [{ type: "boundingbox" }]
          }
        }
      ]
    };

    expect(() => rewriteSpec(spec)).toThrow(
      'vega-video: Player "main" has an annotation but no fps specified.'
    );
  });

  it("throws error when writing to read-only signal @player:duration", () => {
    const spec = {
      players: { main: {} },
      signals: [{ name: "@main:duration", update: "100" }]
    };
    expect(() => rewriteSpec(spec)).toThrow(
      'Signal "@main:duration" is read-only and cannot be written to'
    );
  });

  it("throws error when writing to read-only signal @player:ready", () => {
    const spec = {
      players: { main: {} },
      signals: [{ name: "@main:ready", update: "true" }]
    };
    expect(() => rewriteSpec(spec)).toThrow(
      'Signal "@main:ready" is read-only and cannot be written to'
    );
  });

  it("throws error when writing to read-only signal @player:ended", () => {
    const spec = {
      players: { main: {} },
      signals: [{ name: "@main:ended", update: "true" }]
    };
    expect(() => rewriteSpec(spec)).toThrow(
      'Signal "@main:ended" is read-only and cannot be written to'
    );
  });

  it("classifies pointermove handler as continuous seek", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            { events: "rect:pointermove[event.buttons]", update: "invert('x', x())" }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const contSig = rewritten.signals.find(s => s.name === "main_seek_to_continuous" && s.on);
    expect(contSig).toBeDefined();
    expect(contSig.on).toHaveLength(1);

    // Should not have a discrete seek_to with on handlers
    const discSig = rewritten.signals.find(s => s.name === "main_seek_to" && s.on);
    expect(discSig).toBeUndefined();
  });

  it("classifies pointerdown handler as discrete seek", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            { events: "rect:pointerdown", update: "invert('x', x())" }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const discSig = rewritten.signals.find(s => s.name === "main_seek_to" && s.on);
    expect(discSig).toBeDefined();
    expect(discSig.on).toHaveLength(1);

    const contSig = rewritten.signals.find(s => s.name === "main_seek_to_continuous" && s.on);
    expect(contSig).toBeUndefined();
  });

  it("splits mixed discrete+continuous events into separate signals", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            { events: "rect:pointerdown, rect:pointermove[event.buttons]", update: "invert('x', x())" }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const discSig = rewritten.signals.find(s => s.name === "main_seek_to" && s.on);
    const contSig = rewritten.signals.find(s => s.name === "main_seek_to_continuous" && s.on);

    expect(discSig).toBeDefined();
    expect(discSig.on[0].events).toBe("rect:pointerdown");

    expect(contSig).toBeDefined();
    expect(contSig.on[0].events).toBe("rect:pointermove[event.buttons]");
  });

  it("classifies between pattern by triggering event", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            {
              events: "[@seekSurface:pointerdown, window:pointerup] > window:pointermove",
              update: "invert('x', clamp(x(), 0, width))"
            }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const contSig = rewritten.signals.find(s => s.name === "main_seek_to_continuous" && s.on);
    expect(contSig).toBeDefined();
    expect(contSig.on).toHaveLength(1);
  });

  it("classifies separate on handlers independently", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            { events: "rect:pointerdown", update: "invert('x', x())" },
            { events: "rect:pointermove[event.buttons]", update: "invert('x', x())" }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const discSig = rewritten.signals.find(s => s.name === "main_seek_to" && s.on);
    const contSig = rewritten.signals.find(s => s.name === "main_seek_to_continuous" && s.on);

    expect(discSig).toBeDefined();
    expect(discSig.on).toHaveLength(1);
    expect(discSig.on[0].events).toBe("rect:pointerdown");

    expect(contSig).toBeDefined();
    expect(contSig.on).toHaveLength(1);
    expect(contSig.on[0].events).toBe("rect:pointermove[event.buttons]");
  });

  it("defaults to discrete seek_to when signal has no on handlers", () => {
    const spec = {
      players: { main: {} },
      signals: [
        { name: "@main:time", update: "datum.value" }
      ]
    };

    const rewritten = rewriteSpec(spec);
    expect(rewritten.signals[0].name).toBe("main_seek_to");
  });

  it("tracks seek_to_continuous in player signals", () => {
    const spec = {
      players: { main: {} },
      signals: [
        {
          name: "@main:time",
          on: [
            { events: "rect:pointermove", update: "invert('x', x())" }
          ]
        }
      ]
    };

    const rewritten = rewriteSpec(spec);
    const playerSignals = rewritten.usermeta.players.main.signals;
    expect(playerSignals).toContain("seek_to_continuous");
  });

  it("allows annotation when fps is specified", () => {
    const spec = {
      players: [
        {
          name: "main",
          fps: 24,
          annotation: {
            data: "detections",
            marks: [{ type: "boundingbox" }]
          }
        }
      ]
    };

    // Should not throw
    const rewritten = rewriteSpec(spec);
    expect(rewritten.usermeta.players[0].fps).toBe(24);
    expect(rewritten.usermeta.players[0].annotation).toBeDefined();
  });
});
