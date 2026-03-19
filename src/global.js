// src/global.js

import * as vegaVideo from "./index.js";

if (typeof window !== "undefined") {
  window.vegaVideo = vegaVideo;
}
