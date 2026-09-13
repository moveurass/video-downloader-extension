"use strict";

const assert = require("node:assert/strict");
const ProgressUI = require("../src/popup-progress-ui.js");
const QueueState = require("../src/download-queue-state.js");
const QueueUI = require("../src/popup-queue-ui.js");
const UVD = require("../src/uvd-common.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const add = force === undefined ? !values.has(name) : force;
      if (add) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); }
  };
}

function element(attributes = {}) {
  return {
    attributes,
    classList: classList(),
    dataset: {},
    innerHTML: "",
    textContent: "",
    title: "",
    scrollTop: 0,
    onclick: null,
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function makeHarness(responses = [], options = {}) {
  const calls = [];
  const timers = [];
  const intervals = [];
  const filters = ["all", "running", "done", "error"].map((filter) =>
    element({ "data-qf": filter })
  );
  const elements = {
    dlQueue: element(),
    dlQueueList: element(),
    dlQueueTitle: element(),
    dlQueueSub: element(),
    dlQueueBadge: element(),
    dlQueueFilters: element(),
    dlQueueClearDone: element(),
    progress: element(),
    progressFill: element(),
    progressText: element()
  };
  elements.dlQueueFilters.querySelectorAll = (selector) =>
    selector === ".dl-qf" ? filters : [];
  const uiJobs = new Map();
  const trackedJobIds = new Set();
  const toastedJobIds = new Set();
  let responseIndex = 0;
  const controller = ProgressUI.createController({
    $: (selector) => elements[selector.slice(1)] || null,
    UVD,
    UVDQueueState: QueueState,
    UVDPopupQueueUI: QueueUI,
    uiJobs,
    trackedJobIds,
    toastedJobIds,
    cleanTitleText: (value) => String(value || "").trim(),
    isUglyName: () => false,
    siteLabel: () => "Test",
    escapeHtml: (value) => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    escapeAttr: (value) => String(value ?? "").replace(/"/g, "&quot;"),
    toast: (...args) => calls.push(["toast", ...args]),
    userError: (value) => String(value || ""),
    maxConcurrentStarts: 6,
    sendMessage: async (message) => {
      calls.push(["sendMessage", message]);
      if (options.sendMessage) return options.sendMessage(message);
      return responses[responseIndex++] || { jobs: [] };
    },
    fetchThumbDataUrl: options.fetchThumbDataUrl,
    playCompletionSound: () => calls.push(["chime"]),
    recoveryActionsHtml: () => '<button data-act="retry">다시 받기</button>',
    bindRecoveryButtons: (root) => calls.push(["bindRecoveryButtons", root]),
    getPlaylistDl: () => ({ jobIds: new Set() }),
    updatePlaylistProgressUi: () => calls.push(["playlist"]),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: (id) => calls.push(["clearInterval", id]),
    now: () => 10_000
  });
  return {
    controller, calls, timers, intervals, filters, elements,
    uiJobs, trackedJobIds, toastedJobIds
  };
}

(async () => {
  const harness = makeHarness();
  check(harness.calls, [], "constructor has no effects");
  check(harness.timers.length, 0, "constructor schedules no timeout");
  check(harness.intervals.length, 0, "constructor starts no poll");

  harness.controller.applyJobProgress({
    id: "job-1", status: "running", title: "첫 영상",
    progressVersion: 1, progressAttempt: 1, progressSeq: 1, percent: 45
  });
  harness.controller.applyJobProgress({
    id: "job-1", status: "running",
    progressVersion: 1, progressAttempt: 1, progressSeq: 2, percent: 20
  });
  check(harness.uiJobs.get("job-1").percent, 45, "same-attempt percent is monotonic");
  harness.controller.applyJobProgress({
    id: "job-1", status: "running",
    progressVersion: 1, progressAttempt: 1, progressSeq: 1, percent: 99
  });
  check(harness.uiJobs.get("job-1").percent, 45, "stale protocol event is rejected");
  harness.controller.applyJobProgress({
    id: "job-1", status: "running",
    progressVersion: 1, progressAttempt: 2, progressSeq: 3, percent: 7
  });
  check(harness.uiJobs.get("job-1").percent, 7, "new attempt may reset percent");

  harness.controller.upsertUiJob({
    id: "paused", status: "paused", title: "정지 영상", percent: 33
  }, { local: true });
  harness.controller.applyJobProgress({ id: "paused", percent: 80, message: "late" });
  check(harness.uiJobs.get("paused").status, "paused", "ambient event cannot revive pause");
  check(harness.uiJobs.get("paused").percent, 33, "ambient event cannot move paused bar");

  harness.controller.renderDownloadQueue(true);
  check(
    harness.elements.dlQueueList.innerHTML.includes('data-act="pause"'),
    true,
    "running actions render"
  );
  check(
    harness.elements.dlQueueList.innerHTML.includes('data-act="resume"'),
    true,
    "paused actions render"
  );
  check(
    harness.elements.dlQueueList.innerHTML.includes("다시 시작"),
    true,
    "paused jobs without a checkpoint offer restart, not resume"
  );
  harness.elements.dlQueueList.scrollTop = 27;
  harness.controller.renderDownloadQueue(true);
  check(harness.elements.dlQueueList.scrollTop, 27, "render preserves scroll");
  harness.filters[2].onclick();
  check(
    harness.elements.dlQueueList.innerHTML.includes("이 필터에 항목이 없습니다"),
    true,
    "filter binding renders empty state"
  );

  const restore = makeHarness([{
    jobs: [
      { id: "a", status: "running", title: "A", percent: 10 },
      { id: "b", status: "running", title: "B", percent: 20 }
    ]
  }]);
  check(await restore.controller.restoreActiveDownloads(), true, "restore reports jobs");
  check(
    restore.calls[0],
    ["sendMessage", { type: "GET_ACTIVE_DOWNLOADS" }],
    "restore requests active downloads"
  );
  check(restore.intervals.length, 1, "restore starts one poll");
  check(restore.intervals[0].ms, 900, "poll interval is preserved");
  check(
    restore.calls.some((call) =>
      call[0] === "toast" && call[1] === "동시 다운로드 2개 진행 중"),
    true,
    "restore keeps multi-download toast"
  );
  restore.controller.ensureQueuePoll();
  check(restore.intervals.length, 1, "poll setup deduplicates");

  const refresh = makeHarness([{
    jobs: [{
      id: "ordered", status: "running", title: "Ordered", percent: 70,
      progressVersion: 1, progressAttempt: 1, progressSeq: 5
    }]
  }, {
    jobs: [{
      id: "ordered", status: "running", title: "Ordered", percent: 90,
      progressVersion: 1, progressAttempt: 1, progressSeq: 4
    }]
  }]);
  await refresh.controller.refreshJobsFromBackground();
  await refresh.controller.refreshJobsFromBackground();
  check(refresh.uiJobs.get("ordered").percent, 70, "poll rejects older sequence");

  const chime = makeHarness();
  chime.controller.applyJobProgress({ id: "ok", status: "done", title: "완료" });
  chime.controller.applyJobProgress({ id: "ok", status: "done", title: "완료" });
  check(
    chime.calls.filter((call) => call[0] === "chime").length,
    1,
    "completion chimes once per job"
  );
  chime.controller.applyJobProgress({
    id: "bad", status: "error", title: "실패", error: "network"
  });
  chime.controller.applyJobProgress({ id: "held", status: "paused", title: "정지" });
  chime.controller.applyJobProgress({
    id: "quiet", status: "done", title: "조용히", _silentDone: true
  });
  check(
    chime.calls.filter((call) => call[0] === "chime").length,
    1,
    "failure, pause, and silent completion stay quiet"
  );

  const restored = makeHarness([{
    jobs: [{ id: "old", status: "done", title: "이전에 끝난 영상", percent: 100 }]
  }]);
  await restored.controller.restoreActiveDownloads();
  check(
    restored.calls.some((call) => call[0] === "chime"),
    false,
    "jobs finished before the popup opened do not chime"
  );

  const dismiss = makeHarness([
    { ok: true, dismissed: "done-1" },
    { jobs: [{ id: "done-1", status: "done", title: "끝난 영상", percent: 100 }] },
    { jobs: [{ id: "done-1", status: "done", title: "끝난 영상", percent: 100 }] }
  ]);
  dismiss.controller.applyJobProgress({
    id: "done-1", status: "done", title: "끝난 영상", percent: 100
  });
  dismiss.controller.applyJobProgress({
    id: "run-1", status: "running", title: "받는 중", percent: 40
  });
  check(await dismiss.controller.dismissUiJob("done-1"), { ok: true, dismissed: "done-1" });
  check(dismiss.uiJobs.has("done-1"), false, "dismiss removes the finished row");
  check(dismiss.uiJobs.get("run-1").status, "running", "dismiss leaves running jobs");
  check(
    dismiss.calls.some((call) =>
      call[0] === "sendMessage" && call[1]?.type === "DISMISS_DOWNLOAD"
    ),
    true,
    "dismiss persists to the background"
  );
  await dismiss.controller.refreshJobsFromBackground();
  check(dismiss.uiJobs.has("done-1"), false, "poll does not rehydrate a dismissed job");
  await dismiss.controller.restoreActiveDownloads();
  check(dismiss.uiJobs.has("done-1"), false, "restore does not rehydrate a dismissed job");
  dismiss.controller.applyJobProgress({
    id: "done-1", status: "done", title: "끝난 영상", percent: 100
  });
  check(dismiss.uiJobs.has("done-1"), false, "stale job events stay dismissed");

  const refused = makeHarness();
  refused.controller.applyJobProgress({
    id: "live", status: "running", title: "진행", percent: 12
  });
  check(
    (await refused.controller.dismissUiJob("live")).ok,
    false,
    "running jobs cannot be dismissed"
  );
  check(refused.uiJobs.has("live"), true, "refused dismiss keeps the running row");

  const bulk = makeHarness([{ ok: true, dismissed: ["ok-1", "bad-1"] }]);
  bulk.controller.applyJobProgress({ id: "ok-1", status: "done", title: "완료" });
  bulk.controller.applyJobProgress({
    id: "bad-1", status: "error", title: "실패", error: "network"
  });
  bulk.controller.applyJobProgress({
    id: "live-1", status: "running", title: "진행", percent: 8
  });
  bulk.controller.renderDownloadQueue(true);
  check(
    bulk.elements.dlQueueClearDone.classList.contains("hidden"),
    false,
    "bulk dismiss control appears when finished jobs exist"
  );
  const bulkResult = await bulk.controller.dismissFinishedUiJobs();
  check(bulkResult.ok, true, "bulk dismiss reports success");
  check(bulk.uiJobs.has("ok-1"), false, "bulk dismiss removes completed jobs");
  check(bulk.uiJobs.has("bad-1"), false, "bulk dismiss removes failed jobs");
  check(bulk.uiJobs.has("live-1"), true, "bulk dismiss leaves active jobs");
  check(
    bulk.calls.some((call) =>
      call[0] === "sendMessage" && call[1]?.type === "DISMISS_FINISHED_DOWNLOADS"
    ),
    true,
    "bulk dismiss persists to the background"
  );
  bulk.controller.applyJobProgress({
    id: "fresh", status: "running", title: "다시 받기", percent: 3
  });
  check(bulk.uiJobs.has("fresh"), true, "a new download can appear after dismiss");

  const retrySame = makeHarness([{ ok: true, dismissed: "same" }]);
  retrySame.controller.applyJobProgress({
    id: "same", status: "error", title: "실패", error: "network"
  });
  await retrySame.controller.dismissUiJob("same");
  retrySame.controller.applyJobProgress({
    id: "same", status: "running", title: "다시 받기", percent: 1
  });
  check(
    retrySame.uiJobs.get("same")?.status,
    "running",
    "a new run of the same job id is allowed"
  );

  const staleSnapshot = [
    {
      id: "run-live", status: "running", title: "받는 중", percent: 18,
      updatedAt: 9_000, progressAttempt: 1, progressSeq: 4
    },
    {
      id: "fail-1", status: "error", title: "실패 1",
      error: "다운로드 중단 (SERVER_BAD_CONTENT)",
      updatedAt: 8_000, progressAttempt: 1, progressSeq: 2
    },
    {
      id: "fail-2", status: "error", title: "실패 2",
      error: "다운로드 중단 (SERVER_BAD_CONTENT)",
      updatedAt: 8_500, progressAttempt: 1, progressSeq: 3
    }
  ];
  let releaseStaleGet;
  const staleGet = new Promise((resolve) => {
    releaseStaleGet = resolve;
  });
  const race = makeHarness([], {
    sendMessage: async (message) => {
      if (message.type === "GET_ACTIVE_DOWNLOADS") return staleGet;
      if (message.type === "DISMISS_DOWNLOAD") {
        return { ok: true, dismissed: message.jobId };
      }
      return { jobs: [] };
    }
  });
  for (const job of staleSnapshot) {
    race.controller.applyJobProgress(job);
  }
  race.controller.renderDownloadQueue(true);
  check(race.uiJobs.size, 3, "race setup has 1 running + 2 failed");
  const inflightRefresh = race.controller.refreshJobsFromBackground();
  await race.controller.dismissUiJob("fail-1");
  check(race.uiJobs.has("fail-1"), false, "first failed dismiss applies");
  check(race.uiJobs.size, 2, "header source is 1 running + 1 failed");
  const secondDismiss = race.controller.dismissUiJob("fail-2");
  check(race.uiJobs.has("fail-2"), false, "second failed dismiss applies immediately");
  check(race.uiJobs.size, 1, "only the running job remains after second dismiss");
  race.controller.applyJobProgress({
    jobId: "fail-2",
    phase: "download",
    percent: 40,
    message: "late helper tick"
  });
  check(race.uiJobs.has("fail-2"), false, "status-less progress cannot revive dismiss");
  releaseStaleGet({ jobs: staleSnapshot });
  await inflightRefresh;
  await secondDismiss;
  check(race.uiJobs.has("fail-2"), false, "stale GET snapshot cannot resurrect fail-2");
  check(race.uiJobs.has("fail-1"), false, "stale GET snapshot cannot resurrect fail-1");
  check(race.uiJobs.get("run-live")?.status, "running", "running job survives the stale sync");
  race.controller.applyJobProgress({
    id: "fail-2",
    status: "error",
    title: "실패 2",
    error: "다운로드 중단 (SERVER_BAD_CONTENT)",
    updatedAt: 8_500,
    progressAttempt: 1,
    progressSeq: 3
  });
  check(race.uiJobs.has("fail-2"), false, "replayed failed DOWNLOAD_JOB stays dismissed");
  race.controller.renderDownloadQueue(true);
  check(race.uiJobs.size, 1, "rerender of the same snapshot keeps dismiss");
  check(
    race.elements.dlQueueTitle.textContent.includes("1개") ||
      race.elements.dlQueueTitle.textContent.includes("받는 중 1"),
    true,
    "header count stays at the single running job"
  );

  let dismissAttempts = 0;
  const persistFlake = makeHarness([], {
    sendMessage: async (message) => {
      if (message.type === "DISMISS_DOWNLOAD") {
        dismissAttempts += 1;
        if (dismissAttempts === 1) throw new Error("channel closed");
        return { ok: true, dismissed: message.jobId };
      }
      return { jobs: staleSnapshot };
    }
  });
  persistFlake.controller.applyJobProgress(staleSnapshot[2]);
  persistFlake.controller.applyJobProgress(staleSnapshot[0]);
  await persistFlake.controller.dismissUiJob("fail-2");
  check(persistFlake.uiJobs.has("fail-2"), false, "persist retry keeps the row dismissed");
  await persistFlake.controller.refreshJobsFromBackground();
  check(
    persistFlake.uiJobs.has("fail-2"),
    false,
    "refresh after a flaky persist still cannot resurrect"
  );

  const cover = makeHarness([], {
    fetchThumbDataUrl: async (url, referer, extra) => {
      callsForCover.push([url, referer, extra]);
      return "data:image/jpeg;base64,Y292ZXI=";
    }
  });
  const callsForCover = [];
  cover.controller.upsertUiJob(
    {
      id: "tt-1",
      status: "done",
      title: "jumping killing shoot",
      percent: 100,
      pageUrl: "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150",
      thumbnail: "https://p19-common-sign.tiktokcdn-us.com/cover",
      result: { filename: "jumping.mp4", thumbnailPath: "/tmp/jumping.jpg" }
    },
    { toast: false, forceStructure: true, local: true }
  );
  cover.controller.renderDownloadQueue(true);
  check(
    cover.elements.dlQueueList.innerHTML.includes("dl-job-thumb"),
    true,
    "completed queue rows render a preview slot"
  );
  check(
    cover.elements.dlQueueList.innerHTML.includes(
      'data-thumb-url="https://p19-common-sign.tiktokcdn-us.com/cover"'
    ),
    true,
    "completed queue rows keep the formats cover for hydration"
  );
  await cover.controller.hydrateQueueThumbs([...cover.uiJobs.values()]);
  check(
    cover.uiJobs.get("tt-1").thumbnail,
    "data:image/jpeg;base64,Y292ZXI=",
    "queue hydrate stores a data URL on the job"
  );

  const bleed = makeHarness();
  bleed.controller.upsertUiJob(
    {
      id: "shared-row",
      status: "running",
      title: "Video A",
      percent: 10,
      pageUrl: "https://www.tiktok.com/@one/video/1111111111111111111",
      thumbnail: "data:image/jpeg;base64,VIDEOA"
    },
    { toast: false, forceStructure: true, local: true }
  );
  bleed.controller.upsertUiJob(
    {
      id: "shared-row",
      status: "running",
      title: "Video B",
      percent: 12,
      pageUrl: "https://www.tiktok.com/@two/video/2222222222222222222",
      thumbnail: ""
    },
    { toast: false, forceStructure: true, local: true }
  );
  check(
    bleed.uiJobs.get("shared-row").thumbnail,
    "",
    "queue row does not keep video A's cover after the job pageUrl changes"
  );

  console.log(`popup progress UI: ${assertions} assertions passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
