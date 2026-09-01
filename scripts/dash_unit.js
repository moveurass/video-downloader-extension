"use strict";

const assert = require("node:assert/strict");
const DownloadEngine = require("../src/download-engine.js");
const PopupMedia = require("../src/popup-media.js");
const Naming = require("../src/naming.js");
const DirectMedia = require("../src/background-direct-media.js");
const SmartDownload = require("../src/background-smart-download.js");
const DirectMessages = require("../src/background-direct-download-messages.js");

async function main() {
  const manifestUrl = "https://cdn.example/video/manifest.mpd?token=abc";
  const pageUrl = "https://example.com/watch/1";

  assert.equal(DownloadEngine.isDashUrl(manifestUrl), true);
  assert.equal(DownloadEngine.isRealDash(manifestUrl, "stream"), true);
  assert.equal(DownloadEngine.classifyMedia(manifestUrl).type, "stream");
  assert.equal(
    DownloadEngine.isLikelyMedia(manifestUrl, "application/dash+xml"),
    true
  );
  assert.equal(PopupMedia.isHlsItem({ url: manifestUrl, type: "stream" }), true);
  assert.equal(
    Naming.isJunkMedia({ url: manifestUrl, type: "stream", title: "Episode 1" }),
    false
  );

  let helperPayload;
  const progress = [];
  const jobs = new Map([["job-1", {}]]);
  const transport = DirectMedia.createTransport({
    YtDlp: {
      available: async () => true,
      downloadAndWait: async (payload, onProgress) => {
        helperPayload = payload;
        onProgress({
          percent: 45,
          message: "video track",
          status: "running",
          helperJobId: "helper-1"
        });
        return {
          path: "/downloads/episode.mp4",
          filename: "episode.mp4",
          size: 123456
        };
      }
    },
    UVD: {
      getSettings: async () => ({ codecPref: "h264", downloadSpeed: "safe" })
    },
    activeDownloads: jobs,
    getCookieHeaderForUrl: async () => "session=ok",
    ytdlpFilenameHint: (value) => value,
    throwIfJobStopped: () => {},
    emitDownloadProgress: (...args) => progress.push(args)
  });
  const result = await transport.downloadDashViaHelper(
    7,
    manifestUrl,
    pageUrl,
    "episode.mp4",
    "1080p",
    "job-1"
  );
  assert.deepEqual(helperPayload, {
    url: manifestUrl,
    pageUrl,
    referer: pageUrl,
    manifest: true,
    filename: "episode.mp4",
    title: "episode.mp4",
    quality: "1080p",
    audioTrackId: undefined,
    subtitleLanguages: [],
    cookieHeader: "session=ok",
    codecPref: "h264",
    speedProfile: "safe"
  });
  assert.equal(jobs.get("job-1").helperJobId, "helper-1");
  assert.equal(progress[0][1], 45);
  assert.equal(result.method, "yt-dlp-dash");
  assert.equal(result.filename, "episode.mp4");

  const routed = [];
  const router = SmartDownload.createRouter({
    activeDownloads: new Map(),
    getCurrentJobContext: () => "job-1",
    resolvePageUrl: async () => pageUrl,
    emitDownloadProgress: (...args) => routed.push(args),
    isRealDash: DownloadEngine.isRealDash,
    downloadDashViaHelper: async (...args) => {
      routed.push(["dash", ...args]);
      return result;
    }
  });
  const routedResult = await router.downloadSmart(
    7,
    manifestUrl,
    "episode.mp4",
    "1080p",
    "stream"
  );
  assert.equal(routedResult.method, "yt-dlp-dash");
  assert.equal(routed.some((entry) => entry[0] === "dash"), true);
  assert.deepEqual(
    routed.filter((entry) => entry[0] !== "dash").map((entry) => entry[3]),
    ["start", "playlist", "done"]
  );

  let directOperation;
  let directSmartArgs;
  const directHandler = DirectMessages.createHandler({
    Naming: {},
    lockSaveName: () => "episode.mp4",
    getTabMap: () => new Map(),
    isHlsUrl: () => false,
    needsYtDlpHelper: () => false,
    runTrackedDownload: (_meta, operation) => {
      directOperation = operation;
    },
    findOrOpenTabForPage: async () => ({ tabId: 7, opened: false }),
    downloadSmart: async (...args) => {
      directSmartArgs = args;
      return { method: "yt-dlp-dash", ytdlp: true, filename: "episode.mp4" };
    },
    chrome: { tabs: { remove: async () => {} } },
    setTimeout
  });
  directHandler(
    {
      type: "DOWNLOAD",
      url: manifestUrl,
      pageUrl,
      openPageIfNeeded: true
    },
    7,
    () => {}
  );
  await directOperation("job-2");
  assert.equal(directSmartArgs[4], "stream");
  assert.equal(directSmartArgs[5].isHls, true);

  console.log("DASH/MPD helper routing: 18 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
