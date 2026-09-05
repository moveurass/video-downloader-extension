"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const HLS = require("../src/hls-downloader.js");
const HlsRuntime = require("../src/background-hls-runtime.js");
const DirectMedia = require("../src/background-direct-media.js");
const UVDProgress = require("../src/progress-protocol.js");
const { createManager } = require("../src/background-download-jobs.js");
const SavePipeline = require("../src/background-save-pipeline.js");

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
        metadata: {
          sourceUrl: "https://media.test/seg2.ts",
          sourceId: "1:https://media.test/seg2.ts"
        }
      }
    ]);
    assert.equal(result.streamed, true);
    assert.equal(result.segmentCount, 2);
    assert.equal(result.size, segment.byteLength * 2);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testLiveHlsRequiresSequenceIdentity() {
  const originalFetch = global.fetch;
  const fetched = [];
  const playlist = [
    "#EXTM3U",
    "#EXT-X-MEDIA-SEQUENCE:42",
    "#EXTINF:6,",
    "rolling.ts",
    "#EXTINF:6,",
    "next.ts"
  ].join("\n");
  const segment = new Uint8Array(120_000);
  segment[0] = 0x47;
  global.fetch = async (url) => {
    fetched.push(String(url));
    return String(url).endsWith(".m3u8")
      ? new Response(playlist, { status: 200 })
      : new Response(segment.slice(), { status: 200 });
  };
  try {
    await HLS.downloadAndMerge("https://live.test/index.m3u8", {
      resumeParts: new Map([
        [
          1,
          {
            size: segment.byteLength,
            sourceUrl: "https://live.test/rolling.ts"
          }
        ]
      ]),
      onSegmentData: async () => {},
      allowPartial: false,
      speedProfile: "safe"
    });
    assert.equal(
      fetched.filter((url) => url.endsWith("rolling.ts")).length,
      1,
      "live URL alone is not a safe checkpoint identity"
    );

    fetched.length = 0;
    await HLS.downloadAndMerge("https://live.test/index.m3u8", {
      resumeParts: new Map([
        [
          1,
          {
            size: segment.byteLength,
            sourceUrl: "https://live.test/rolling.ts",
            sourceId: "42:https://live.test/rolling.ts"
          }
        ]
      ]),
      onSegmentData: async () => {},
      allowPartial: false,
      speedProfile: "safe"
    });
    assert.equal(
      fetched.filter((url) => url.endsWith("rolling.ts")).length,
      0,
      "matching live media sequence reuses the checkpoint"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testBrowserHlsAlternateAudio() {
  const originalFetch = global.fetch;
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub",NAME="English",LANGUAGE="en",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="dub"',
    "video.m3u8"
  ].join("\n");
  const media = (name) =>
    [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:1",
      "#EXTINF:6,",
      `${name}1.ts`,
      "#EXTINF:6,",
      `${name}2.ts`,
      "#EXT-X-ENDLIST"
    ].join("\n");
  const sectionPacket = (pid, section) => {
    const packet = new Uint8Array(188).fill(0xff);
    packet.set([0x47, 0x40 | ((pid >> 8) & 0x1f), pid & 0xff, 0x10, 0x00]);
    packet.set(section, 5);
    return packet;
  };
  const buildTs = (audio) => {
    const pmtPid = audio ? 200 : 100;
    const streamPid = 256;
    const streamType = audio ? 0x0f : 0x1b;
    const pat = sectionPacket(0, [
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0x00, 0x01, 0xe0 | ((pmtPid >> 8) & 0x1f), pmtPid & 0xff,
      0, 0, 0, 0
    ]);
    const pmt = sectionPacket(pmtPid, [
      0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe0 | ((streamPid >> 8) & 0x1f), streamPid & 0xff,
      0xf0, 0x00,
      streamType, 0xe0 | ((streamPid >> 8) & 0x1f), streamPid & 0xff,
      0xf0, 0x00, 0, 0, 0, 0
    ]);
    const data = new Uint8Array(188 * 402);
    data.set(pat, 0);
    data.set(pmt, 188);
    for (let index = 2; index < 402; index += 1) {
      const offset = index * 188;
      data.set(
        [0x47, (streamPid >> 8) & 0x1f, streamPid & 0xff, 0x10],
        offset
      );
      data.fill(audio ? 0xaa : 0x55, offset + 4, offset + 188);
    }
    return data;
  };
  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("master.m3u8")) return new Response(master);
    if (value.endsWith("video.m3u8")) return new Response(media("video"));
    if (value.endsWith("audio.m3u8")) return new Response(media("audio"));
    return new Response(buildTs(value.includes("audio")));
  };
  try {
    const parsed = HLS.parsePlaylist(master, "https://mux.test/master.m3u8");
    const result = await HLS.downloadAndMerge(
      "https://mux.test/master.m3u8",
      {
        audioTrackId: parsed.audioRenditions[0].id,
        allowPartial: false,
        speedProfile: "safe"
      }
    );
    assert.equal(result.audioTrackId, parsed.audioRenditions[0].id);
    assert.equal(result.segmentCount, 2);
    assert.equal(result.blob.size, 188 * 802 * 2);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testFinalSavePublishesNativeCheckpoint() {
  let listener;
  let startedId = null;
  const createdUrls = [];
  const pipeline = SavePipeline.createPipeline({
    chrome: {
      runtime: {
        getURL: (value) => `chrome-extension://unit/${value}`,
        onMessage: {
          addListener(value) {
            listener = value;
          },
          removeListener() {}
        }
      },
      tabs: {
        create: async ({ url }) => {
          createdUrls.push(url);
          return { id: 9 };
        },
        remove: async () => {}
      }
    },
    indexedDB: null,
    IDBKeyRange: null,
    safeDownloadName: String,
    relDownloadPath: async (value) => `Chosen/Subfolder/${value}`,
    startKeepAlive: () => true,
    stopKeepAlive: () => {}
  });
  const saving = pipeline.downloadPartsViaTab(
    "hls_save",
    "Episode.mp4",
    240_000,
    { onDownloadStarted: (id) => { startedId = id; } }
  );
  // The tab is created after the (async) relative path lookup; wait for the
  // message listener instead of counting microtasks.
  for (let i = 0; i < 50 && typeof listener !== "function"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof listener, "function");
  listener(
    { type: "SAVE_PAGE_STARTED", key: "hls_save", downloadId: 55 },
    { tab: { id: 9 } },
    () => {}
  );
  assert.equal(startedId, 55);
  listener(
    {
      type: "SAVE_PAGE_DONE",
      key: "hls_save",
      ok: true,
      downloadId: 55,
      filename: "Episode.mp4"
    },
    { tab: { id: 9 } },
    () => {}
  );
  const saved = await saving;
  assert.equal(saved.downloadId, 55);
  // The save page receives the same settings-derived relative path as the
  // service-worker save path, so streamed HLS saves honour the subfolder and
  // keep the locked name instead of re-sanitizing it.
  const saveUrl = new URL(createdUrls[0]);
  assert.equal(saveUrl.searchParams.get("path"), "Chosen/Subfolder/Episode.mp4");
  assert.equal(saveUrl.searchParams.get("name"), "Episode.mp4");
  const saveSource = fs.readFileSync(path.join(__dirname, "../src/save.js"), "utf8");
  assert.equal(saveSource.includes("sanitizeName("), false, "save page no longer re-sanitizes");
  assert.match(saveSource, /params\.get\("path"\)/);
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
    sourceUrl: "https://media.test/seg1.ts",
    sourceId: ""
  });
  assert.equal(checkpointBase.startsWith("hls_job-hls"), true);
  assert.equal(result.downloadId, 10);
  assert.equal(job.resumeState, undefined);
}

