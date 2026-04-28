// src/sync.js

import {
  ns,
  hasOwn,
  clamp,
  setVideoSources,
  SIGNAL_BASES,
  SIGNAL_EXTRA,
  HLS_MIME
} from "./util.js";
import { buildHLSManifest } from "./playlist.js";
import { computeResumeTime } from "./cursor.js";
import { AnnotationRenderer } from "./annotation.js";

const RAPID_SCRUB_IDLE_MS = 120;

// Tracks the Player currently attached to each <video>. Used to clear previous Players if the same video is re-used.
const VIDEO_PLAYER_REGISTRY = new WeakMap();

export function computeSignalPresence(view, namespaces) {
  const present = {};
  const has = (name) => {
    try { void view.signal(name); return true; }
    catch { return false; }
  };
  for (const n of namespaces) {
    for (const b of [...SIGNAL_BASES, ...SIGNAL_EXTRA]) {
      const name = ns(n, b);
      present[name] = has(name);
    }
  }
  return present;
}

export class Player {
  constructor(view, namespace, video, cfg, signalPresence) {
    const prev = VIDEO_PLAYER_REGISTRY.get(video);
    if (prev) {
      console.warn(`vega-video: replacing existing Player on <video> for namespace "${namespace}"`);
      prev.destroy();
    }
    VIDEO_PLAYER_REGISTRY.set(video, this);

    this.view = view;
    this.ns = namespace;
    this.video = video;
    this.cfg = cfg;
    this._suppressingFeedback = false;

    this._hls = null;
    this._nativeHLS = false;
    this._blobURL = null;

    this._videoFrameCallbackId = null;

    this._timeline = [];
    this._lastIntent = NaN;
    this._lastTime = NaN;
    this._unsubs = [];
    this._hasSignal = (name) => !!signalPresence[name];

    // Rapid-scrub state
    this._keyframes = cfg.keyframes ? this._initKeyframes(cfg) : null;
    this._rapidScrubDir = 0;
    this._rapidScrubStartIntent = NaN;
    this._rapidScrubLastIntent = NaN;
    this._rapidScrubIdleTimer = null;

    this._annotationRenderer = null;

    this._applyAttributes();
    this._wireVideoEvents();
    this._wireControlSignals();
    this._initAnnotation();

    const ready = !isNaN(this.video.duration);
    const t = this.video.currentTime || 0;
    this._fps = cfg.fps;
    this._push("ready", ready);
    this._push("duration", this.video.duration || 0);
    this._pushTimeSignals(t);
    this._push("playing", !this.video.paused);
    this._push("ended", false);

    if (Array.isArray(cfg.sources) && cfg.sources.length) {
      setVideoSources(video, cfg.sources);
    }
    if (cfg.playlist?.data) this._watchPlaylistData(cfg.playlist);

    this._startFrameLoop();
  }

  _applyAttributes() {
    const { video, cfg } = this;
    if (hasOwn(cfg, "controls")) video.controls = !!cfg.controls;
    if (hasOwn(cfg, "autoplay")) video.autoplay = !!cfg.autoplay;
    if (hasOwn(cfg, "loop")) video.loop = !!cfg.loop;
    if (hasOwn(cfg, "muted")) video.muted = !!cfg.muted;
    if (typeof cfg.startTime === "number") { try { video.currentTime = Math.max(0, cfg.startTime); } catch { } }
  }

  _pushTimeSignals(t) {
    this._push("time", t);
    this._push("time_intent", t);
    this._push("frame_index", Math.floor(t * this._fps));
  }

  _push(name, val) {
    const sig = ns(this.ns, name);
    if (!this._hasSignal(sig)) return;
    try {
      this._suppressingFeedback = true;
      this.view.signal(sig, val).runAsync();
    } catch {
    } finally {
      this._suppressingFeedback = false;
    }
  }

