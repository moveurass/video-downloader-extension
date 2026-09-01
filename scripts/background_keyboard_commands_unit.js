"use strict";

const assert = require("node:assert/strict");
const { createController } = require("../src/background-keyboard-commands.js");

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function makeHarness(options = {}) {
  const onCommand = event();
  const jobs = [];
  const pageCalls = [];
  const notifications = [];
  const warnings = [];
  const controller = createController({
    chrome: {
      commands: { onCommand },
      tabs: {
        query: async () =>
          options.noTab
            ? []
            : [{ id: 7, url: "https://example.test/watch", title: " Page title " }]
      },
      runtime: {
        getURL: (path) => `chrome-extension://unit/${path}`
      },
      notifications: {
        create(details) {
          notifications.push(details);
        }
      }
    },
    UVD: {
      getSettings: async () => ({ mediaMode: "video_subs" })
    },
    Naming: {
      cleanPageTitle: (title) => title.trim()
    },
    buildSaveFilename: async (input) =>
      `${input.title}-${input.mediaMode}.mp4`,
    getTabMeta: () => ({ thumbnail: "https://cdn.test/thumb.jpg" }),
    async runTrackedDownloadAsync(job, operation) {
      jobs.push(job);
      return operation("job-1");
    },
    async downloadPageFromUi(...args) {
      pageCalls.push(args);
      return { ok: true };
    },
    console: {
      warn(...args) {
        warnings.push(args);
      }
    }
  });
  return { controller, onCommand, jobs, pageCalls, notifications, warnings };
}

async function main() {
  const harness = makeHarness();
  harness.controller.bind();
  harness.controller.bind();
  assert.equal(harness.onCommand.listeners.length, 1);

  await harness.controller.onCommand("download-current-page");
  assert.deepEqual(harness.jobs[0], {
    tabId: 7,
    title: "Page title",
    pageUrl: "https://example.test/watch",
    filename: "Page title-video_subs.mp4",
    mediaMode: "video_subs",
    quality: "best",
    thumbnail: "https://cdn.test/thumb.jpg"
  });
  assert.deepEqual(harness.pageCalls[0], [
    7,
    "https://example.test/watch",
    "best",
    "job-1",
    { mediaMode: "video_subs", preferQuality: "best" }
  ]);

  await harness.controller.onCommand("download-audio-only");
  assert.equal(harness.jobs[1].mediaMode, "audio");
  assert.equal(harness.jobs[1].quality, "best");
  assert.equal(harness.jobs[1].filename, "Page title-audio.mp4");

  await harness.controller.onCommand("unknown");
  assert.equal(harness.jobs.length, 2);

  const failure = makeHarness({ noTab: true });
  await failure.controller.onCommand("download-best-quality");
  assert.equal(failure.warnings.length, 1);
  assert.equal(failure.notifications.length, 1);
  assert.equal(failure.notifications[0].title, "다운로드 실패");
  assert.match(failure.notifications[0].message, /탭 없음/);

  console.log("background keyboard commands: binding and download flows passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