async function testNativeDirectPauseResume() {
  const paused = [];
  const resumed = [];
  const durableWrites = [];
  let restarted = 0;
  const chrome = {
    runtime: {
      sendMessage: async () => {},
      getURL: (path) => `chrome-extension://unit/${path}`
    },
    storage: {
      session: { set: async () => {}, get: async () => ({}) },
      local: {
        set: async (value) => durableWrites.push(value),
        get: async () => ({
          uvdPausedDownloads: [
            {
              id: "restored-hls",
              status: "paused",
              phase: "paused",
              pageUrl: "https://example.test/watch",
              mediaUrl: "https://media.test/playlist.m3u8",
              filename: "Restored.mp4",
              progressVersion: 1,
              progressAttempt: 2,
              progressSeq: 10,
              resumeState: {
                kind: "hls",
                url: "https://media.test/playlist.m3u8",
                quality: "720p",
                partBase: "hls_restored-hls",
                parts: {
                  1: {
                    size: 120_000,
                    sourceUrl: "https://media.test/seg1.ts"
                  }
                }
              }
            },
            {
              id: "restored-direct",
              status: "paused",
              phase: "paused",
              title: "Restored direct",
              pageUrl: "https://example.test/video.mp4",
              mediaUrl: "https://cdn.test/video.mp4",
              filename: "Restored direct.mp4",
              progressVersion: 1,
              progressAttempt: 1,
              progressSeq: 3,
              resumeState: {
                kind: "direct",
                downloadId: 88,
                url: "https://cdn.test/video.mp4",
                bytesReceived: 1_000_000,
                totalBytes: 2_000_000
              }
            }
          ]
        })
      }
    },
    tabs: { sendMessage: async () => {} },
    downloads: {
      pause: async (id) => paused.push(id),
      resume: async (id) => resumed.push(id),
      cancel: async () => {},
      search: async ({ id }) =>
        id === 88
          ? [{ id, state: "interrupted", canResume: true, paused: true }]
          : [],
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
    waitForChromeDownload: async () => ({
      state: "complete",
      path: "/Downloads/Restored direct.mp4",
      bytesReceived: 2_000_000
    }),
    setTimeout: () => 1
  });
  await manager.ready;
  assert.equal(manager.activeDownloads.get("restored-hls").status, "paused");
  assert.equal(
    manager.activeDownloads.get("restored-hls").resumeState.parts[1].size,
    120_000
  );
  const restoredResume = await manager.resumeDownloadJob("restored-direct");
  assert.equal(restoredResume.resumeKind, "http-range");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.activeDownloads.get("restored-direct").status, "done");
  assert.deepEqual(resumed, [88]);
  assert.equal(
    durableWrites.at(-1).uvdPausedDownloads.some(
      (job) => job.id === "restored-direct"
    ),
    false
  );
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
  assert.equal(
    durableWrites.at(-1).uvdPausedDownloads.some(
      (saved) =>
        saved.id === jobId &&
        saved.resumeState?.downloadId === 42 &&
        saved.resumeState?.bytesReceived === 5_000_000
    ),
    true
  );

  const resumeResult = await manager.resumeDownloadJob(jobId);
  assert.deepEqual(resumed, [88, 42]);
  assert.equal(resumeResult.resumeKind, "http-range");
  assert.equal(job.status, "running");
  assert.equal(job.message, "이어받는 중…");
  assert.equal(restarted, 0, "native direct resume does not restart orchestration");
  assert.equal(
    durableWrites.at(-1).uvdPausedDownloads.some(
      (saved) => saved.id === jobId
    ),
    false
  );
}

