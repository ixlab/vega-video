# vega-video.js / Brushing, Linking, and Syncing with Video Data

Vega-Video is a [Vega](https://vega.github.io/vega/) plugin for video data.
It lets you create portable, expressive, and performant visualizations combining conventional and video data.

Vega-Video lets you sync with a video player through signals (e.g., `@player:time`), annotate videos with CV detections (e.g., draw bounding boxes), and compose and transform videos (e.g., filter or sort a compilation).

## Build

```bash
bun run build
```

Then the output is in `dist/vega-video.js`.

## Use

A minimal example:

```html
<html>

<head>
    <script src="https://cdn.jsdelivr.net/npm/vega@6"></script>
    <script src="https://cdn.jsdelivr.net/npm/vega-lite@6"></script>
    <script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
    <!-- Optional: needed for video transformation/playlists -->
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script src="./dist/vega-video.js"></script>
</head>

<body>
    <div id="vis"></div>
    <video id="myVideo" controls playsinline preload="metadata"></video>

    <script>
        (async function () {
            const spec = { /* Spec here */ };
            const videos = [{ name: "main", ref: '#myVideo' }];

            const rewritten = vegaVideo.rewrite(spec, { videos });
            const result = await vegaEmbed('#vis', rewritten, { actions: false });
            const view = result.view;

            vegaVideo.attach(view, {
                videos,
                spec: rewritten
            });
        })();
    </script>
</body>

</html>
```
