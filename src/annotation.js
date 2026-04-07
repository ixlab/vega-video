// src/annotation.js

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_CORNER_LENGTH = 10;
const DEFAULT_DOT_RADIUS = 4;
const DEFAULT_STROKE_WIDTH = 2;
const LABEL_PADDING = 4;
const ELLIPSE_VERTICAL_SCALE = 0.42;

const DEFAULT_COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
  "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080"
];

function getColor(classId, colorMap, colors) {
  if (colorMap && colorMap[classId] !== undefined) {
    return colorMap[classId];
  }
  return colors[Math.abs(classId || 0) % colors.length];
}

export class AnnotationRenderer {
  constructor(video, view, dataSource, marks, opts = {}) {
    this.video = video;
    this.view = view;
    this.dataSource = dataSource;
    this.marks = marks || [];
    this.opts = opts;
    this.canvas = null;
    this.ctx = null;
    this._colors = opts.colors || DEFAULT_COLORS;
    this._colorMap = opts.colorMap || {};

    // set later by _updateLayout
    this._offsetX = 0;        // content area X offset in CSS px
    this._offsetY = 0;        // content area Y offset in CSS px

    // Data coordinate → CSS px scale
    this._scaleX = 1;
    this._scaleY = 1;
    this._devicePixelRatio = 1;

    this._unsubs = [];
    this._resizeObserver = null;

    this._createCanvas();
    this._bindVideoEvents();
    this._bindResize();
    this._bindDataListener();
  }