  _wireVideoEvents() {
    const v = this.video;

    const onMeta = () => {
      this._push("duration", v.duration || 0);
      this._push("ready", true);
      const t = v.currentTime || 0;
      this._pushTimeSignals(t);
      this._push("playlist_time", this._relPlaylistTime(t));
      this._push("playlist_current_index", 0);
    };

    const onPlay = () => {
      this._push("playing", true);
      this._push("ended", false);
    };

    const onPause = () => this._push("playing", false);

    const onEnded = () => {
      this._push("playing", false);
      this._push("ended", true);
    };

    const onSeeking = () => {
      const t = v.currentTime || 0;
      this._push("time_intent", t);
      this._updatePlaylistCursor(t);
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    v.addEventListener("seeking", onSeeking);

    this._unsubs.push(() => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("seeking", onSeeking);
    });
  }

  _initKeyframes(cfg) {
    let kfs = cfg.keyframes.slice();
    kfs.sort((a, b) => a - b);
    return kfs;
  }

  _getSeekMode() {
    const m = this.cfg.seekMode;
    if (m === "current_time" || m === "fastSeek" || m === "rapidScrub") return m;
    return "current_time";
  }

  _pickKeyframeInRange(lo, hi, dir) {
    const keyframes = this._keyframes;
    if (!keyframes || !keyframes.length) return null;
    let candidate = null;
    for (let i = 0; i < keyframes.length; i++) {
      const k = keyframes[i];
      if (k < lo || k > hi) continue;
      if (candidate == null) {
        candidate = k;
      } else if (dir > 0) {
        // scrubbing forward
        if (k > candidate) candidate = k;
      } else {
        // scrubbing backward
        if (k < candidate) candidate = k;
      }
    }
    return candidate;
  }

  _rapidScrubSeek(t) {
    const v = this.video;
    const keyframes = this._keyframes;

    if (!Number.isFinite(t) || !keyframes || !keyframes.length) {
      this._doSeekFast(t);
      return;
    }

    const rawPlayhead = v.currentTime;
    const playhead = Number.isFinite(rawPlayhead) ? rawPlayhead : t;
    const last = this._rapidScrubLastIntent;
    let dir;

    if (!Number.isFinite(last) || t === last) {
      dir = t >= playhead ? +1 : -1;
    } else {
      dir = t > last ? +1 : -1;
    }

    if (dir !== this._rapidScrubDir) {
      this._rapidScrubDir = dir;
      this._rapidScrubStartIntent = t;
    } else if (!Number.isFinite(this._rapidScrubStartIntent)) {
      this._rapidScrubStartIntent = t;
    }
    this._rapidScrubLastIntent = t;

    const scrubStart = Number.isFinite(this._rapidScrubStartIntent) ? this._rapidScrubStartIntent : t;

    let lo, hi;
    if (dir > 0) {
      const startBound = Math.max(playhead, scrubStart);
      lo = Math.min(startBound, t);
      hi = Math.max(startBound, t);
    } else {
      const endBound = Math.min(playhead, scrubStart);
      lo = Math.min(t, endBound);
      hi = Math.max(t, endBound);
    }

    const snapped = this._pickKeyframeInRange(lo, hi, dir);

    if (snapped == null) {
      this._doSeekExact(t);
    } else {
      this._doSeekFast(snapped);
    }

    const idleMs = typeof this.cfg.rapidScrubIdleMs === "number"
      ? this.cfg.rapidScrubIdleMs
      : RAPID_SCRUB_IDLE_MS;

    clearTimeout(this._rapidScrubIdleTimer);

    this._rapidScrubIdleTimer = setTimeout(() => {
      const finalT = this._rapidScrubLastIntent;
      if (Number.isFinite(finalT)) {
        this._doSeekExact(finalT);
      }
    }, idleMs);
  }

  _setCurrentTime(t) {
    const mode = this._getSeekMode();
    if (mode === "current_time") {
      this._doSeekExact(t);
    } else if (mode === "fastSeek") {
      this._doSeekFast(t);
    } else if (mode === "rapidScrub") {
      this._rapidScrubSeek(t);
    }
  }

  _doSeekExact(t) {
    try { this.video.currentTime = t; } catch { }
  }

  _doSeekFast(t) {
    const v = this.video;
    try {
      if (typeof v.fastSeek === "function") v.fastSeek(t);
      else v.currentTime = t;
    } catch { }
  }

