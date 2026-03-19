// src/index.js

import { Player, computeSignalPresence } from "./sync.js";
import { rewriteSpec as innerRewriteSpec } from "./compile.js";
import { AnnotationRenderer } from "./annotation.js";

export { AnnotationRenderer };

export function rewriteSpec(spec, opts = {}) {
  return innerRewriteSpec(spec, opts);
}

export { rewriteSpec as rewrite };

export function attach(view, opts = {}) {
  if (!view) throw new Error("vega-video.attach: view is required");

  const videos = opts.videos || [];
  let incomingSpec = opts.spec;

  if (incomingSpec && !incomingSpec.usermeta?.__vegaVideoRewritten) {
    incomingSpec = rewriteSpec(incomingSpec, { videos });
  }

  const playersCfg =
    (incomingSpec && incomingSpec.usermeta &&
      incomingSpec.usermeta.__vegaVideoRewritten &&
      incomingSpec.usermeta.players) ||
    [];

  const namespaces = videos.map(video => video.name);
  const signalPresence = computeSignalPresence(view, namespaces);
  const players = [];

  for (const videoObj of videos) {
    const nsName = videoObj.name;
    const ref = videoObj.ref;
    if (!ref) {
      console.warn(`vega-video: No <video> provided for namespace "${nsName}".`);
      continue;
    }
    const video = typeof ref === "string" ? document.querySelector(ref) : ref;
    if (!(video instanceof HTMLVideoElement)) {
      console.warn(`vega-video: "${nsName}" is not a valid <video> element.`);
      continue;
    }
    const cfg = playersCfg.find(p => p.name === nsName);
    players.push(new Player(view, nsName, video, cfg, signalPresence));
  }

  try { (view.container() || {}).__vegaVideo__ = { players }; } catch { }

  return {
    detach() { players.forEach((p) => p.destroy()); }
  };
}
