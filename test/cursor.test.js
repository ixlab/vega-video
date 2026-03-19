// test/cursor.test.js
import { describe, it, expect } from "bun:test";
import { computeResumeTime } from "../src/cursor.js";

function entry(start, end, fp) {
  return { id: 0, idx: 0, start, end, fingerprint: fp };
}

describe("computeResumeTime", () => {
  it("returns currentTime on first load (empty old timeline)", () => {
    const result = computeResumeTime({
      currentTime: 5.0,
      oldTimeline: [],
      newTimeline: [entry(0, 10, "a.ts:10")],
      oldDuration: 0,
      newDuration: 10,
      cursorCfg: null
    });
    expect(result).toBe(5.0);
  });

  it("returns 0 on first load with NaN currentTime", () => {
    const result = computeResumeTime({
      currentTime: NaN,
      oldTimeline: [],
      newTimeline: [entry(0, 10, "a.ts:10")],
      oldDuration: 0,
      newDuration: 10,
      cursorCfg: null
    });
    expect(result).toBe(0);
  });

  it("returns 0 when new timeline is empty", () => {
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, "a.ts:5")],
      newTimeline: [],
      oldDuration: 5,
      newDuration: 0,
      cursorCfg: null
    });
    expect(result).toBe(0);
  });

  // --- Default onKeep ---

  it("default onKeep: resumes at same offset within kept event", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, fp), entry(5, 10, "clip2.ts:5")],
      newTimeline: [entry(0, 5, fp)],
      oldDuration: 10,
      newDuration: 5,
      cursorCfg: null
    });
    expect(result).toBe(3.0);
  });

  it("default onKeep: follows event to new position after reordering", () => {
    const fp1 = "clip1.ts:5";
    const fp2 = "clip2.ts:5";
    const result = computeResumeTime({
      currentTime: 2.0, // 2s into clip1 (starts at 0)
      oldTimeline: [entry(0, 5, fp1), entry(5, 10, fp2)],
      newTimeline: [entry(0, 5, fp2), entry(5, 10, fp1)], // clip1 moved to position 2
      oldDuration: 10,
      newDuration: 10,
      cursorCfg: null
    });
    expect(result).toBe(7.0); // 5 (new start of clip1) + 2 (offset)
  });

  it("default onKeep: clamps offset to event duration", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 4.9, // near end of 5s event
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(0, 3, fp)], // same event but shorter in new timeline
      oldDuration: 5,
      newDuration: 3,
      cursorCfg: null
    });
    expect(result).toBe(3.0); // clamped to event end
  });

  // --- Default onRemove ---

  it("default onRemove: proportional fallback when event is filtered out", () => {
    const result = computeResumeTime({
      currentTime: 5.0, // halfway through 10s playlist
      oldTimeline: [entry(0, 5, "clip1.ts:5"), entry(5, 10, "clip2.ts:5")],
      newTimeline: [entry(0, 5, "clip1.ts:5")], // clip2 removed
      oldDuration: 10,
      newDuration: 5,
      cursorCfg: null
    });
    expect(result).toBe(2.5); // 50% of 5s
  });

  it("default onRemove: returns 0 when oldDuration is 0", () => {
    const result = computeResumeTime({
      currentTime: 0,
      oldTimeline: [entry(0, 0, "clip1.ts:0")],
      newTimeline: [entry(0, 5, "clip2.ts:5")],
      oldDuration: 0,
      newDuration: 5,
      cursorCfg: null
    });
    expect(result).toBe(0);
  });

  // --- Custom expressions ---

  it("custom onKeep expression", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(2, 7, fp)], // same event at different position
      oldDuration: 5,
      newDuration: 7,
      cursorCfg: {
        onKeep: "@new_seg.start + (@prev.time - @prev_seg.start)",
        onRemove: "0"
      }
    });
    expect(result).toBe(5.0); // 2 + (3 - 0) = 5
  });

  it("custom onRemove expression", () => {
    const result = computeResumeTime({
      currentTime: 5.0,
      oldTimeline: [entry(0, 5, "clip1.ts:5"), entry(5, 10, "clip2.ts:5")],
      newTimeline: [entry(0, 5, "clip1.ts:5")],
      oldDuration: 10,
      newDuration: 5,
      cursorCfg: {
        onKeep: "@new_seg.start",
        onRemove: "@prev.time / @prev.duration * @new.duration"
      }
    });
    expect(result).toBe(2.5); // 5/10 * 5
  });

  // --- Lead/lag ---

  it("lead(n) returns n-th next event in timeline", () => {
    const fp1 = "clip1.ts:5";
    const fp2 = "clip2.ts:5";
    const fp3 = "clip3.ts:5";
    const result = computeResumeTime({
      currentTime: 0,
      oldTimeline: [entry(0, 5, fp1), entry(5, 10, fp2), entry(10, 15, fp3)],
      newTimeline: [entry(0, 5, fp1), entry(5, 10, fp2), entry(10, 15, fp3)],
      oldDuration: 15,
      newDuration: 15,
      cursorCfg: {
        onKeep: "@prev_seg.lead(1) != null ? @prev_seg.lead(1).start : 0",
        onRemove: "0"
      }
    });
    expect(result).toBe(5.0); // lead(1) from clip1 → clip2 at start=5
  });

  it("lead returns null for out-of-bounds", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 0,
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(0, 5, fp)],
      oldDuration: 5,
      newDuration: 5,
      cursorCfg: {
        onKeep: "@prev_seg.lead(1) == null ? @new_seg.start : @prev_seg.lead(1).start",
        onRemove: "0"
      }
    });
    expect(result).toBe(0); // lead(1) is null → new_seg.start = 0
  });

  it("lag(n) returns n-th previous event in timeline", () => {
    const fp1 = "clip1.ts:5";
    const fp2 = "clip2.ts:5";
    const result = computeResumeTime({
      currentTime: 6.0, // in clip2
      oldTimeline: [entry(0, 5, fp1), entry(5, 10, fp2)],
      newTimeline: [entry(0, 5, fp1), entry(5, 10, fp2)],
      oldDuration: 10,
      newDuration: 10,
      cursorCfg: {
        onKeep: "@prev_seg.lag(1) != null ? @prev_seg.lag(1).end : 0",
        onRemove: "0"
      }
    });
    expect(result).toBe(5.0); // lag(1) from clip2 → clip1, clip1.end = 5
  });

  // --- Clamping ---

  it("clamps result to [0, newDuration]", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(0, 5, fp)],
      oldDuration: 5,
      newDuration: 5,
      cursorCfg: {
        onKeep: "999",
        onRemove: "0"
      }
    });
    expect(result).toBe(5.0); // clamped to newDuration
  });

  it("clamps negative result to 0", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(0, 5, fp)],
      oldDuration: 5,
      newDuration: 5,
      cursorCfg: {
        onKeep: "-10",
        onRemove: "0"
      }
    });
    expect(result).toBe(0);
  });

  // --- Error handling ---

  it("falls back to default when expression throws", () => {
    const fp = "clip1.ts:5";
    const result = computeResumeTime({
      currentTime: 3.0,
      oldTimeline: [entry(0, 5, fp)],
      newTimeline: [entry(0, 5, fp)],
      oldDuration: 5,
      newDuration: 5,
      cursorCfg: {
        onKeep: "this_is_not_defined.foo.bar",
        onRemove: "0"
      }
    });
    // Falls back to default onKeep: offset 3.0 within event starting at 0
    expect(result).toBe(3.0);
  });

  // --- Past-end handling ---

  it("uses last event when currentTime is past all events", () => {
    const fp1 = "clip1.ts:5";
    const fp2 = "clip2.ts:5";
    const result = computeResumeTime({
      currentTime: 12.0, // past the end of 10s playlist
      oldTimeline: [entry(0, 5, fp1), entry(5, 10, fp2)],
      newTimeline: [entry(0, 5, fp1), entry(5, 10, fp2)],
      oldDuration: 10,
      newDuration: 10,
      cursorCfg: null
    });
    // Falls back to last event (clip2), offset = 12 - 5 = 7, clamped to seg dur 5
    expect(result).toBe(10.0); // 5 + min(7, 5) = 10
  });
});