  _setContinuousTime(t) {
    if (this.cfg.seekMode) {
      this._setCurrentTime(t);
    } else {
      this._rapidScrubSeek(t);
    }
  }

  _wireControlSignals() {
    const listenSig = (sig, fn) => {
      if (!this._hasSignal(sig)) return;
      const h = (_name, val) => { if (!this._suppressingFeedback) fn(val); };
      try { this.view.addSignalListener(sig, h); } catch { }
      this._unsubs.push(() => { try { this.view.removeSignalListener(sig, h); } catch { } });
    };

    listenSig(ns(this.ns, "seek_to"), (t) => {
      if (t == null || isNaN(+t)) return;
      const dur = Number.isFinite(this.video.duration) ? this.video.duration : +t;
      const clamped = clamp(+t, 0, dur);
      this._push("time_intent", clamped);
      this._updatePlaylistCursor(clamped);
      this._setCurrentTime(clamped);
      this._push("seek_to", null);
    });

    listenSig(ns(this.ns, "seek_to_continuous"), (t) => {
      if (t == null || isNaN(+t)) return;
      const dur = Number.isFinite(this.video.duration) ? this.video.duration : +t;
      const clamped = clamp(+t, 0, dur);
      this._push("time_intent", clamped);
      this._updatePlaylistCursor(clamped);
      this._setContinuousTime(clamped);
      this._push("seek_to_continuous", null);
    });

    listenSig(ns(this.ns, "set_playing"), (p) => {
      if (p == null) return;
      if (p) void this.video.play();
      else this.video.pause();
      this._push("set_playing", null);
    });
  }

  _startFrameLoop() {
    if (this._videoFrameCallbackId != null) return;

    const v = this.video;

    const frameStep = () => {
      const t = v.currentTime || 0;

      if (t !== this._lastIntent) {
        this._lastIntent = t;
        this._push("time_intent", t);
      }
      if (t !== this._lastTime) {
        this._lastTime = t;
        this._push("time", t);
        this._push("frame_index", Math.floor(t * this._fps));
      }

      this._updatePlaylistCursor(t);
      this._videoFrameCallbackId = v.requestVideoFrameCallback(frameStep);
    };

    this._videoFrameCallbackId = v.requestVideoFrameCallback(frameStep);
  }

  _stopFrameLoop() {
    if (this._videoFrameCallbackId != null) {
      try { this.video.cancelVideoFrameCallback(this._videoFrameCallbackId); } catch { }
    }
    this._videoFrameCallbackId = null;
  }

  _initAnnotation() {
    const annotation = this.cfg.annotation;
    if (!annotation || !annotation.data || !annotation.marks?.length) return;

    const opts = {
      dataWidth: annotation.dataWidth || this.cfg.dataWidth,
      dataHeight: annotation.dataHeight || this.cfg.dataHeight,
      colors: annotation.colors,
      colorMap: annotation.colorMap
    };

    this._annotationRenderer = new AnnotationRenderer(
      this.video,
      this.view,
      annotation.data,
      annotation.marks,
      opts
    );
  }

  _relPlaylistTime(t) {
    if (!Number.isFinite(t)) return t;
    const hit = this._timeline.length
      ? this._timeline.find((r) => t >= r.start && t < r.end)
      : null;
    return hit ? (t - hit.start) : t;
  }

  _updatePlaylistCursor(t) {
    const hit = Number.isFinite(t)
      ? this._timeline.find((r) => t >= r.start && t < r.end)
      : null;

    if (!hit) {
      this._push("playlist_current_index", 0);
      this._push("playlist_time", Number.isFinite(t) ? t : 0);
      return;
    }

    this._push("playlist_current_index", hit.idx);
    this._push("playlist_time", t - hit.start);
  }

  _ensureHLS() {
    if (this._hls || this._nativeHLS) return;
    const Hls = window.Hls;
    if (Hls && Hls.isSupported()) {
      this._hls = new Hls({ autoStartLoad: true, enableWorker: true });
      this._hls.attachMedia(this.video);
      this._hls.on(Hls.Events.ERROR, (_e, d) =>
        console.warn("vega-video: HLS error", d.type, d.details)
      );
    } else if (this.video.canPlayType(HLS_MIME)) {
      this._nativeHLS = true;
    } else {
      console.warn("vega-video: HLS not supported; assigning .m3u8 URL directly");
    }
  }

