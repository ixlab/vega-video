// test/setup-env.js
// Run Bun tests with: bun test --preload ./test/setup-env.js

import { JSDOM } from "jsdom";

// --- jsdom DOM ---
const dom = new JSDOM(`<!doctype html><html><body><div id="vis"></div></body></html>`);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;
globalThis.Node = dom.window.Node;

// Not strictly needed now, but harmless:
globalThis.HTMLElement = dom.window.HTMLElement;

// ----- Stub canvas.getContext so Vega doesn't explode -----
const canvasProto = dom.window.HTMLCanvasElement.prototype;
canvasProto.getContext = function getContext() {
  // Minimal fake context; Vega mainly cares about measureText for layout.
  return {
    // text measurement
    measureText: (text) => ({ width: String(text).length * 6 }),

    // no-op drawing methods
    fillRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillText: () => {},
    setTransform: () => {},
    strokeRect: () => {},
    fillRect: () => {},
    arc: () => {},
    ellipse: () => {},
    fill: () => {},
  };
};

// requestAnimationFrame for Player._startFrameLoop
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

// ----- Fake HTMLVideoElement -----
// Important: extend EventTarget (NOT HTMLElement) so jsdom doesn't try custom element logic.
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  load() {
    // pretend metadata is ready
    this.dispatchEvent(new Event("loadedmetadata"));
  }

  // Helper for tests: advance time and emit timeupdate
  tick(dt) {
    this.currentTime += dt;
    this.dispatchEvent(new Event("timeupdate"));
  }

  requestVideoFrameCallback(cb) {
    return setTimeout(() => cb(), 0);
  }

  cancelVideoFrameCallback(id) {
    clearTimeout(id);
  }
}

// Expose as global “real” HTMLVideoElement
globalThis.HTMLVideoElement = FakeVideo;

// Ensure document.createElement('video') returns our FakeVideo
const origCreateElement = document.createElement.bind(document);
document.createElement = function (tagName, options) {
  if (String(tagName).toLowerCase() === "video") {
    return new FakeVideo();
  }
  return origCreateElement(tagName, options);
};