async function testPartialDownloadsAreExplicit() {
  // Engine: a segment that keeps 403ing is skipped under allowPartial, and
  // the result says so instead of looking like a clean merge.
  const originalFetch = global.fetch;
  const playlist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    ...Array.from({ length: 6 }, (_, i) => [`#EXTINF:10,`, `seg${i}.ts`]).flat(),
    "#EXT-X-ENDLIST"
  ].join("\n");
  const segment = new Uint8Array(120_000);
  segment[0] = 0x47;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("playlist.m3u8")) return new Response(playlist, { status: 200 });
    if (value.endsWith("seg3.ts")) return new Response("", { status: 403 });
    return new Response(segment.slice(), { status: 200 });
  };
  const originalTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => originalTimeout(fn, 0, ...args);
  let engineResult;
  try {
    engineResult = await HLS.downloadAndMerge("https://media.test/playlist.m3u8", {
      allowPartial: true,
      speedProfile: "safe"
    });
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
  }
  assert.equal(engineResult.partial, true);
  assert.equal(engineResult.skippedSegments, 1);
  assert.equal(engineResult.expectedSegments, 6);
  assert.equal(engineResult.segmentCount, 5);

  // Runner: the saved name and the returned result carry the gap.
  const job = { id: "job-partial", status: "running" };
  const runner = HlsRuntime.createRunner({
    HLS: {
      downloadAndMerge: async () => ({
        streamed: false,
        blob: { size: 500_000 },
        size: 500_000,
        quality: "720p",
        segmentCount: 7,
        expectedSegments: 10,
        skippedSegments: 3,
        partial: true
      })
    },
    UVD: { getSettings: async () => ({}), isGenericSaveName: () => false },
    Naming: { buildFilename: () => "Episode.mp4" },
    activeDownloads: new Map([[job.id, job]]),
    getCurrentJobContext: () => job.id,
    jobAbortControllers: new Map(),
    hlsProgress: new Map(),
    resolvePageUrl: async () => "https://example.test/watch",
    lockSaveName: () => "Episode.mp4",
    applyQualityToLockedName: (name) => name,
    safeDownloadName: (name) => name,
    hlsPhasePercent: () => 5,
    estimateSavePercent: () => 90,
    emitDownloadProgress: () => {},
    broadcastJob: () => {},
    throwIfJobStopped: () => {},
    openBlobDb: async () => {
      throw new Error("no idb");
    },
    idbPutPart: async () => {},
    idbPartKey: () => "",
    idbListParts: async () => [],
    idbDeleteParts: async () => {},
    downloadPartsViaTab: async () => {
      throw new Error("unexpected");
    },
    downloadBlob: async (_blob, name) => ({
      downloadId: 12,
      filename: name,
      path: `/Downloads/${name}`,
      state: "complete"
    })
  });
  const saved = await runner.runHlsDownload(
    7,
    "https://media.test/playlist.m3u8",
    "720p",
    "Episode.mp4",
    {},
    "https://example.test/watch",
    job.id
  );
  assert.equal(saved.partial, true);
  assert.equal(saved.filename, "Episode (일부 누락).mp4");
  assert.equal(saved.skippedSegments, 3);

  // Job manager: queue row, history and notification all say "일부 누락".
  const history = [];
  const notifications = [];
  const manager = createManager({
    chrome: {
      runtime: { sendMessage: async () => {}, getURL: (p) => p },
      storage: {
        session: { set: async () => {}, get: async () => ({}) },
        local: { set: async () => {}, get: async () => ({}) }
      },
      tabs: { sendMessage: async () => {} },
      downloads: { search: async () => [] },
      notifications: {
        onClicked: { addListener() {} },
        create: async (_id, options) => notifications.push(options),
        clear: async () => {}
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} }
    },
    UVD: {
      classifyError: () => ({}),
      formatSpeed: () => "",
      isGenericSaveName: () => false,
      getSettings: async () => ({ showBadge: false }),
      appendHistory: async (entry) => history.push(entry),
      siteFromUrl: () => "example"
    },
    UVDProgress,
    Naming: { cleanPageTitle: (value) => value },
    YtDlp: { cancelJob: async () => {} },
    parseSpeedFromMessage: () => 0,
    getTabMeta: () => ({}),
    saveCompanionThumbnail: async () => {},
    downloadPageFromUi: async () => {},
    startKeepAlive: () => true,
    stopKeepAlive: () => {},
    setTimeout: () => 1
  });
  await manager.ready;
  const jobId = manager.createDownloadJob({
    tabId: 7,
    title: "Episode",
    pageUrl: "https://example.test/watch"
  });
  manager.finishDownloadJob(jobId, saved, null);
  await new Promise((resolve) => setImmediate(resolve));
  const finished = manager.publicJob(manager.activeDownloads.get(jobId));
  assert.equal(finished.status, "done");
  assert.equal(finished.partial, true);
  assert.match(finished.message, /일부 누락 저장 \(3\/10 빠짐\)/);
  assert.equal(history[0].partial, true);
  assert.equal(history[0].skippedSegments, 3);
  assert.equal(history[0].expectedSegments, 10);
  assert.equal(notifications[0].title, "일부 누락 저장");
  assert.match(notifications[0].message, /3\/10/);

  const QueueUi = require("../src/popup-queue-ui.js");
  const queue = QueueUi.createPresenter({ siteLabel: () => "", now: Date.now });
  assert.equal(queue.jobPhaseLabel(finished), "일부 누락");
  assert.equal(
    queue.cleanJobMessage(finished.message, "done"),
    finished.message,
    "final outcome text is not rewritten by the segment-word filter"
  );
}

