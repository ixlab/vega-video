# vega-video

Vega-Video is a [Vega](https://vega.github.io/vega/) plugin for video data.
It lets you create portable, expressive, and performant visualizations combining conventional and video data.

Vega-Video lets you sync with a video player through signals (e.g., `@player:time`), annotate videos with CV detections (e.g., draw bounding boxes), and compose and transform videos (e.g., filter or sort a compilation).

## Quick Start

- Try the **[Vega-Video Editor](https://ixlab.github.io/vega-video/editor/)** to experiment with video specs interactively
- See the **[Vega Editor](https://vega.github.io/editor/)** for the base Vega grammar

## Use

Include Vega-Video alongside [Vega](https://vega.github.io/vega/), [Vega-Lite](https://vega.github.io/vega-lite/), and [Vega-Embed](https://github.com/vega/vega-embed). Optionally include [hls.js](https://github.com/video-dev/hls.js) for video transformation/playlists.

```html
<script src="https://cdn.jsdelivr.net/npm/vega@6"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@6"></script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
<!-- Optional: needed for video transformation/playlists -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script src="vega-video.js"></script>
```

```js
const spec = { /* Vega spec with @player:signal references */ };
const videos = [{ name: "main", ref: '#myVideo' }];

const rewritten = vegaVideo.rewrite(spec, { videos });
const result = await vegaEmbed('#vis', rewritten, { actions: false });
vegaVideo.attach(result.view, { videos, spec: rewritten });
```

## Build from Source

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run build    # outputs dist/vega-video.js and dist/vega-video.esm.js
bun test
```

## About

Developed by the OSU Interactive Data Systems Lab.

**License:** Apache-2.0

**Acknowledgements:** Supported by the Imageomics Institute (NSF Award #2118240) and NSF Award #1910356.
