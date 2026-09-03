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

function makeHarness(responses = []) {
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
      return responses[responseIndex++] || { jobs: [] };
    },
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

  console.log(`popup progress UI: ${assertions} assertions passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
