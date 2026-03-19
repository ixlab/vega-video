// src/util.js

export const SIGNAL_BASES = [
  "time", // @player.time
  "time_intent", // @player.itime
  "duration",
  "playing",
  "ready",
  "ended",
  "seek_to",
  "seek_to_continuous",
  "set_playing",
  "frame_index"
];

export const SIGNAL_EXTRA = [
  "playlist_count",
  "playlist_current_index",
  "playlist_time"
];

export const SIGNAL_DEFAULTS = {
  time: { value: null },
  time_intent: { value: null },
  duration: { value: null },
  playing: { value: null },
  ready: { value: null },
  ended: { value: null },
  seek_to: { value: null },
  seek_to_continuous: { value: null },
  set_playing: { value: null },
  playlist_count: { value: null },
  playlist_current_index: { value: null },
  playlist_time: { value: null },
  frame_index: { value: 0 }
};

export const HLS_MIME = "application/vnd.apple.mpegurl";

export const ns = (name, tail) => `${name}_${tail}`;
export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export function setVideoSources(video, sources) {
  if (!sources?.length) return;
  video.innerHTML = "";
  if (sources.length === 1 && sources[0].src) {
    video.src = sources[0].src;
  } else {
    for (const s of sources) {
      const el = document.createElement("source");
      el.src = s.src;
      if (s.type) el.type = s.type;
      video.appendChild(el);
    }
  }
  try { video.load(); } catch { }
}
