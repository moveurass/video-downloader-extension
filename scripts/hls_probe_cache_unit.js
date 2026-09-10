"use strict";

const assert = require("node:assert/strict");
const HLS = require("../src/hls-downloader.js");

async function main() {
  const originalFetch = global.fetch;
  let fetches = 0;
  const master = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080",
    "1080/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720",
    "720/index.m3u8"
  ].join("\n");

  global.fetch = async () => {
    fetches += 1;
    return new Response(master, { status: 200 });
  };
  try {
    const first = await HLS.probe("https://cdn.test/cache/master.m3u8");
    const second = await HLS.probe("https://cdn.test/cache/master.m3u8");
    assert.equal(first.kind, "master");
    assert.equal(first.variants.length, 2);
    assert.equal(fetches, 1, "repeat probe within TTL is served from cache");
    assert.equal(
      second.variants[0].url,
      first.variants[0].url,
      "cached probe returns the same resolved variants"
    );

    HLS.clearProbeCache();
    await HLS.probe("https://cdn.test/cache/master.m3u8");
    assert.equal(fetches, 2, "cleared cache refetches the playlist");
  } finally {
    global.fetch = originalFetch;
    HLS.clearProbeCache();
  }

  console.log("hls probe cache: 5 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
