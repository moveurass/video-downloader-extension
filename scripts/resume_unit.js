"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const HLS = require("../src/hls-downloader.js");
const HlsRuntime = require("../src/background-hls-runtime.js");
const DirectMedia = require("../src/background-direct-media.js");
const UVDProgress = require("../src/progress-protocol.js");
const { createManager } = require("../src/background-download-jobs.js");

async function testHlsSkipsCheckpointedSegments() {
  const originalFetch = global.fetch;
  const fetched = [];
  const stored = [];
  const playlist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:10,",
    "seg1.ts",
    "#EXTINF:10,",
    "seg2.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  const segment = new Uint8Array(120_000);
  segment[0] = 0x47;

  global.fetch = async (url) => {
    const value = String(url);
    fetched.push(value);
    if (value.endsWith("playlist.m3u8")) {
      return new Response(playlist, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      });
    }
    return new Response(segment.slice(), {
      status: 200,
      headers: { "Content-Type": "video/mp2t" }
    });
  };

  try {
    const result = await HLS.downloadAndMerge(
      "https://media.test/playlist.m3u8",
      {
        resumeParts: new Map([
          [
            1,
            {
              size: segment.byteLength,
              sourceUrl: "https://media.test/seg1.ts"
            }
          ]
        ]),
        onSegmentData: async (index, data, metadata) => {
          stored.push({ index, size: data.byteLength, metadata });
        },
        allowPartial: false,
        speedProfile: "safe"
      }
    );
    assert.equal(
      fetched.filter((url) => url.endsWith("seg1.ts")).length,
      0,
      "checkpointed segment is not fetched again"
    );
    assert.equal(
      fetched.filter((url) => url.endsWith("seg2.ts")).length,
      1
    );
    assert.deepEqual(stored, [
      {
        index: 2,
        size: segment.byteLength,
        metadata: { sourceUrl: "https://media.test/seg2.ts" }
      }
    ]);
    assert.equal(result.streamed, true);
    assert.equal(result.segmentCount, 2);
    assert.equal(result.size, segment.byteLength * 2);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testHlsRuntimePreservesPauseCheckpoint() {
  const job = {
    id: "job-hls",
    status: "running",
    progressAttempt: 1,
    title: "Episode",
    filename: "Episode.mp4"
  };
  const activeDownloads = new Map([[job.id, job]]);
  const writes = [];
  const deletes = [];
  let storedParts = [];
  let run = 0;
  let resumedPart;

  const runner = HlsRuntime.createRunner({
    HLS: {
      downloadAndMerge: async (_url, options) => {
        run += 1;
        if (run === 1) {
          const data = new Uint8Array(120_000);
          await options.onSegmentData(1, data, {
            sourceUrl: "https://media.test/seg1.ts"
          });
          storedParts = [{ index: 1, size: data.byteLength }];
          job.pauseRequested = true;
          job.status = "paused";
          const error = new Error("PAUSED");
          error.code = "PAUSED";
          throw error;
        }
        resumedPart = options.resumeParts.get(1);
        return {
          streamed: true,
          size: 240_000,
          quality: "720p",
          segmentCount: 2
        };
      }
    },
    UVD: {
      getSettings: async () => ({}),
      isGenericSaveName: () => false
    },
    Naming: { buildFilename: () => "Episode.mp4" },
    activeDownloads,
    getCurrentJobContext: () => job.id,
    jobAbortControllers: new Map(),
    hlsProgress: new Map(),
    resolvePageUrl: async () => "https://example.test/watch",
    lockSaveName: () => "Episode.mp4",
    applyQualityToLockedName: (name) => name,
    safeDownloadName: (name) => name,
    hlsPhasePercent: (progress) => progress.percent || 5,
    estimateSavePercent: () => 90,
    emitDownloadProgress: () => {},
    broadcastJob: () => {},
    throwIfJobStopped: () => {},
    openBlobDb: async () => ({ close() {} }),
    idbPutPart: async (_db, key, data) =>
      writes.push({ key, size: data.byteLength }),
    idbPartKey: (base, index) => `${base}:p:${index}`,
    idbListParts: async () => storedParts,
    idbDeleteParts: async (base) => deletes.push(base),
    downloadPartsViaTab: async () => ({
      downloadId: 10,
      filename: "Episode.mp4",
      path: "/Downloads/Episode.mp4",
      state: "complete"
    }),
    downloadBlob: async () => {
      throw new Error("unexpected blob save");
    }
  });

  await assert.rejects(
    () =>
      runner.runHlsDownload(
        7,
        "https://media.test/playlist.m3u8",
        "720p",
        "Episode.mp4",
        {},
        "https://example.test/watch",
        job.id
      ),
    /PAUSED/
  );
  assert.equal(writes.length, 1);
  assert.equal(deletes.length, 0, "pause keeps completed IDB parts");
  assert.equal(job.resumeState.kind, "hls");
  const checkpointBase = job.resumeState.partBase;

  job.pauseRequested = false;
  job.status = "running";
  const result = await runner.runHlsDownload(
    7,
    "https://media.test/playlist.m3u8",
    "720p",
    "Episode.mp4",
    {},
    "https://example.test/watch",
    job.id
  );
  assert.deepEqual(resumedPart, {
    size: 120_000,
    sourceUrl: "https://media.test/seg1.ts"
  });
  assert.equal(checkpointBase.startsWith("hls_job-hls"), true);
  assert.equal(result.downloadId, 10);
  assert.equal(job.resumeState, undefined);
}

async function testNativeDirectPauseResume() {
  const paused = [];
  const resumed = [];
  let restarted = 0;
  const chrome = {
    runtime: {
      sendMessage: async () => {},
      getURL: (path) => `chrome-extension://unit/${path}`
    },
    storage: { session: { set: async () => {} } },
    tabs: { sendMessage: async () => {} },
    downloads: {
      pause: async (id) => paused.push(id),
      resume: async (id) => resumed.push(id),
      cancel: async () => {},
      search: async () => [],
      show() {},
      showDefaultFolder() {}
    },
    notifications: {
      onClicked: { addListener() {} },
      create: async () => {},
      clear: async () => {}
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {}
    }
  };
  const manager = createManager({
    chrome,
    UVD: {
      classifyError: () => ({}),
      formatSpeed: () => "",
      isGenericSaveName: () => false,
      getSettings: async () => ({ showBadge: false }),
      appendHistory: async () => {},
      siteFromUrl: () => "example"
    },
    UVDProgress,
    Naming: { cleanPageTitle: (value) => value },
    YtDlp: { cancelJob: async () => {} },
    parseSpeedFromMessage: () => 0,
    getTabMeta: () => ({}),
    saveCompanionThumbnail: async () => {},
    downloadPageFromUi: async () => {
      restarted += 1;
    },
    startKeepAlive: () => true,
    stopKeepAlive: () => {},
    setTimeout: () => 1
  });
  const jobId = manager.createDownloadJob({
    tabId: 7,
    title: "Direct",
    pageUrl: "https://example.test/video.mp4",
    mediaUrl: "https://cdn.test/video.mp4",
    filename: "Direct.mp4"
  });
  const job = manager.activeDownloads.get(jobId);
  job.resumeState = {
    kind: "direct",
    downloadId: 42,
    bytesReceived: 5_000_000,
    totalBytes: 10_000_000
  };

  const pauseResult = await manager.pauseDownloadJob(jobId);
  assert.deepEqual(paused, [42]);
  assert.equal(pauseResult.resumeKind, "http-range");
  assert.equal(job.status, "paused");
  assert.equal(job.percent, 2);

  const resumeResult = await manager.resumeDownloadJob(jobId);
  assert.deepEqual(resumed, [42]);
  assert.equal(resumeResult.resumeKind, "http-range");
  assert.equal(job.status, "running");
  assert.equal(job.message, "이어받는 중…");
  assert.equal(restarted, 0, "native direct resume does not restart orchestration");
}

async function testDirectTransportRegistersCheckpoint() {
  const job = { id: "job-direct", tabId: 7 };
  const jobs = new Map([[job.id, job]]);
  let checkpointDuringWait;
  const progress = [];
  const transport = DirectMedia.createTransport({
    activeDownloads: jobs,
    safeDownloadName: (value) => value,
    filenameFromUrl: () => "Direct.mp4",
    relDownloadPath: async (value) => value,
    startChromeDownload: async () => 77,
    waitDownloadComplete: async (_id, timeout, options) => {
      checkpointDuringWait = { ...job.resumeState, timeout };
      options.onProgress({
        bytesReceived: 5_000_000,
        totalBytes: 10_000_000
      });
      return {
        state: "complete",
        path: "/Downloads/Direct.mp4",
        bytesReceived: 10_000_000
      };
    },
    emitDownloadProgress: (...args) => progress.push(args)
  });
  const result = await transport.downloadMedia(
    "https://cdn.test/video.mp4",
    "Direct.mp4",
    job.id
  );
  assert.deepEqual(checkpointDuringWait, {
    kind: "direct",
    downloadId: 77,
    url: "https://cdn.test/video.mp4",
    timeout: 40 * 60 * 1000
  });
  assert.equal(progress[0][1], 49);
  assert.equal(result.size, 10_000_000);
  assert.equal(job.resumeState, undefined);
}

async function main() {
  await testHlsSkipsCheckpointedSegments();
  await testHlsRuntimePreservesPauseCheckpoint();
  await testDirectTransportRegistersCheckpoint();
  await testNativeDirectPauseResume();
  const helperSource = fs.readFileSync(
    path.join(__dirname, "../helper/yt_dlp_server.py"),
    "utf8"
  );
  assert.equal(helperSource.includes('"--continue"'), true);
  assert.equal(helperSource.includes('"--part"'), true);
  assert.equal(helperSource.includes("aria2c:-c true"), true);
  console.log("resume contract: HLS checkpoints, helper continuation, and direct Range passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
