"use strict";

const assert = require("node:assert/strict");
const RecoveryUI = require("../src/popup-recovery-ui.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

(async () => {
  const calls = [];
  const jobs = new Map([
    ["done-1", { id: "done-1", status: "done", title: "끝난 영상" }],
    ["run-1", { id: "run-1", status: "running", title: "받는 중" }]
  ]);
  const controller = RecoveryUI.createController({
    jobs,
    sendMessage: async (message) => {
      calls.push(["sendMessage", message]);
      return { ok: true };
    },
    toast: (...args) => calls.push(["toast", ...args]),
    userError: (value) => String(value || ""),
    dismissUiJob: async (id) => {
      calls.push(["dismissUiJob", id]);
      jobs.delete(id);
      return { ok: true, dismissed: id };
    },
    renderDownloadQueue: () => calls.push(["renderDownloadQueue"])
  });

  await controller.handleAction("dismiss", {
    jobId: "done-1",
    button: { getAttribute: (name) => (name === "data-job" ? "done-1" : "") }
  });
  check(jobs.has("done-1"), false, "dismiss removes the finished job");
  check(jobs.has("run-1"), true, "dismiss leaves other jobs");
  check(
    calls.filter((call) => call[0] === "dismissUiJob"),
    [["dismissUiJob", "done-1"]],
    "dismiss uses the persisted helper"
  );

  const fallbackJobs = new Map([
    ["old", { id: "old", status: "error" }]
  ]);
  const fallback = RecoveryUI.createController({
    jobs: fallbackJobs,
    sendMessage: async () => ({ ok: true }),
    toast: () => {},
    userError: (value) => String(value || ""),
    renderDownloadQueue: () => calls.push(["fallbackRender"])
  });
  await fallback.handleAction("dismiss", { jobId: "old" });
  check(fallbackJobs.has("old"), false, "legacy dismiss still deletes locally");
  check(
    calls.includes("fallbackRender") ||
      calls.some((call) => call[0] === "fallbackRender"),
    true,
    "legacy dismiss still rerenders"
  );

  const failed = RecoveryUI.createController({
    jobs: new Map([["bad", { id: "bad", status: "done" }]]),
    sendMessage: async () => ({ ok: false }),
    toast: (...args) => calls.push(["toast", ...args]),
    userError: (value) => String(value || ""),
    dismissUiJob: async () => ({ ok: false, error: "닫기 실패" }),
    renderDownloadQueue: () => {}
  });
  await failed.handleAction("dismiss", { jobId: "bad" });
  check(
    calls.some((call) => call[0] === "toast" && call[1] === "닫기 실패"),
    true,
    "failed persist surfaces an error toast"
  );

  console.log(`popup recovery UI: ${assertions} assertions passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
