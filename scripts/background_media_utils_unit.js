"use strict";

const assert = require("node:assert/strict");
const {
  qualityLabel,
  hashUrl,
  createAlternativeSelector
} = require("../src/background-media-utils.js");

assert.equal(qualityLabel(2160), "4K");
assert.equal(qualityLabel(1440), "1440p");
assert.equal(qualityLabel(1080), "1080p");
assert.equal(qualityLabel(720), "720p");
assert.equal(qualityLabel(360), "360p");
assert.equal(qualityLabel(240), "240p");
assert.equal(qualityLabel(0), null);

assert.equal(hashUrl(""), "0");
assert.equal(hashUrl("https://example.test/video"), hashUrl("https://example.test/video"));
assert.notEqual(hashUrl("first"), hashUrl("second"));

const items = [
  { url: "blob:local", score: 1000 },
  { url: "https://cdn.test/excluded.mp4", score: 900 },
  { url: "https://cdn.test/junk.mp4", score: 800, junk: true },
  { url: "https://cdn.test/video.mp4", score: 600 },
  { url: "https://cdn.test/stream.m3u8", score: 200 }
];
const selectAlternative = createAlternativeSelector({
  getTabItems(tabId) {
    assert.equal(tabId, 7);
    return items;
  },
  Naming: {
    isJunkMedia: (item) => !!item.junk,
    mediaScore: (item) => item.score
  }
});
assert.equal(
  selectAlternative(7, "https://cdn.test/excluded.mp4").url,
  "https://cdn.test/stream.m3u8",
  "HLS preference is retained"
);
assert.equal(
  createAlternativeSelector({
    getTabItems: () => [],
    Naming: { isJunkMedia: () => false, mediaScore: () => 0 }
  })(1, ""),
  null
);

console.log("background media utils: labels, hashes, and alternatives passed");