  _createCanvas() {
    const container = this.video.parentElement;
    if (!container) {
      console.warn("vega-video: video must have a parent element for annotations");
      return;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.pointerEvents = "none";

    const parentStyle = getComputedStyle(container);
    if (parentStyle.position === "static") {
      container.style.position = "relative";
    }

    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
  }

  _updateLayout() {
    if (!this.canvas || !this.video) return;

    const el = this.video;
    const dpr = window.devicePixelRatio || 1;
    const elW = el.clientWidth;
    const elH = el.clientHeight;
    if (!elW || !elH) return;

    const vidW = el.videoWidth || 1;
    const vidH = el.videoHeight || 1;

    // Set canvas backing store to DPR-scaled size for crisp rendering
    this.canvas.width = Math.round(elW * dpr);
    this.canvas.height = Math.round(elH * dpr);

    // Compute video content rect in CSS pixels (object-fit: contain)
    const elAR = elW / elH;
    const vidAR = vidW / vidH;

    let cw, ch;
    if (elAR > vidAR) {
      // Element wider than video → pillarboxed (black bars on sides)
      ch = elH;
      cw = ch * vidAR;
    } else {
      // Element taller than video → letterboxed (black bars top/bottom)
      cw = elW;
      ch = cw / vidAR;
    }

    this._offsetX = (elW - cw) / 2;
    this._offsetY = (elH - ch) / 2;

    // Data coordinate space (detection coords, may differ from video resolution)
    const dataWidth = this.opts.dataWidth || vidW;
    const dataHeight = this.opts.dataHeight || vidH;
    this._scaleX = cw / dataWidth;
    this._scaleY = ch / dataHeight;
    this._devicePixelRatio = dpr;
  }

  _tx(dataX) { return this._offsetX + dataX * this._scaleX; }

  _ty(dataY) { return this._offsetY + dataY * this._scaleY; }

  _bindVideoEvents() {
    const onMeta = () => {
      this._updateLayout();
      this._render();
    };

    this.video.addEventListener("loadedmetadata", onMeta);

    if (this.video.videoWidth) {
      onMeta();
    }
  }

  _bindResize() {
    if (typeof ResizeObserver === "undefined") return;

    this._resizeObserver = new ResizeObserver(() => {
      this._updateLayout();
      this._render();
    });

    const container = this.video.parentElement;
    if (container) this._resizeObserver.observe(container);
  }

  _bindDataListener() {
    if (!this.view) return;

    const handler = () => this._render();

    const sources = new Set();
    if (this.dataSource) sources.add(this.dataSource);
    for (const mark of this.marks) {
      if (mark.from?.data) sources.add(mark.from.data);
    }

    for (const src of sources) {
      try {
        this.view.addDataListener(src, handler);
        this._unsubs.push(() => {
          try { this.view.removeDataListener(src, handler); } catch { }
        });
      } catch (e) {
        console.warn("vega-video: failed to bind data listener for", src, e);
      }
    }

    this._render();
  }

  _getData(source) {
    if (!this.view || !source) return [];
    try {
      return this.view.data(source) || [];
    } catch {
      return [];
    }
  }

  _render() {
    if (!this.ctx || !this.canvas) return;

    // Apply DPR transform so all drawing is in CSS-pixel units
    this.ctx.setTransform(this._devicePixelRatio, 0, 0, this._devicePixelRatio, 0, 0);
    const cssW = this.canvas.width / this._devicePixelRatio;
    const cssH = this.canvas.height / this._devicePixelRatio;
    this.ctx.clearRect(0, 0, cssW, cssH);

    for (const mark of this.marks) {
      const detections = this._getData(mark.from?.data || this.dataSource);
      const type = mark.type;
      if (type === "boundingbox") {
        this._renderBoundingBoxes(detections, mark);
      } else if (type === "label") {
        this._renderLabels(detections, mark);
      } else if (type === "corner") {
        this._renderCorners(detections, mark);
      } else if (type === "dot") {
        this._renderDots(detections, mark);
      } else if (type === "circle") {
        this._renderCircles(detections, mark);
      } else if (type === "ellipse") {
        this._renderEllipses(detections, mark);
      }
    }
  }

  /** Extract bbox from a detection datum, returns null if invalid */
  _bbox(d, encode) {
    let x_min, y_min, x_max, y_max;

    if (encode?.xyxy?.field) {
      const xyxy = d[encode.xyxy.field];
      if (Array.isArray(xyxy) && xyxy.length === 4) {
        [x_min, y_min, x_max, y_max] = xyxy;
        if (Number.isFinite(x_min) && Number.isFinite(y_min) &&
          Number.isFinite(x_max) && Number.isFinite(y_max)) {
          return { x_min, y_min, x_max, y_max };
        }
      }
    }

    x_min = d.x_min ?? d.xmin;
    y_min = d.y_min ?? d.ymin;
    x_max = d.x_max ?? d.xmax;
    y_max = d.y_max ?? d.ymax;

    if (!Number.isFinite(x_min) || !Number.isFinite(y_min) ||
      !Number.isFinite(x_max) || !Number.isFinite(y_max)) return null;

    return { x_min, y_min, x_max, y_max };
  }

  _forEachDetection(detections, mark, drawFn) {
    const encode = mark.encode?.update || mark.encode || {};
    for (const d of detections) {
      const b = this._bbox(d, encode);
      if (!b) continue;
      const classId = encode.class_id?.field
        ? (d[encode.class_id.field] ?? 0)
        : (d.class_id ?? 0);
      drawFn(d, b, classId);
    }
  }

  _renderBoundingBoxes(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const lineWidth = encode.strokeWidth?.value ?? DEFAULT_STROKE_WIDTH;
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const x = this._tx(b.x_min);
      const y = this._ty(b.y_min);
      const w = (b.x_max - b.x_min) * this._scaleX;
      const h = (b.y_max - b.y_min) * this._scaleY;

      this.ctx.lineWidth = lineWidth;
      this.ctx.strokeStyle = (encode.stroke?.field ? d[encode.stroke.field] : encode.stroke?.value)
        || getColor(classId, this._colorMap, this._colors);
      this.ctx.strokeRect(x, y, w, h);
    });
  }

  _renderLabels(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const fontSize = encode.fontSize?.value ?? DEFAULT_FONT_SIZE;
    const textColor = encode.textColor?.value || "#000";
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const x = this._tx(b.x_min);
      const y = this._ty(b.y_min);

      const bgColor = (encode.fill?.field ? d[encode.fill.field] : encode.fill?.value)
        || getColor(classId, this._colorMap, this._colors);

      let labelText;
      if (encode.label?.field) {
        labelText = String(d[encode.label.field] ?? "");
      } else {
        const className = d.class_name ?? `Class ${classId}`;
        const confidence = d.confidence;
        labelText = confidence !== undefined
          ? `${className} ${(confidence * 100).toFixed(0)}%`
          : className;
      }

      this.ctx.font = `${fontSize}px system-ui, sans-serif`;
      this.ctx.textBaseline = "top";

      const textW = this.ctx.measureText(labelText).width;
      const textH = fontSize + LABEL_PADDING;

      const ly = y - textH - 2 < this._offsetY ? y + 2 : y - textH - 2;

      this.ctx.fillStyle = bgColor;
      this.ctx.fillRect(x, ly, textW + LABEL_PADDING * 2, textH);

      this.ctx.fillStyle = textColor;
      this.ctx.fillText(labelText, x + LABEL_PADDING, ly + 2);
    });
  }

  _renderCorners(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const lineWidth = encode.strokeWidth?.value ?? DEFAULT_STROKE_WIDTH;
    const cornerLength = encode.cornerLength?.value ?? DEFAULT_CORNER_LENGTH;
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const x = this._tx(b.x_min);
      const y = this._ty(b.y_min);
      const x2 = this._tx(b.x_max);
      const y2 = this._ty(b.y_max);
      const cl = Math.min(cornerLength, (x2 - x) / 2, (y2 - y) / 2);

      this.ctx.lineWidth = lineWidth;
      this.ctx.strokeStyle = (encode.stroke?.field ? d[encode.stroke.field] : encode.stroke?.value)
        || getColor(classId, this._colorMap, this._colors);
      this.ctx.beginPath();
      this.ctx.moveTo(x, y + cl); this.ctx.lineTo(x, y); this.ctx.lineTo(x + cl, y);
      this.ctx.moveTo(x2 - cl, y); this.ctx.lineTo(x2, y); this.ctx.lineTo(x2, y + cl);
      this.ctx.moveTo(x2, y2 - cl); this.ctx.lineTo(x2, y2); this.ctx.lineTo(x2 - cl, y2);
      this.ctx.moveTo(x + cl, y2); this.ctx.lineTo(x, y2); this.ctx.lineTo(x, y2 - cl);
      this.ctx.stroke();
    });
  }

  _renderDots(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const radius = encode.radius?.value ?? DEFAULT_DOT_RADIUS;
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const cx = this._tx((b.x_min + b.x_max) / 2);
      const cy = this._ty((b.y_min + b.y_max) / 2);

      this.ctx.fillStyle = (encode.fill?.field ? d[encode.fill.field] : encode.fill?.value)
        || getColor(classId, this._colorMap, this._colors);
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      this.ctx.fill();
    });
  }

  _renderCircles(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const lineWidth = encode.strokeWidth?.value ?? DEFAULT_STROKE_WIDTH;
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const cx = this._tx((b.x_min + b.x_max) / 2);
      const cy = this._ty((b.y_min + b.y_max) / 2);
      const dataR = Math.max(b.x_max - b.x_min, b.y_max - b.y_min) / 2;
      const scale = Math.min(this._scaleX, this._scaleY);
      const r = dataR * scale;

      this.ctx.lineWidth = lineWidth;
      this.ctx.strokeStyle = (encode.stroke?.field ? d[encode.stroke.field] : encode.stroke?.value)
        || getColor(classId, this._colorMap, this._colors);
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      this.ctx.stroke();
    });
  }

  _renderEllipses(detections, mark) {
    const encode = mark.encode?.update || mark.encode || {};
    const lineWidth = encode.strokeWidth?.value ?? DEFAULT_STROKE_WIDTH;
    this._forEachDetection(detections, mark, (d, b, classId) => {
      const cx = this._tx((b.x_min + b.x_max) / 2);
      const baseY = this._ty(b.y_max);
      const rx = ((b.x_max - b.x_min) / 2) * this._scaleX;
      const ry = ((b.y_max - b.y_min) / 2) * this._scaleY * ELLIPSE_VERTICAL_SCALE;

      this.ctx.lineWidth = lineWidth;
      this.ctx.strokeStyle = (encode.stroke?.field ? d[encode.stroke.field] : encode.stroke?.value)
        || getColor(classId, this._colorMap, this._colors);
      this.ctx.beginPath();
      this.ctx.ellipse(cx, baseY, rx, ry, 0, 0, 2 * Math.PI);
      this.ctx.stroke();
    });
  }

  destroy() {
    for (const fn of this._unsubs) fn();
    this._unsubs = [];
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
  }
}
