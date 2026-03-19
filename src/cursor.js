// src/cursor.js — Cursor consistency for playlist transformations

function makeSegContext(entry, timeline) {
  const pos = timeline.indexOf(entry);
  return {
    start: entry.start,
    end: entry.end,
    lead(n) {
      const t = timeline[pos + n];
      return t ? makeSegContext(t, timeline) : null;
    },
    lag(n) {
      const t = timeline[pos - n];
      return t ? makeSegContext(t, timeline) : null;
    }
  };
}

function evalCursorExpr(expr, prev, incoming, prevSeg, newSeg) {
  const code = expr
    .replace(/@new_seg\b/g, "_new_seg")
    .replace(/@prev_seg\b/g, "_prev_seg")
    .replace(/@new\b/g, "_new")
    .replace(/@prev\b/g, "_prev");
  const fn = new Function("_prev", "_new", "_prev_seg", "_new_seg", `return (${code});`);
  return fn(prev, incoming, prevSeg, newSeg);
}

export function computeResumeTime(opts) {
  const { currentTime, oldTimeline, newTimeline, oldDuration, newDuration, cursorCfg } = opts;

  if (!oldTimeline.length) {
    return Number.isFinite(currentTime) ? currentTime : 0;
  }

  if (!Number.isFinite(currentTime) || !newTimeline.length) {
    return 0;
  }

  let prevEntry = oldTimeline.find(r => currentTime >= r.start && currentTime < r.end);
  if (!prevEntry) {
    prevEntry = oldTimeline[oldTimeline.length - 1];
  }

  const newEntry = prevEntry.fingerprint
    ? newTimeline.find(r => r.fingerprint === prevEntry.fingerprint)
    : null;

  const prev = { time: currentTime, duration: oldDuration || 0 };
  const incoming = { duration: newDuration };
  const prevSeg = makeSegContext(prevEntry, oldTimeline);

  let result;

  if (newEntry) {
    // onKeep branch: the current event is still in the playlist
    const newSeg = makeSegContext(newEntry, newTimeline);

    if (cursorCfg?.onKeep) {
      try {
        result = evalCursorExpr(cursorCfg.onKeep, prev, incoming, prevSeg, newSeg);
      } catch (e) {
        console.warn("vega-video: cursor onKeep expression failed", e);
        result = undefined;
      }
    }

    // Default onKeep: same relative offset within the event
    if (!Number.isFinite(result)) {
      const relOffset = currentTime - prevEntry.start;
      const segDur = newEntry.end - newEntry.start;
      result = newEntry.start + Math.min(Math.max(relOffset, 0), segDur);
    }
  } else {
    // onRemove branch: the current event was filtered out
    if (cursorCfg?.onRemove) {
      try {
        result = evalCursorExpr(cursorCfg.onRemove, prev, incoming, prevSeg, null);
      } catch (e) {
        console.warn("vega-video: cursor onRemove expression failed", e);
        result = undefined;
      }
    }

    // Default onRemove: proportional position
    if (!Number.isFinite(result)) {
      result = oldDuration > 0 ? newDuration * (currentTime / oldDuration) : 0;
    }
  }

  return Math.max(0, Math.min(result, newDuration));
}
