// src/compile.js

import { SIGNAL_DEFAULTS, ns } from "./util.js";

const CONTINUOUS_EVENTS = new Set([
  "pointermove", "mousemove", "touchmove", "wheel",
  "mousewheel", "DOMMouseScroll"
]);

/**
 * Split a Vega event selector string into individual event parts.
**/
function splitEventUnion(eventsStr) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < eventsStr.length; i++) {
    const ch = eventsStr[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function isEventPartContinuous(part) {
  const betweenMatch = part.match(/\]\s*>\s*(.+)$/);
  const eventStr = betweenMatch ? betweenMatch[1].trim() : part;
  const noFilter = eventStr.replace(/\[.*$/, "").trim();
  const eventType = noFilter.includes(":") ? noFilter.split(":").pop() : noFilter;
  return CONTINUOUS_EVENTS.has(eventType);
}

function ensureArray(obj, key) {
  if (!obj[key]) obj[key] = [];
  if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
  return obj[key];
}

export const SIGNAL_MAP = {
  time: { read: "time", write: "seek_to" },
  itime: { read: "time_intent", write: "seek_to" },
  playing: { read: "playing", write: "set_playing" },
  duration: { read: "duration" },
  ready: { read: "ready" },
  ended: { read: "ended" },
  playlist_count: { read: "playlist_count" },
  playlist_current_index: { read: "playlist_current_index" },
  playlist_time: { read: "playlist_time" },
  frame_index: { read: "frame_index" }
};


function findAndMapVidSignalRefs(spec, namespaces) {
  const mappedSignals = {};
  namespaces.forEach(n => { mappedSignals[n] = new Set(); });

  function search(obj) {
    if (Array.isArray(obj)) {
      obj.forEach(search);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if ((key === "signal" || key === "expr" || key === "update") && typeof val === "string") {
          obj[key] = val.replace(/@([\w]+):([\w]+)/g, (match, nsName, sigKey) => {
            if (namespaces.includes(nsName) && SIGNAL_MAP[sigKey]) {
              mappedSignals[nsName].add(SIGNAL_MAP[sigKey].read);
              return `${nsName}_${SIGNAL_MAP[sigKey].read}`;
            }
            return match;
          });
        } else {
          search(val);
        }
      }
    }
  }

  search(spec);

  const signalsArr = ensureArray(spec, "signals");
  const signalsToAdd = [];
  for (const sig of signalsArr) {
    if (sig?.name?.match?.(/^@([\w]+):([\w]+)$/)) {
      const [, nsName, sigKey] = sig.name.match(/^@([\w]+):([\w]+)$/);
      if (namespaces.includes(nsName) && SIGNAL_MAP[sigKey]) {
        if (!SIGNAL_MAP[sigKey].write) {
          throw new Error(
            `vega-video: Signal "@${nsName}:${sigKey}" is read-only and cannot be written to.`
          );
        }
        const writeSignal = SIGNAL_MAP[sigKey].write;

        // Classify seek handlers as continuous or discrete
        if (writeSignal === "seek_to" && sig.on?.length) {
          const discreteHandlers = [];
          const continuousHandlers = [];

          for (const handler of sig.on) {
            const eventsStr = typeof handler.events === "string" ? handler.events : null;
            if (!eventsStr) {
              discreteHandlers.push(handler);
              continue;
            }
            const parts = splitEventUnion(eventsStr);
            const contParts = parts.filter(isEventPartContinuous);
            const discParts = parts.filter(p => !isEventPartContinuous(p));

            if (contParts.length === parts.length) {
              continuousHandlers.push(handler);
            } else if (discParts.length === parts.length) {
              discreteHandlers.push(handler);
            } else {
              discreteHandlers.push({ ...handler, events: discParts.join(", ") });
              continuousHandlers.push({ ...handler, events: contParts.join(", ") });
            }
          }

          if (continuousHandlers.length && discreteHandlers.length) {
            sig.name = `${nsName}_${writeSignal}`;
            sig.on = discreteHandlers;
            mappedSignals[nsName].add(writeSignal);
            signalsToAdd.push({ name: `${nsName}_seek_to_continuous`, on: continuousHandlers });
            mappedSignals[nsName].add("seek_to_continuous");
          } else if (continuousHandlers.length) {
            sig.name = `${nsName}_seek_to_continuous`;
            mappedSignals[nsName].add("seek_to_continuous");
          } else {
            sig.name = `${nsName}_${writeSignal}`;
            mappedSignals[nsName].add(writeSignal);
          }
        } else {
          mappedSignals[nsName].add(writeSignal);
          sig.name = `${nsName}_${writeSignal}`;
        }
      }
    }
  }
  for (const s of signalsToAdd) signalsArr.push(s);

  const result = {};
  for (const n of namespaces) {
    result[n] = Array.from(mappedSignals[n]);
  }
  return result;
}

function compileAnnotationMarks(spec, playerName, annotation) {
  if (!annotation?.marks?.length) return;

  const baseData = annotation.data;
  if (!baseData) return;

  const dataArr = ensureArray(spec, "data");

  for (let i = 0; i < annotation.marks.length; i++) {
    const mark = annotation.marks[i];
    const vegaTransforms = mark.transform ? [...mark.transform] : [];

    const encode = mark.encode?.update || mark.encode;
    if (encode) {
      for (const channel of Object.keys(encode)) {
        const ch = encode[channel];
        if (ch && "signal" in ch) {
          const fieldName = `_${channel}`;
          vegaTransforms.push({ type: "formula", as: fieldName, expr: ch.signal });
          encode[channel] = { field: fieldName };
        }
      }
    }

    if (!vegaTransforms.length) continue;

    const derivedName = `${playerName}_annotation_${i}`;
    dataArr.push({
      name: derivedName,
      source: baseData,
      transform: vegaTransforms
    });

    mark.from = { data: derivedName };
    delete mark.transform;
  }
}

function injectPlaylistData(spec, playerName, playlist) {
  if (!playlist.source) return;

  const datasetName = `${playerName}_playlist_data`;
  const filters = playlist.filter || [];

  // Build filter transforms using Vega's vlSelectionTest (pass all data through when no filter)
  const transforms = filters.map(paramName => ({
    type: "filter",
    expr: `!length(data("${paramName}_store")) || vlSelectionTest("${paramName}_store", datum)`
  }));

  const derivedData = {
    name: datasetName,
    source: playlist.source,
    transform: transforms.length ? transforms : undefined
  };

  const dataArr = ensureArray(spec, "data");
  dataArr.push(derivedData);

  playlist.data = datasetName;
  delete playlist.source;
  delete playlist.filter;
}

export function rewriteSpec(spec, opts = {}) {
  if (!spec || typeof spec !== "object") return spec;
  if (spec.usermeta?.__vegaVideoRewritten) return spec;

  const cloned = JSON.parse(JSON.stringify(spec));
  if (!cloned.usermeta) cloned.usermeta = {};

  let namespaces = opts.videos?.map(v => v.name) || [];
  if (!namespaces.length && cloned.players) {
    namespaces = Array.isArray(cloned.players)
      ? cloned.players.map(p => p.name)
      : Object.keys(cloned.players);
  }

  const mappedSignals = findAndMapVidSignalRefs(cloned, namespaces);

  const signalsArr = ensureArray(cloned, "signals");
  const hasSignal = name => signalsArr.some(s => s?.name === name);

  for (const nsName of namespaces) {
    for (const key of Object.keys(SIGNAL_DEFAULTS)) {
      const sigName = ns(nsName, key);
      if (!hasSignal(sigName)) {
        signalsArr.push({ name: sigName, value: SIGNAL_DEFAULTS[key].value });
      }
    }
  }

  if (cloned.players) {
    const playersArr = Array.isArray(cloned.players) ? cloned.players : Object.values(cloned.players);
    for (const player of playersArr) {
      if (player.annotation && player.fps == null) {
        throw new Error(
          `vega-video: Player "${player.name}" has an annotation but no fps specified. ` +
          `Annotations require fps to calculate frame indices.`
        );
      }
      if (player.annotation) {
        compileAnnotationMarks(cloned, player.name, player.annotation);
      }
      if (player.playlist?.source) {
        injectPlaylistData(cloned, player.name, player.playlist);
      }
    }

    cloned.usermeta.players = cloned.players;
    delete cloned.players;

    for (const nsName of namespaces) {
      const player = Array.isArray(cloned.usermeta.players)
        ? cloned.usermeta.players.find(p => p.name === nsName)
        : cloned.usermeta.players[nsName];
      if (player && mappedSignals[nsName]?.length) {
        player.signals = mappedSignals[nsName];
      }
    }
  }

  cloned.usermeta.__vegaVideoRewritten = true;
  return cloned;
}
