"use strict";

const assert = require("node:assert/strict");
const { createFallback } = require("../src/background-page-fallback.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};

function makeHarness(options = {}) {
  const messages = [];
  const injections = [];
  const timeouts = [];
  const warnings = [];
  const activeDownloads = new Map(options.jobs || []);
  const chrome = {
    tabs: {
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        if (message.type === "PING_CONTENT") {
          if (options.pingError) throw options.pingError;
          return options.pingResponse ?? { hasDownload: true };
        }
        if (options.downloadError !== undefined) throw options.downloadError;
        return options.downloadResponse;
      }
    },
    scripting: {
      async executeScript(details) {
        injections.push(details);
        if (options.injectionError) throw options.injectionError;
      }
    }
  };
  const fallback = createFallback({
    chrome,
    activeDownloads,
    getCurrentJobContext: () => options.currentJobId ?? null,
    async withTimeout(promise, milliseconds, label) {
      timeouts.push({ milliseconds, label });
      if (options.timeoutLabel === label) {
        Promise.resolve(promise).catch(() => {});
        throw new Error(label);
      }
      return promise;
    },
    console: {
      warn(...args) {
        warnings.push(args);
      }
    }
  });
  return { ...fallback, messages, injections, timeouts, warnings };
}

async function main() {
  const ping = makeHarness();
  await ping.ensureContentScripts(7);
  deepEqual(ping.messages, [
    { tabId: 7, message: { type: "PING_CONTENT" } }
  ]);
  deepEqual(ping.timeouts, [{ milliseconds: 2500, label: "ping" }]);
  equal(ping.injections.length, 0);

  const injection = makeHarness({ pingError: new Error("no receiver") });
  await injection.ensureContentScripts(8);
  deepEqual(injection.injections, [{
    target: { tabId: 8, allFrames: true },
    files: ["src/hls-downloader.js", "src/page-download.js", "src/content.js"]
  }]);
  equal(injection.warnings.length, 0);

  const injectionFailure = makeHarness({
    pingResponse: { hasDownload: false },
    injectionError: new Error("blocked")
  });
  await injectionFailure.ensureContentScripts(9);
  equal(injectionFailure.injections.length, 1);
  equal(injectionFailure.warnings.length, 1);
  equal(injectionFailure.warnings[0][0], "[UVD] inject");
  equal(injectionFailure.warnings[0][1].message, "blocked");

  const payload = makeHarness({
    currentJobId: "context-job",
    jobs: [["payload-job", { progressAttempt: "4" }]],
    downloadResponse: { ok: true, downloadId: 42, size: 123 }
  });
  const payloadResult = await payload.pageDownloadAllFrames(10, {
    type: "WRONG",
    url: "blob:test",
    jobId: "payload-job",
    progressAttempt: 99,
    tabId: 999
  });
  deepEqual(payloadResult, { ok: true, downloadId: 42, size: 123 });
  equal(payload.messages.length, 2);
  deepEqual(payload.messages[1], {
    tabId: 10,
    message: {
      type: "WRONG",
      url: "blob:test",
      jobId: "payload-job",
      progressAttempt: 4,
      tabId: 10
    }
  });
  deepEqual(payload.timeouts[1], {
    milliseconds: 25 * 60 * 1000,
    label: "다운로드 시간 초과"
  });

  const context = makeHarness({
    currentJobId: "context-job",
    jobs: [["context-job", { progressAttempt: 0 }]],
    downloadResponse: { ok: true }
  });
  await context.pageDownloadAllFrames(11, { url: "blob:context" });
  equal(context.messages[1].message.jobId, "context-job");
  equal(context.messages[1].message.progressAttempt, 1);

  const noJob = makeHarness({ downloadResponse: { ok: true } });
  await noJob.pageDownloadAllFrames(12, {});
  equal(noJob.messages[1].message.jobId, null);
  equal(noJob.messages[1].message.progressAttempt, 0);

  const responseError = makeHarness({
    downloadResponse: { ok: false, error: "page failed" }
  });
  deepEqual(
    await responseError.pageDownloadAllFrames(13, {}),
    { ok: false, error: "page failed" }
  );

  const defaultError = makeHarness({ downloadResponse: null });
  deepEqual(
    await defaultError.pageDownloadAllFrames(14, {}),
    { ok: false, error: "페이지 다운로드 실패" }
  );

  const thrownError = makeHarness({ downloadError: new Error("send failed") });
  deepEqual(
    await thrownError.pageDownloadAllFrames(15, {}),
    { ok: false, error: "send failed" }
  );

  const timeout = makeHarness({ timeoutLabel: "다운로드 시간 초과" });
  deepEqual(
    await timeout.pageDownloadAllFrames(16, {}),
    { ok: false, error: "다운로드 시간 초과" }
  );
  deepEqual(timeout.timeouts[1], {
    milliseconds: 25 * 60 * 1000,
    label: "다운로드 시간 초과"
  });

  const invalid = makeHarness();
  deepEqual(
    await invalid.pageDownloadAllFrames(-1, { jobId: "ignored" }),
    { ok: false, error: "탭 없음" }
  );
  deepEqual(
    await invalid.pageDownloadAllFrames(null, { jobId: "ignored" }),
    { ok: false, error: "탭 없음" }
  );
  equal(invalid.messages.length, 0);
  equal(invalid.injections.length, 0);

  console.log(`background page fallback: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
