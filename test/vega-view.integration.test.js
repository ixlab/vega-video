// test/vega-view.integration.test.js
import { describe, it, expect } from "bun:test";
import * as vega from "vega";
import { rewriteSpec, attach } from "../src/index.js";

// Minimal spec that uses your "main" video namespace
const exampleSpec = {
    $schema: "https://vega.github.io/schema/vega/v6.json",
    description: "Random-walk (simplified) with video-synced playhead",
    players: [
        {
            name: "main",
            controls: true,
            sources: [
                {
                    src: "https://example.com/video.mp4",
                    type: "video/mp4"
                }
            ]
        }
    ],
    width: 200,
    height: 100,
    // We only need at least one signal so spec is valid; rewriteSpec will add video signals
    signals: [
        {
            name: "dummy",
            value: 0
        }
    ],
    data: [],
    marks: []
};

function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("vega-video + real vega.View", () => {
    it("keeps main_time in sync with video.currentTime", async () => {
        const rewritten = rewriteSpec(exampleSpec);

        const runtime = vega.parse(rewritten);
        const view = new vega.View(runtime, {
            renderer: "none", // no SVG/Canvas needed
            container: null,
            hover: false
        });

        await view.runAsync();

        // Our FakeVideo class from setup-env
        const video = new HTMLVideoElement();
        video.duration = 20;

        const { detach } = attach(view, {
            spec: rewritten,
            videos: [{ name: "main", ref: video }],
            players: [{ name: "main" }],
        });

        // Simulate metadata ready
        video.load();
        await nextTick();

        // Advance time a bit
        video.tick(1.2);
        await nextTick();

        const t1 = view.signal("main_time");
        expect(t1).toBeCloseTo(1.2, 1);

        // Advance again
        video.tick(0.8); // total 2.0
        await nextTick();

        const t2 = view.signal("main_time");
        expect(t2).toBeCloseTo(2.0, 1);

        detach();
    });

    it("responds to main_seek_to by seeking the video", async () => {
        const rewritten = rewriteSpec(exampleSpec);

        const runtime = vega.parse(rewritten);
        const view = new vega.View(runtime, {
            renderer: "none",
            container: null,
            hover: false
        });

        await view.runAsync();

        const video = new HTMLVideoElement();
        video.duration = 30;

        const { detach } = attach(view, {
            spec: rewritten,
            videos: [{ name: "main", ref: video }]
        });

        // Simulate metadata ready
        video.load();
        await nextTick();

        // Set control signal from Vega side
        view.signal("main_seek_to", 5);
        await view.runAsync();
        await nextTick();

        expect(video.currentTime).toBe(5);
        expect(view.signal("main_time_intent")).toBe(5);
        expect(view.signal("main_seek_to")).toBe(null); // Player resets it

        detach();
    });

    it("responds to main_set_playing by calling play/pause", async () => {
        const rewritten = rewriteSpec(exampleSpec);

        const runtime = vega.parse(rewritten);
        const view = new vega.View(runtime, {
            renderer: "none",
            container: null,
            hover: false
        });

        await view.runAsync();

        const video = new HTMLVideoElement();
        const { detach } = attach(view, {
            spec: rewritten,
            videos: [{ name: "main", ref: video }]
        });

        // Start playing
        view.signal("main_set_playing", true);
        await view.runAsync();
        await nextTick();

        expect(video.paused).toBe(false);
        expect(view.signal("main_playing")).toBe(true);

        // Pause
        view.signal("main_set_playing", false);
        await view.runAsync();
        await nextTick();

        expect(video.paused).toBe(true);
        expect(view.signal("main_playing")).toBe(false);

        detach();
    });
});