  _destroyPlaylist() {
    if (this._blobURL) URL.revokeObjectURL(this._blobURL);
    this._blobURL = null;
    if (this._hls) {
      try { this._hls.destroy(); } catch { }
      this._hls = null;
    }
    this._nativeHLS = false;
  }

  _loadManifestText(manifest, resumeTime) {
    const blob = new Blob([manifest], { type: HLS_MIME });
    const url = URL.createObjectURL(blob);
    if (this._blobURL && this._blobURL !== url) {
      URL.revokeObjectURL(this._blobURL);
    }
    this._blobURL = url;

    const afterReady = () => {
      try {
        if (Number.isFinite(resumeTime)) this.video.currentTime = resumeTime;
      } catch { }
      const t = this.video.currentTime || 0;
      this._updatePlaylistCursor(t);
      this.video.play().catch(() => { });
    };

    if (this._hls) {
      try { this._hls.stopLoad(); } catch { }
      this._hls.loadSource(url);
      this._hls.once(window.Hls.Events.MANIFEST_PARSED, afterReady);
      try { this._hls.startLoad(); } catch { }
    } else if (this._nativeHLS) {
      this.video.removeAttribute("src");
      this.video.load();
      this.video.src = url;
      this.video.addEventListener("loadedmetadata", afterReady, { once: true });
    } else {
      this.video.src = url;
      this.video.addEventListener("loadedmetadata", afterReady, { once: true });
    }
  }

  _refreshFromRows(rows, fieldsCfg) {
    const count = rows.length | 0;

    if (!count) {
      this._destroyPlaylist();
      this.video.removeAttribute("src");
      try { this.video.load(); } catch { }
      this._timeline = [];
      this._push("playlist_count", 1);
      this._push("playlist_current_index", 0);
      this._push("playlist_time", 0);
      return;
    }

    this._ensureHLS();
    const { manifest, timeline } = buildHLSManifest(rows, fieldsCfg);

    // Cursor consistency: compute resume time based on old/new timelines
    const oldTimeline = this._timeline;
    const oldDuration = oldTimeline.length
      ? oldTimeline[oldTimeline.length - 1].end
      : (Number.isFinite(this.video.duration) ? this.video.duration : 0);
    const newDuration = timeline.length
      ? timeline[timeline.length - 1].end
      : 0;

    const resume = computeResumeTime({
      currentTime: this.video.currentTime,
      oldTimeline,
      newTimeline: timeline,
      oldDuration,
      newDuration,
      cursorCfg: this.cfg.cursor || null
    });

    this._push("playlist_count", timeline.length);
    this._timeline = timeline;
    this._loadManifestText(manifest, resume);
  }

  _listenData(name, fn) {
    try {
      this.view.addDataListener?.(name, fn);
      this._unsubs.push(() => {
        try { this.view.removeDataListener?.(name, fn); } catch { }
      });
    } catch (e) {
      console.warn("vega-video: failed to add data listener for", name, e);
    }
  }

  _watchPlaylistData(plCfg) {
    const datasetName = plCfg.data;
    const segmentsField = plCfg.segmentsField || "video_segments";

    const handler = () => {
      try {
        const rows = (this.view.data?.(datasetName) || []).filter((e) => {
          const segs = e[segmentsField] || [];
          return Array.isArray(segs) && segs.length > 0;
        });
        this._refreshFromRows(rows, plCfg);
      } catch (e) {
        console.warn("vega-video: playlist data refresh failed", e);
      }
    };

    this._listenData(datasetName, handler);
    handler();
  }

  destroy() {
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this._stopFrameLoop();
    this._destroyPlaylist();
    clearTimeout(this._rapidScrubIdleTimer);
    this._rapidScrubIdleTimer = null;
    if (this._annotationRenderer) {
      this._annotationRenderer.destroy();
      this._annotationRenderer = null;
    }
    if (VIDEO_PLAYER_REGISTRY.get(this.video) === this) {
      VIDEO_PLAYER_REGISTRY.delete(this.video);
    }
  }
}
