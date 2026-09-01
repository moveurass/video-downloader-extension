"use strict";

const assert = require("node:assert/strict");
const UVDProgress = require("../src/progress-protocol.js");
const { createManager } = require("../src/background-download-jobs.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};
const ok = (...args) => {
  assertions += 1;
  assert.ok(...args);
};

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function makeHarness() {
  let clock = 1_000;
  const messages = [];
  const sessionWrites = [];
  const timers = [];
  const stoppedTabs = [];
  const notificationClicks = event();
  const lateCalls = {
    downloadPageFromUi: 0,
    saveCompanionThumbnail: 0,
    startKeepAlive: 0,
    stopKeepAlive: 0
  };
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
      },
      getURL: (path) => `chrome-extension://unit/${path}`
    },
    storage: {
      session: {
        set: async (value) => {
          sessionWrites.push(value);
        }
      }
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        stoppedTabs.push({ tabId, message });
      }
    },
    downloads: {
      cancel() {},
      show() {},
      search: async () => [],
      showDefaultFolder() {}
    },
    notifications: {
      onClicked: notificationClicks,
      create: async () => {},
      clear: async () => {}
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {}
    }
  };
  const history = [];
  const UVD = {
    classifyError: (error) => ({
      code: error ? "unit_error" : "other",
      label: error ? "Unit error" : "",
      hint: error ? "Retry" : "",
      actions: error ? ["retry"] : []
    }),
    formatSpeed: (speed) => `${speed} B/s`,
    isGenericSaveName: (name) => !name || /^video$/i.test(name),
    getSettings: async () => ({
      showBadge: true,
      notifyOnComplete: false
    }),
    appendHistory: async (entry) => {
      history.push(entry);
    },
    siteFromUrl: () => "example"
  };
  const manager = createManager({
    chrome,
    UVD,
    UVDProgress,
    Naming: {
      cleanPageTitle: (title) => title.trim()
    },
    YtDlp: {
      cancelJob: async () => {}
    },
    parseSpeedFromMessage: () => 0,
    getTabMeta: () => ({ thumbnail: "https://example.test/thumb.jpg" }),
    saveCompanionThumbnail: async () => {
      lateCalls.saveCompanionThumbnail += 1;
    },
    downloadPageFromUi: async () => {
      lateCalls.downloadPageFromUi += 1;
      return { ok: true };
    },
    startKeepAlive: () => {
      lateCalls.startKeepAlive += 1;
      return true;
    },
    stopKeepAlive: () => {
      lateCalls.stopKeepAlive += 1;
    },
    now: () => ++clock,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    console: { warn() {} }
  });
  return {
    manager,
    messages,
    sessionWrites,
    timers,
    stoppedTabs,
    notificationClicks,
    history,
    lateCalls
  };
}

async function main() {
  const harness = makeHarness();
  const {
    manager,
    messages,
    sessionWrites,
    timers,
    stoppedTabs,
    notificationClicks,
    lateCalls
  } = harness;

  deepEqual(lateCalls, {
    downloadPageFromUi: 0,
    saveCompanionThumbnail: 0,
    startKeepAlive: 0,
    stopKeepAlive: 0
  });
  equal(notificationClicks.listeners.length, 1);
  manager.bindNotificationListener();
  manager.bindNotificationListener();
  equal(notificationClicks.listeners.length, 1);

  const jobId = manager.createDownloadJob({
    tabId: 7,
    title: "Example title",
    pageUrl: "https://example.test/watch",
    filename: "example.mp4",
    quality: "1080p",
    tags: ["favorite"]
  });
  const job = manager.activeDownloads.get(jobId);
  equal(job.progressVersion, UVDProgress.VERSION);
  equal(job.progressAttempt, 1);
  equal(job.progressSeq, 1);
  equal(manager.getCurrentJobContext(), null);

  await manager.withJobContext(jobId, async () => {
    equal(manager.getCurrentJobContext(), jobId);
  });
  equal(manager.getCurrentJobContext(), null);

  manager.updateDownloadJob(jobId, { percent: 40, message: "40%" });
  equal(job.percent, 40);
  equal(job.progressSeq, 2);
  manager.updateDownloadJob(jobId, { percent: 15, message: "late 15%" });
  equal(job.percent, 40);
  equal(job.progressAttempt, 1);
  equal(job.progressSeq, 3);

  manager.emitDownloadProgress(7, 5, "fallback", "download", jobId, {
    progressReset: true,
    progressAttempt: 1
  });
  equal(job.percent, 5);
  equal(job.progressAttempt, 2);
  equal(job.progressSeq, 4);

  manager.emitDownloadProgress(7, 90, "stale", "download", jobId, {
    progressAttempt: 1
  });
  equal(job.percent, 5);
  equal(job.progressSeq, 4);
  manager.emitDownloadProgress(7, 20, "current", "download", jobId, {
    progressAttempt: 2
  });
  equal(job.percent, 20);
  equal(job.progressSeq, 5);

  const persisted = sessionWrites.at(-1).uvdActiveDownloads[0];
  deepEqual(Object.keys(persisted.result || {}), []);
  equal(persisted.id, jobId);
  equal(persisted.progressAttempt, 2);
  equal(persisted.progressSeq, 5);
  equal(persisted.thumbnail, undefined);
  equal(persisted.cancelRequested, undefined);
  equal(persisted.tags, undefined);
  equal(persisted.speedLabel, "");
  ok(messages.some((message) => message.type === "DOWNLOAD_JOB"));

  await manager.pauseDownloadJob(jobId);
  equal(job.status, "paused");
  equal(job.phase, "paused");
  equal(job.pauseRequested, true);
  equal(manager.jobAbortControllers.has(jobId), false);
  equal(stoppedTabs.at(-1).message.type, "STOP_DOWNLOAD");
  assert.throws(
    () => manager.emitDownloadProgress(7, 70, "late", "download", jobId),
    (error) => error.code === "PAUSED"
  );
  assertions += 1;
  manager.updateDownloadJob(jobId, { status: "running", percent: 99 });
  equal(job.status, "paused");
  equal(job.percent, 20);

  manager.finishCancelledJob(jobId);
  equal(job.status, "cancelled");
  equal(job.cancelRequested, true);
  manager.finalizePausedJob(jobId);
  equal(job.status, "cancelled");
  assert.throws(
    () => manager.throwIfJobStopped(jobId),
    (error) => error.code === "CANCELLED"
  );
  assertions += 1;
  equal(timers.some((timer) => timer.delay === 30_000), true);

  const doneId = manager.createDownloadJob({
    tabId: 8,
    title: "Completed title",
    pageUrl: "https://example.test/done",
    filename: "before.mp4"
  });
  manager.finishDownloadJob(
    doneId,
    {
      ok: true,
      downloadId: 42,
      path: "/Downloads/after.mp4",
      filename: "after.mp4",
      size: 200_000,
      method: "direct"
    },
    null
  );
  const done = manager.activeDownloads.get(doneId);
  equal(done.status, "done");
  equal(done.percent, 100);
  equal(done.filename, "after.mp4");
  equal(timers.some((timer) => timer.delay === 120_000), true);

  console.log(`background download jobs unit: ${assertions} assertions`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
