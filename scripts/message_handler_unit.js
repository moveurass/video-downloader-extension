"use strict";

const assert = require("node:assert/strict");
const { createHandler } = require("../src/download-message-handler.js");
const { createRouter } = require("../src/background-message-router.js");
const { createHandler: createBackgroundDownloadHandler } =
  require("../src/background-download-messages.js");
const { createHandler: createDirectDownloadHandler } =
  require("../src/background-direct-download-messages.js");
const { createClient: createSeriesNetworkClient } =
  require("../src/popup-series-network.js");
const { createHandler: createSeriesMessageHandler } =
  require("../src/background-series-messages.js");
const { createHandler: createMediaMessageHandler } =
  require("../src/background-media-messages.js");
const { createHandler: createHelperMessageHandler } =
  require("../src/background-helper-messages.js");
const { createHandler: createChunkAssemblyHandler } =
  require("../src/background-chunk-assembly.js");
const { createScheduler } = require("../src/background-scheduled-jobs.js");

async function main() {
  const calls = [];
  const jobs = [{ id: "job-1", status: "running", percent: 20 }];
  const handler = createHandler({
    cancel: async (id) => {
      calls.push(["cancel", id]);
      return { ok: true, status: "cancelled" };
    },
    pause: async (id) => {
      calls.push(["pause", id]);
      return { ok: true, status: "paused" };
    },
    resume: async (id) => {
      calls.push(["resume", id]);
      return { ok: true, status: "running" };
    },
    list: () => jobs,
    progress: (tabId) => ({ tabId, percent: 20 })
  });

  let response;
  assert.deepEqual(
    handler({ type: "GET_ACTIVE_DOWNLOADS" }, (value) => {
      response = value;
    }),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response.jobs, jobs);

  response = null;
  handler({ type: "GET_DOWNLOAD_PROGRESS", tabId: 7 }, (value) => {
    response = value;
  });
  assert.equal(response.job.id, "job-1");
  assert.equal(response.progress.tabId, 7);

  response = null;
  const routed = handler({ type: "PAUSE_DOWNLOAD", jobId: "job-1" }, (value) => {
    response = value;
  });
  assert.deepEqual(routed, { handled: true, keepChannel: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["pause", "job-1"]]);
  assert.equal(response.status, "paused");

  assert.deepEqual(handler({ type: "OTHER" }, () => {}), {
    handled: false,
    keepChannel: false
  });

  const opened = [];
  const cleared = [];
  const router = createRouter({
    UVD: {
      getHistory: async () => [{ id: "history-1" }]
    },
    alarms: {
      clear: async () => true,
      getAll: async () => [],
      create: async () => {}
    },
    tabs: {
      create: async ({ url }) => opened.push(url)
    },
    updateDownloadBadge: async () => {},
    clearMedia: (tabId) => cleared.push(tabId),
    version: "test"
  });

  response = null;
  assert.deepEqual(router({ type: "GET_HISTORY" }, (value) => {
    response = value;
  }), { handled: true, keepChannel: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.history[0].id, "history-1");

  assert.deepEqual(router({ type: "OPEN_URL", url: "https://example.com" }, (value) => {
    response = value;
  }), { handled: true, keepChannel: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["https://example.com"]);

  router({ type: "CLEAR_MEDIA", tabId: 7 }, () => {});
  assert.deepEqual(cleared, [7]);
  assert.deepEqual(router({ type: "OTHER" }, () => {}), {
    handled: false,
    keepChannel: false
  });

  let alarmListener;
  let scheduledItems = [{
    id: "watch-1",
    title: "예약 제목",
    pageUrl: "https://example.com/scheduled",
    mediaUrl: "https://cdn.example.com/scheduled.m3u8",
    quality: "720p"
  }];
  let watchlistReads = 0;
  const alarmCreates = [];
  const alarmClears = [];
  const removedWatchItems = [];
  const keepAliveCalls = [];
  const pageDownloadCalls = [];
  let scheduledMeta;
  const scheduler = createScheduler({
    chrome: {
      alarms: {
        create: (...args) => alarmCreates.push(args),
        clear: async (name) => alarmClears.push(name),
        onAlarm: {
          addListener: (listener) => { alarmListener = listener; }
        }
      }
    },
    UVD: {
      getWatchlist: async () => {
        watchlistReads += 1;
        return scheduledItems;
      },
      removeWatchlist: async (id) => removedWatchItems.push(id)
    },
    startKeepAlive: () => {
      keepAliveCalls.push("start");
      return "keep-token";
    },
    stopKeepAlive: (token) => keepAliveCalls.push(["stop", token]),
    runTrackedDownloadAsync: async (meta, operation) => {
      scheduledMeta = meta;
      return operation("scheduled-job");
    },
    downloadPageFromUi: async (...args) => {
      pageDownloadCalls.push(args);
      return { ok: true };
    },
    console: { warn: () => {} }
  });
  scheduler.bind();
  assert.deepEqual(alarmCreates, [["keepalive", { periodInMinutes: 4.5 }]]);
  assert.equal(typeof alarmListener, "function");
  alarmListener({ name: "keepalive" });
  alarmListener({ name: "uvd-dl-keepalive" });
  alarmListener({ name: "unrelated" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watchlistReads, 0);

  alarmListener({ name: "uvd-watch-watch-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watchlistReads, 1);
  assert.deepEqual(scheduledMeta, {
    tabId: -1,
    title: "예약 제목",
    pageUrl: "https://example.com/scheduled",
    mediaUrl: "https://cdn.example.com/scheduled.m3u8",
    filename: "",
    quality: "720p"
  });
  assert.deepEqual(pageDownloadCalls, [[
    -1,
    "https://example.com/scheduled",
    "720p",
    "scheduled-job",
    {
      mediaUrl: "https://cdn.example.com/scheduled.m3u8",
      title: "예약 제목"
    }
  ]]);
  assert.deepEqual(keepAliveCalls, ["start", ["stop", "keep-token"]]);
  assert.deepEqual(removedWatchItems, ["watch-1"]);
  assert.deepEqual(alarmClears, ["uvd-watch-watch-1"]);

  scheduledItems = [{ id: "invalid", pageUrl: "file:///tmp/video.mp4" }];
  await scheduler.runScheduledWatchItem("invalid");
  assert.equal(watchlistReads, 2);
  assert.deepEqual(removedWatchItems, ["watch-1", "invalid"]);
  assert.deepEqual(keepAliveCalls, ["start", ["stop", "keep-token"]]);
  assert.deepEqual(alarmClears, ["uvd-watch-watch-1"]);

  let trackedMeta;
  const pageHandler = createBackgroundDownloadHandler({
    UVD: {
      getSettings: async () => ({ mediaMode: "video" }),
      isGenericSaveName: () => false
    },
    Naming: { cleanPageTitle: (title) => title },
    lockSaveName: () => "테스트.mp4",
    runTrackedDownload: (meta, operation, reply) => {
      trackedMeta = meta;
      operation("job-1").then((result) => reply({ ok: true, result }));
    },
    downloadPageFromUi: async () => ({ ok: true, filename: "테스트.mp4" })
  });
  response = null;
  assert.deepEqual(
    pageHandler(
      { type: "DOWNLOAD_PAGE", pageUrl: "https://example.com/video", title: "테스트" },
      3,
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(trackedMeta.title, "테스트");
  assert.equal(response.result.filename, "테스트.mp4");

  const directItem = {
    title: "감지 제목",
    pageTitle: "감지 페이지",
    filename: "감지.mp4",
    quality: "720p",
    type: "stream",
    isSiteDownload: false,
    pageUrl: "https://example.com/detected"
  };
  let directMeta;
  let directOperation;
  let directReply;
  let lockArgs;
  const helperChecks = [];
  const openedPages = [];
  const smartCalls = [];
  const delays = [];
  const removedTabs = [];
  const directHandler = createDirectDownloadHandler({
    Naming: { cleanPageTitle: (title) => `정리:${title}` },
    lockSaveName: (args) => {
      lockArgs = args;
      return "고정 이름.mp4";
    },
    getTabMap: () => new Map([["https://cdn.example.com/master.m3u8", directItem]]),
    isHlsUrl: (url) => url.endsWith(".m3u8"),
    needsYtDlpHelper: (...args) => {
      helperChecks.push(args);
      return true;
    },
    runTrackedDownload: (meta, operation, reply) => {
      directMeta = meta;
      directOperation = operation;
      directReply = reply;
    },
    findOrOpenTabForPage: async (...args) => {
      openedPages.push(args);
      return { tabId: 19, opened: true };
    },
    downloadSmart: async (...args) => {
      smartCalls.push(args);
      return { method: "yt-dlp" };
    },
    chrome: {
      tabs: { remove: async (tabId) => removedTabs.push(tabId) }
    },
    setTimeout: (callback, delay) => {
      delays.push(delay);
      callback();
    }
  });
  assert.deepEqual(directHandler({ type: "OTHER" }, 7, () => {}), {
    handled: false,
    keepChannel: false
  });
  const directResponse = () => {};
  assert.deepEqual(
    directHandler(
      {
        type: "DOWNLOAD_HLS",
        url: "https://cdn.example.com/master.m3u8",
        pageUrl: "https://example.com/watch",
        title: "요청 제목",
        preferQuality: "1080p",
        openPageIfNeeded: true
      },
      7,
      directResponse
    ),
    { handled: true, keepChannel: true }
  );
  assert.deepEqual(lockArgs, {
    filenameHint: "감지.mp4",
    title: "정리:요청 제목",
    pageTitle: "정리:요청 제목",
    quality: "1080p",
    mediaMode: "video",
    pageUrl: "https://example.com/watch",
    mediaUrl: "https://cdn.example.com/master.m3u8"
  });
  assert.deepEqual(directMeta, {
    tabId: 7,
    title: "정리:요청 제목",
    pageUrl: "https://example.com/watch",
    mediaUrl: "https://cdn.example.com/master.m3u8",
    filename: "고정 이름.mp4",
    quality: "1080p",
    audioTrackId: "",
    subtitleLanguages: []
  });
  assert.equal(directReply, directResponse);
  directItem.title = "나중 제목";
  directItem.filename = "나중.mp4";
  const directResult = await directOperation("job-direct");
  assert.deepEqual(helperChecks, [[
    "https://cdn.example.com/master.m3u8",
    "https://example.com/watch"
  ]]);
  assert.deepEqual(openedPages, [["https://example.com/watch", 7]]);
  assert.deepEqual(smartCalls, [[
    19,
    "https://cdn.example.com/master.m3u8",
    "고정 이름.mp4",
    "1080p",
    "stream",
    {
      title: "정리:요청 제목",
      pageTitle: "정리:요청 제목",
      filename: "고정 이름.mp4",
      quality: "1080p",
      type: "stream",
      isSiteDownload: false,
      pageUrl: "https://example.com/watch",
      url: "https://cdn.example.com/master.m3u8",
      isHls: true
    },
    {
      pageUrl: "https://example.com/watch",
      preferYtDlp: true,
      jobId: "job-direct",
      audioTrackId: "",
      subtitleLanguages: []
    }
  ]]);
  assert.deepEqual(delays, [400]);
  assert.deepEqual(removedTabs, [19]);
  assert.deepEqual(directResult, {
    method: "yt-dlp",
    filename: "고정 이름.mp4"
  });

  let invalidOperation;
  const invalidDirectHandler = createDirectDownloadHandler({
    Naming: {},
    lockSaveName: () => "video.mp4",
    getTabMap: () => new Map(),
    isHlsUrl: () => false,
    needsYtDlpHelper: () => false,
    runTrackedDownload: (_meta, operation) => { invalidOperation = operation; },
    findOrOpenTabForPage: async () => ({ tabId: 1, opened: false }),
    downloadSmart: async () => ({}),
    chrome: { tabs: { remove: async () => {} } },
    setTimeout
  });
  invalidDirectHandler(
    { type: "DOWNLOAD", url: "https://cdn.example.com/video.mp4" },
    3,
    () => {}
  );
  await assert.rejects(
    invalidOperation("job-invalid"),
    /파일이 저장되지 않았습니다\. chrome:\/\/downloads 를 확인해 주세요/
  );

  const progress = [];
  const seriesClient = createSeriesNetworkClient({
    sendMessage: async () => ({
      ok: true,
      exists: true,
      finalUrl: "https://example.com/episode-2",
      title: "EP-002",
      thumbnail: ""
    }),
    getTabId: () => 3,
    getHistory: () => [],
    normalizeThumb: (value) => value || "",
    UVD: { historyMatchesEntry: () => false }
  });
  const verified = await seriesClient.validateProductSeriesItems(
    [{ key: "EP-002", url: "https://example.com/episode-2" }],
    { onProgress: (event) => progress.push(event) }
  );
  assert.equal(verified.length, 1);
  assert.equal(verified[0].verified, true);
  assert.equal(progress.at(-1).status, "done");

  const seriesHandler = createSeriesMessageHandler({
    UVD: {},
    YtDlp: {
      available: async () => true,
      listPlaylist: async () => ({
        title: "목록",
        count: 1,
        entries: [{ id: "one", url: "https://example.com/one" }]
      })
    },
    activeDownloads: new Map(),
    maxConcurrent: () => 2,
    getCookieHeader: async () => "",
    collectCookies: async () => []
  });
  response = null;
  assert.deepEqual(
    seriesHandler(
      { type: "LIST_PLAYLIST", pageUrl: "https://example.com/list" },
      3,
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.title, "목록");
  assert.equal(response.entries.length, 1);

  const mediaMeta = [];
  const pageMedia = [];
  const mediaRequests = [];
  const mediaHandler = createMediaMessageHandler({
    setTabMeta: (tabId, meta) => mediaMeta.push([tabId, meta]),
    pageIdentityKey: (url) => `key:${url}`,
    addMedia: (tabId, item) => pageMedia.push([tabId, item]),
    getMediaForTabAsync: async (tabId, hint) => {
      mediaRequests.push([tabId, hint]);
      return [{ title: hint.title, pageUrl: hint.pageUrl }];
    },
    getMediaForTab: () => [],
    needsYtDlpHelper: () => false,
    makeSitePlaceholder: () => null
  });
  response = null;
  assert.deepEqual(
    mediaHandler(
      {
        type: "PAGE_META",
        pageMeta: { title: "페이지 제목" }
      },
      7,
      { tab: { url: "https://example.com/watch/1" } },
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(mediaMeta[0], [
    7,
    {
      title: "페이지 제목",
      lastUrl: "https://example.com/watch/1",
      pageKey: "key:https://example.com/watch/1"
    }
  ]);

  response = null;
  mediaHandler(
    {
      type: "PAGE_META",
      pageMeta: { title: "", host: "javplayer.example" }
    },
    7,
    {
      frameId: 4,
      tab: { url: "https://example.com/watch/1" }
    },
    (value) => { response = value; }
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(
    mediaMeta[1],
    [
      7,
      {
        lastUrl: "https://example.com/watch/1",
        pageKey: "key:https://example.com/watch/1"
      }
    ],
    "subframe metadata must not clear the top-page title"
  );

  response = null;
  assert.deepEqual(
    mediaHandler(
      {
        type: "PAGE_MEDIA",
        pageMeta: { title: "영상 페이지" },
        items: [{ url: "https://cdn.example.com/video.mp4" }]
      },
      7,
      { tab: { url: "https://example.com/watch/2" } },
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(mediaMeta[2], [
    7,
    {
      title: "영상 페이지",
      lastUrl: "https://example.com/watch/2",
      pageKey: "key:https://example.com/watch/2"
    }
  ]);
  assert.deepEqual(pageMedia[0], [
    7,
    {
      url: "https://cdn.example.com/video.mp4",
      source: "page",
      pageUrl: "https://example.com/watch/2"
    }
  ]);

  response = null;
  mediaHandler(
    {
      type: "PAGE_MEDIA",
      pageMeta: { title: "", host: "javplayer.example" },
      items: [{ url: "https://cdn.example.com/frame.m3u8" }]
    },
    7,
    {
      frameId: 9,
      tab: { url: "https://example.com/watch/2" }
    },
    (value) => { response = value; }
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(mediaMeta[3], [
    7,
    {
      lastUrl: "https://example.com/watch/2",
      pageKey: "key:https://example.com/watch/2"
    }
  ]);
  assert.equal(pageMedia[1][1].url, "https://cdn.example.com/frame.m3u8");

  const descriptorUrl = "https://123av.com/ko/v/cawb-035-uncensore";
  response = null;
  assert.deepEqual(
    mediaHandler(
      {
        type: "GET_MEDIA",
        tabId: 7,
        pageUrl: descriptorUrl,
        title: "CAWB-035 실제 영상 제목 - 123AV"
      },
      7,
      {},
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(mediaMeta[4], [
    7,
    {
      lastUrl: descriptorUrl,
      pageKey: `key:${descriptorUrl}`,
      title: "CAWB-035 실제 영상 제목 - 123AV"
    }
  ]);
  assert.deepEqual(mediaRequests[0], [
    7,
    {
      pageUrl: descriptorUrl,
      title: "CAWB-035 실제 영상 제목 - 123AV"
    }
  ]);
  assert.equal(response.items[0].title, "CAWB-035 실제 영상 제목 - 123AV");

  const healthCalls = [];
  const helperHandler = createHelperMessageHandler({
    YtDlp: {
      health: async (force) => {
        healthCalls.push(force);
        return { available: true, version: "test" };
      }
    },
    UVD: {
      parseUrlsFromText: () => ["not-a-url"]
    }
  });
  response = null;
  assert.deepEqual(
    helperHandler(
      { type: "YTDLP_HEALTH", force: true },
      7,
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, available: true, version: "test" });
  assert.deepEqual(healthCalls, [true]);

  response = null;
  assert.deepEqual(
    helperHandler(
      { type: "DOWNLOAD_BATCH", text: "not-a-url" },
      7,
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response, { ok: false, error: "유효한 링크가 없습니다" });
  assert.deepEqual(helperHandler({ type: "OTHER" }, 7, () => {}), {
    handled: false,
    keepChannel: false
  });

  const chunkHandler = createChunkAssemblyHandler({
    downloadBlob: async () => {
      throw new Error("unexpected download");
    },
    Blob,
    Uint8Array,
    ArrayBuffer
  });
  response = null;
  assert.deepEqual(
    chunkHandler(
      {
        type: "VIDEO_CHUNK",
        id: "assembly-1",
        index: 0,
        totalChunks: 1,
        chunk: [1, 2, 3]
      },
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response, { ok: true });

  response = null;
  assert.deepEqual(
    chunkHandler(
      { type: "VIDEO_CHUNK_FINISH", id: "missing-assembly" },
      (value) => { response = value; }
    ),
    { handled: true, keepChannel: false }
  );
  assert.deepEqual(response, { ok: false, error: "조립 데이터 없음" });

  // Page → service-worker messages are JSON-serialized by Chrome. Simulate
  // that wire format and prove base64 chunks survive while raw ArrayBuffers
  // are rejected instead of silently assembling an empty file.
  const wire = (message) => JSON.parse(JSON.stringify(message));
  const saved = [];
  const jsonChunkHandler = createChunkAssemblyHandler({
    downloadBlob: async (blob, filename) => {
      saved.push({ size: blob.size, filename, blob });
      return { downloadId: 91, filename, path: `/tmp/${filename}` };
    },
    Blob,
    Uint8Array,
    ArrayBuffer,
    atob: (text) => Buffer.from(text, "base64").toString("binary")
  });
  const payload = new Uint8Array(120_000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
  const half = payload.length / 2;
  const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");

  response = null;
  jsonChunkHandler(
    wire({
      type: "VIDEO_CHUNK",
      id: "raw-buffer",
      index: 0,
      totalChunks: 1,
      chunk: payload.buffer
    }),
    (value) => { response = value; }
  );
  assert.equal(response.ok, false, "raw ArrayBuffer over JSON must be rejected");
  assert.match(response.error, /base64/);

  for (const [index, slice] of [
    [0, payload.subarray(0, half)],
    [1, payload.subarray(half)]
  ]) {
    response = null;
    jsonChunkHandler(
      wire({
        type: "VIDEO_CHUNK",
        id: "b64-assembly",
        jobId: "dl_job_1",
        index,
        totalChunks: 2,
        totalBytes: payload.length,
        encoding: "base64",
        chunk: toBase64(slice),
        filename: "clip.mp4",
        mime: "video/mp4"
      }),
      (value) => { response = value; }
    );
    assert.deepEqual(response, { ok: true });
  }

  // A second frame answering the same SMART_DOWNLOAD may not start a
  // competing save for the same job.
  response = null;
  jsonChunkHandler(
    wire({
      type: "VIDEO_CHUNK",
      id: "b64-assembly-other-frame",
      jobId: "dl_job_1",
      index: 0,
      totalChunks: 1,
      encoding: "base64",
      chunk: toBase64(payload.subarray(0, 16))
    }),
    (value) => { response = value; }
  );
  assert.equal(response.ok, false);
  assert.equal(response.duplicate, true);

  const finished = await new Promise((resolve) => {
    const result = jsonChunkHandler(
      wire({
        type: "VIDEO_CHUNK_FINISH",
        id: "b64-assembly",
        jobId: "dl_job_1",
        filename: "clip.mp4",
        mime: "video/mp4"
      }),
      resolve
    );
    assert.deepEqual(result, { handled: true, keepChannel: true });
  });
  assert.deepEqual(finished, {
    ok: true,
    downloadId: 91,
    filename: "clip.mp4",
    path: "/tmp/clip.mp4",
    size: payload.length
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, "clip.mp4");
  assert.deepEqual(
    new Uint8Array(await saved[0].blob.arrayBuffer()),
    payload,
    "decoded bytes match what the page sent"
  );

  console.log("message routers: 77 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