async function testInterruptedRunningJobsAreRestored() {
  const durableWrites = [];
  const history = [];
  const notifications = [];
  const chrome = {
    runtime: { sendMessage: async () => {}, getURL: (p) => p },
    storage: {
      session: {
        set: async () => {},
        get: async () => ({
          uvdActiveDownloads: [
            {
              id: "run-hls",
              status: "running",
              phase: "segments",
              percent: 40,
              title: "Episode 3",
              pageUrl: "https://example.test/watch/3",
              mediaUrl: "https://media.test/playlist.m3u8",
              filename: "Episode 3.mp4",
              progressVersion: 1,
              progressAttempt: 1,
              progressSeq: 20,
              resumeState: {
                kind: "hls",
                url: "https://media.test/playlist.m3u8",
                quality: "best",
                partBase: "hls_run-hls",
                parts: { 1: { size: 120_000, sourceUrl: "https://media.test/seg1.ts" } }
              }
            },
            {
              id: "run-direct-done",
              status: "running",
              title: "Finished while worker was dead",
              pageUrl: "https://example.test/video.mp4",
              filename: "Finished.mp4",
              resumeState: { kind: "direct", downloadId: 501, url: "https://cdn.test/v.mp4" }
            },
            {
              id: "run-helper",
              status: "running",
              title: "Helper job",
              pageUrl: "",
              filename: "Helper.mp4",
              helperJobId: "h-1"
            },
            { id: "already-done", status: "done", title: "Done" }
          ]
        })
      },
      local: {
        set: async (value) => durableWrites.push(value),
        get: async () => ({})
      }
    },
    tabs: { sendMessage: async () => {} },
    downloads: {
      search: async ({ id }) =>
        id === 501
          ? [{ id, state: "complete", filename: "/Downloads/Finished.mp4", fileSize: 3_000_000 }]
          : [],
      show() {},
      showDefaultFolder() {}
    },
    notifications: {
      onClicked: { addListener() {} },
      create: async (_id, options) => notifications.push(options.title),
      clear: async () => {}
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} }
  };
  const manager = createManager({
    chrome,
    UVD: {
      classifyError: () => ({ code: "other" }),
      formatSpeed: () => "",
      isGenericSaveName: () => false,
      getSettings: async () => ({ showBadge: false }),
      appendHistory: async (entry) => history.push(entry),
      siteFromUrl: () => "example"
    },
    UVDProgress,
    Naming: { cleanPageTitle: (value) => value },
    YtDlp: { cancelJob: async () => {} },
    parseSpeedFromMessage: () => 0,
    getTabMeta: () => ({}),
    saveCompanionThumbnail: async () => {},
    downloadPageFromUi: async () => {},
    startKeepAlive: () => true,
    stopKeepAlive: () => {},
    setTimeout: () => 1
  });
  await manager.ready;

  const hls = manager.activeDownloads.get("run-hls");
  assert.equal(hls.status, "paused", "interrupted HLS job becomes resumable");
  assert.equal(hls.message, "중단됨 · 이어받기 가능");
  assert.equal(hls.resumeState.partBase, "hls_run-hls", "IDB checkpoint is kept");
  assert.equal(hls.percent, 40, "progress is preserved for the resume attempt");

  const done = manager.activeDownloads.get("run-direct-done");
  assert.equal(done.status, "done");
  assert.equal(done.result.path, "/Downloads/Finished.mp4");

  const helper = manager.activeDownloads.get("run-helper");
  assert.equal(helper.status, "error", "job with nothing to resume is a visible failure");
  assert.match(helper.error, /재시작/);
  assert.equal(manager.activeDownloads.has("already-done"), false);

  assert.deepEqual(
    history.map((entry) => [entry.id, entry.status]).sort(),
    [["h_run-direct-done", "done"], ["h_run-helper", "error"]]
  );
  const last = durableWrites.at(-1);
  assert.deepEqual(
    last.uvdPausedDownloads.map((job) => job.id),
    ["run-hls"],
    "restored resumable job is now durable as paused"
  );
  assert.deepEqual(last.uvdRunningDownloads, []);

  // Running jobs are mirrored to durable storage (debounced) so a later crash
  // can restore them; a fake timer proves the write goes through schedule().
  const timers = [];
  const manager2 = createManager({
    chrome: {
      ...chrome,
      storage: {
        session: { set: async () => {}, get: async () => ({}) },
        local: { set: async (value) => durableWrites.push(value), get: async () => ({}) }
      }
    },
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
    downloadPageFromUi: async () => {},
    startKeepAlive: () => true,
    stopKeepAlive: () => {},
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    }
  });
  await manager2.ready;
  const jobId = manager2.createDownloadJob({
    tabId: 1,
    title: "Live",
    pageUrl: "https://example.test/live",
    mediaUrl: "https://media.test/live.m3u8"
  });
  manager2.activeDownloads.get(jobId).resumeState = {
    kind: "hls",
    url: "https://media.test/live.m3u8",
    partBase: `hls_${jobId}`,
    parts: {}
  };
  manager2.updateDownloadJob(jobId, { percent: 12, message: "받는 중…" });
  const debounced = timers.filter((t) => t.ms === 1500);
  assert.equal(debounced.length, 1, "one trailing debounce per burst of progress");
  const before = durableWrites.length;
  debounced[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = durableWrites.slice(before).at(-1);
  assert.equal(snapshot.uvdRunningDownloads.length, 1);
  assert.equal(snapshot.uvdRunningDownloads[0].resumeState.partBase, `hls_${jobId}`);
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

async function testByteRangeSegmentsFetchSubRanges() {
  const originalFetch = global.fetch;
  // One 300KB resource split into init (0..999) + 3 media sub-ranges.
  const resource = new Uint8Array(300_000);
  for (let i = 0; i < resource.length; i++) resource[i] = (i * 13) & 0xff;
  const playlist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    '#EXT-X-MAP:URI="movie.mp4",BYTERANGE="1000@0"',
    "#EXTINF:10,",
    "#EXT-X-BYTERANGE:100000@1000",
    "movie.mp4",
    "#EXTINF:10,",
    "#EXT-X-BYTERANGE:100000",
    "movie.mp4",
    "#EXTINF:10,",
    "#EXT-X-BYTERANGE:99000@201000",
    "movie.mp4",
    "#EXT-X-ENDLIST"
  ].join("\n");

  const parsed = HLS.parsePlaylist(playlist, "https://media.test/movie.m3u8");
  assert.deepEqual(parsed.mapByteRange, { offset: 0, length: 1000 });
  assert.deepEqual(
    parsed.segments.map((segment) => segment.byteRange),
    [
      { offset: 1000, length: 100_000 },
      { offset: 101_000, length: 100_000 },
      { offset: 201_000, length: 99_000 }
    ],
    "BYTERANGE without @offset continues after the previous sub-range"
  );
  assert.equal(
    HLS.segmentIdentity(parsed.segments[1]),
    "1:https://media.test/movie.mp4@101000+100000",
    "resume identity distinguishes sub-ranges of one URL"
  );

  const runAgainst = async (honorRange) => {
    const ranges = [];
    global.fetch = async (url, init) => {
      const value = String(url);
      if (value.endsWith("movie.m3u8")) {
        return new Response(playlist, { status: 200 });
      }
      const range = init?.headers?.Range || init?.headers?.range || "";
      ranges.push(range);
      const m = range.match(/^bytes=(\d+)-(\d+)$/);
      if (!honorRange || !m) {
        return new Response(resource.slice(), { status: 200 });
      }
      const start = Number(m[1]);
      const end = Number(m[2]);
      return new Response(resource.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${resource.length}` }
      });
    };
    const parts = [];
    const result = await HLS.downloadAndMerge("https://media.test/movie.m3u8", {
      onSegmentData: async (index, data, metadata) => {
        parts.push({ index, data, metadata });
      },
      allowPartial: false,
      speedProfile: "safe"
    });
    return { ranges, parts, result };
  };

  try {
    for (const honorRange of [true, false]) {
      const { ranges, parts, result } = await runAgainst(honorRange);
      assert.deepEqual(
        [...new Set(ranges)].sort(),
        [
          "bytes=0-999",
          "bytes=1000-100999",
          "bytes=101000-200999",
          "bytes=201000-299999"
        ],
        `every fetch carries its sub-range (server honors Range: ${honorRange})`
      );
      parts.sort((a, b) => a.index - b.index);
      assert.deepEqual(
        parts.map((part) => part.data.byteLength),
        [1000, 100_000, 100_000, 99_000]
      );
      const merged = new Uint8Array(resource.length);
      let offset = 0;
      for (const part of parts) {
        merged.set(part.data, offset);
        offset += part.data.byteLength;
      }
      assert.deepEqual(
        merged,
        resource,
        `output is the resource exactly once, not once per segment (honor=${honorRange})`
      );
      assert.equal(result.size, resource.length);
      assert.equal(
        parts[0].metadata.sourceId,
        "init:https://media.test/movie.mp4@0+1000"
      );
    }

    // A URL-only legacy checkpoint must not be reused for a byte-range
    // segment: it cannot tell which sub-range the stored bytes came from.
    const fetched = [];
    global.fetch = async (url, init) => {
      const value = String(url);
      if (value.endsWith("movie.m3u8")) {
        return new Response(playlist, { status: 200 });
      }
      fetched.push(init?.headers?.Range || "");
      const m = String(init?.headers?.Range || "").match(/^bytes=(\d+)-(\d+)$/);
      return new Response(resource.slice(Number(m[1]), Number(m[2]) + 1), {
        status: 206
      });
    };
    await HLS.downloadAndMerge("https://media.test/movie.m3u8", {
      resumeParts: new Map([
        [2, { size: 100_000, sourceUrl: "https://media.test/movie.mp4" }]
      ]),
      onSegmentData: async () => {},
      allowPartial: false,
      speedProfile: "safe"
    });
    assert.equal(
      fetched.includes("bytes=101000-200999"),
      true,
      "ambiguous URL-only checkpoint is refetched"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testStartChromeDownloadKeepsDottedTitles() {
  const requested = [];
  const pipeline = SavePipeline.createPipeline({
    chrome: {
      runtime: {},
      downloads: {
        download: (options, callback) => {
          requested.push(options.filename);
          callback(requested.length);
        }
      }
    },
    safeDownloadName: (value) => value,
    relDownloadPath: async (value) => `VideoDownloader/${value}`
  });
  await pipeline.startChromeDownload("blob:x", "VideoDownloader/Wait.. what.mp4");
  await pipeline.startChromeDownload("blob:x", "VideoDownloader/../escape.mp4");
  await pipeline.startChromeDownload("blob:x", "/etc/passwd.mp4");
  assert.equal(
    requested[0],
    "VideoDownloader/Wait.. what.mp4",
    "'..' inside a title keeps its name and folder"
  );
  assert.equal(
    requested[1],
    "VideoDownloader/escape.mp4",
    "a '..' path segment is dropped, not the whole name"
  );
  assert.match(requested[2], /^영상_\d+\.mp4$/, "absolute paths fall back to a safe name");
}

async function testPausedFinalSaveIsNotTornDown() {
  // waitDownloadComplete: a paused Chrome download re-arms the deadline
  // instead of resolving "partial" / rejecting and letting callers revoke
  // the blob or delete the parts it still reads from.
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  const realClearTimeout = global.clearTimeout;
  const realClearInterval = global.clearInterval;
  let state = { state: "in_progress", paused: true, bytesReceived: 10 };
  global.setTimeout = (fn, ms) => {
    const id = timers.push({ fn, ms, cleared: false });
    return id;
  };
  global.clearTimeout = (id) => {
    if (timers[id - 1]) timers[id - 1].cleared = true;
  };
  global.setInterval = () => 999;
  global.clearInterval = () => {};
  try {
    const pipeline = SavePipeline.createPipeline({
      chrome: {
        runtime: {},
        downloads: {
          search: async () => [{ id: 5, ...state }],
          onChanged: { addListener() {}, removeListener() {} }
        }
      },
      safeDownloadName: String,
      relDownloadPath: async (v) => v
    });
    const waiting = pipeline.waitDownloadComplete(5, 1000);
    const first = timers.find((t) => t.ms === 1000 && !t.cleared);
    assert.ok(first, "deadline armed");
    await first.fn();
    const rearmed = timers.filter((t) => t.ms === 1000 && !t.cleared);
    assert.equal(rearmed.length, 1, "paused download re-arms the deadline");
    assert.notEqual(rearmed[0], first);
    state = { state: "complete", filename: "/Downloads/x.mp4", bytesReceived: 99 };
    await rearmed[0].fn();
    const done = await waiting;
    assert.equal(done.state, "complete");
  } finally {
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
    global.clearTimeout = realClearTimeout;
    global.clearInterval = realClearInterval;
  }

  // downloadMedia keeps the native checkpoint when the wait ends while the
  // download is still in progress (long pause), so resume can use
  // chrome.downloads.resume instead of restarting from zero.
  const job = { id: "job-long-pause", tabId: 3 };
  const transport = DirectMedia.createTransport({
    activeDownloads: new Map([[job.id, job]]),
    safeDownloadName: (v) => v,
    filenameFromUrl: () => "Direct.mp4",
    relDownloadPath: async (v) => v,
    startChromeDownload: async () => 61,
    waitDownloadComplete: async () => ({ state: "in_progress", partial: true, bytesReceived: 1 }),
    emitDownloadProgress: () => {}
  });
  await transport.downloadMedia("https://cdn.test/v.mp4", "Direct.mp4", job.id);
  assert.equal(job.resumeState?.downloadId, 61, "checkpoint survives a partial wait");

  const saveSource = fs.readFileSync(path.join(__dirname, "../src/save.js"), "utf8");
  assert.match(saveSource, /item\.paused\)\s*\{\s*\n\s*\/\/ User paused/);
}

async function testManifestsRouteByMime() {
  // A DASH manifest detected only by Content-Type must go to the helper, and
  // a token-less HLS manifest must go to the HLS path — never to a direct
  // chrome.downloads save that would write XML/text as "<title>.mp4".
  const routes = [];
  const Routing = require("../src/download-routing.js");
  const router = require("../src/background-smart-download.js").createRouter({
    UVD: { isGenericSaveName: () => false, getSitePackForUrl: async () => null },
    YtDlp: { available: async () => false },
    UVDDownloadRouting: Routing,
    activeDownloads: new Map(),
    getCurrentJobContext: () => null,
    resolvePageUrl: async () => "https://site.test/watch",
    emitDownloadProgress: () => {},
    isRealDash: require("../src/download-engine.js").isRealDash,
    isRealHls: require("../src/download-engine.js").isRealHls,
    bestNonBlobAlternative: () => null,
    withTimeout: (p) => p,
    withTabReferer: (_t, op, pageUrl) => op(pageUrl),
    friendlyFetchError: (e) => String(e?.message || e),
    downloadDashViaHelper: async () => {
      routes.push("dash");
      return { ok: true, downloadId: null, size: 1 };
    },
    runHlsDownload: async () => {
      routes.push("hls");
      return { ok: true, downloadId: 1, size: 500_000 };
    },
    pageDownloadAllFrames: async () => ({ ok: false, error: "no" }),
    downloadMedia: async () => {
      routes.push("direct");
      return { downloadId: 2, size: 1 };
    },
    probeContentLength: async () => 0,
    downloadDirectViaHelper: async () => ({})
  });
  await router.downloadSmart(1, "https://site.test/api/manifest?id=9", "a.mp4", "best", "stream", {
    mime: "application/dash+xml",
    isDash: true
  });
  await router.downloadSmart(1, "https://site.test/api/manifest?id=10", "b.mp4", "best", "stream", {
    mime: "application/vnd.apple.mpegurl",
    isHls: true
  });
  assert.deepEqual(routes, ["dash", "hls"]);

  // Direct path refuses manifests / HTML by Content-Type.
  const transport = DirectMedia.createTransport({
    fetch: async () => ({ headers: { get: () => "application/dash+xml" } }),
    activeDownloads: new Map(),
    safeDownloadName: (v) => v,
    filenameFromUrl: () => "x.mp4",
    relDownloadPath: async (v) => v,
    startChromeDownload: async () => {
      throw new Error("must not start");
    },
    waitDownloadComplete: async () => ({}),
    emitDownloadProgress: () => {}
  });
  await assert.rejects(
    () => transport.downloadMedia("https://site.test/api/manifest?id=9", "x.mp4"),
    /조각을 합쳐야/
  );

  // Media-state: DASH items are never flagged as HLS.
  const MediaState = require("../src/background-media-state.js");
  const store = MediaState.createStore({
    chrome: {
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
      runtime: { sendMessage: async () => {} },
      tabs: { sendMessage: async () => {}, get: async () => ({ id: 4, url: "https://site.test/watch" }) }
    },
    Naming: require("../src/naming.js"),
    HLS: require("../src/hls-downloader.js"),
    hostOf: () => "site.test",
    isYoutubeUrl: () => false,
    isTiktokUrl: () => false,
    isInstagramPostUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    needsYtDlpHelper: () => false,
    siteKind: () => "",
    siteDefaultTitle: () => "",
    isLikelyMedia: () => true,
    classifyMedia: () => ({ type: "stream" }),
    qualityLabel: () => "",
    hashUrl: (v) => v,
    titlesMatchVideo: () => true,
    withTabReferer: async (_t, op) => op(),
    detachJobsFromTab: () => {},
    console
  });
  store.addMedia(4, {
    url: "https://site.test/api/manifest?id=9",
    type: "stream",
    mime: "application/dash+xml",
    source: "network"
  });
  const [dashItem] = store.getTabItems(4);
  assert.equal(dashItem.isDash, true);
  assert.equal(dashItem.isHls, false);
}

async function testRefererRuleOnlyTargetsExtensionRequests() {
  const calls = [];
  const transport = DirectMedia.createTransport({
    chrome: {
      tabs: {
        TAB_ID_NONE: -1,
        get: async () => ({ url: "https://site.test/watch/1" })
      },
      declarativeNetRequest: {
        updateSessionRules: async (options) => {
          calls.push(options);
        }
      }
    }
  });
  const seenPage = await transport.withTabReferer(
    12,
    async (pageUrl) => pageUrl
  );
  assert.equal(seenPage, "https://site.test/watch/1");
  assert.equal(calls.length, 2, "rule is installed and then removed");
  const rule = calls[0].addRules[0];
  assert.deepEqual(rule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://site.test/watch/1" }
  ]);
  assert.deepEqual(
    rule.condition.tabIds,
    [-1],
    "Referer override must not apply to requests made by web pages in tabs"
  );
  assert.deepEqual(calls[1], { removeRuleIds: [rule.id] });
}

async function main() {
  await testHlsSkipsCheckpointedSegments();
  await testLiveHlsRequiresSequenceIdentity();
  await testBrowserHlsAlternateAudio();
  await testFinalSavePublishesNativeCheckpoint();
  await testHlsRuntimePreservesPauseCheckpoint();
  await testPartialDownloadsAreExplicit();
  await testInterruptedRunningJobsAreRestored();
  await testDirectTransportRegistersCheckpoint();
  await testByteRangeSegmentsFetchSubRanges();
  await testStartChromeDownloadKeepsDottedTitles();
  await testPausedFinalSaveIsNotTornDown();
  await testManifestsRouteByMime();
  await testRefererRuleOnlyTargetsExtensionRequests();
  await testNativeDirectPauseResume();
  const helperSource = fs.readFileSync(
    path.join(__dirname, "../helper/yt_dlp_server.py"),
    "utf8"
  );
  assert.equal(helperSource.includes('"--continue"'), true);
  assert.equal(helperSource.includes('"--part"'), true);
  assert.equal(helperSource.includes("aria2c:--continue=true"), true);
  assert.equal(helperSource.includes("aria2c:-c true"), false);
  console.log("resume contract: HLS checkpoints, helper continuation, and direct Range passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
