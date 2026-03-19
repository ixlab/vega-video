// src/playlist.js

const ABS_URI_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

export function buildHLSManifest(rows, cfg) {
  const segF = cfg.segmentsField || "video_segments";
  const durF = cfg.durationField || "duration";
  const uriF = cfg.uriField || "uri";
  const base = cfg.baseURL || "";

  const hasBase = !!base;
  const basePrefix = hasBase
    ? (base.endsWith("/") ? base : base + "/")
    : "";

  const out = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];

  let maxDur = 1;
  const timeline = [];
  let t = 0;

  function absolutize(u) {
    if (ABS_URI_RE.test(u)) return u;
    if (!hasBase) return u;
    const clean = u.replace(/^\.?\//, "");
    return basePrefix + clean;
  }

  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const segs = Array.isArray(e[segF]) ? e[segF] : [];
    if (i > 0) out.push("#EXT-X-DISCONTINUITY");
    let dur = 0;
    for (let j = 0; j < segs.length; j++) {
      const seg = segs[j];
      const d = +seg[durF] || 0;
      if (d > maxDur) maxDur = d;
      out.push("#EXTINF:" + d + ",");
      out.push(absolutize(seg[uriF]));
      dur += d;
    }
    if (dur > 0) {
      const fp = segs.map(s => `${s[uriF]}:${+s[durF] || 0}`).join("|");
      timeline.push({ idx: i, start: t, end: t + dur, fingerprint: fp });
      t += dur;
    }
  }

  out.splice(3, 0, "#EXT-X-TARGETDURATION:" + Math.max(1, Math.ceil(maxDur)));
  out.push("#EXT-X-ENDLIST");
  return {
    manifest: out.join("\n"),
    timeline
  };
}
