"use strict";

const assert = require("node:assert/strict");
const DuplicateConfirmation = require("../src/popup-duplicate-confirmation.js");
const SharedUVD = require("../src/uvd-common.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

function button() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    listenerCount(name) {
      return listeners.get(name)?.size || 0;
    },
    async click() {
      const pending = [...(listeners.get("click") || [])].map((listener) =>
        listener()
      );
      await Promise.all(pending);
    }
  };
}

function makeHarness(options = {}) {
  const calls = [];
  const modal = {
    classList: classList(["hidden"]),
    dataset: {}
  };
  const text = { textContent: "" };
  const meta = { textContent: "" };
  const forceButton = button();
  const cancelButton = button();
  const folderButton = button();
  const elements = {
    "#dupModal": options.withoutModal ? null : modal,
    "#dupModalText": text,
    "#dupModalMeta": meta,
    "#btnDupForce": forceButton,
    "#btnDupCancel": cancelButton,
    "#btnDupFolder": folderButton
  };
  const uiJobs = new Map(options.jobs || []);
  let settings = options.settings || { warnDuplicates: true };
  let duplicate = options.duplicate ?? null;

  const controller = DuplicateConfirmation.createController({
    $: (selector) => {
      calls.push(["$", selector]);
      return elements[selector] || null;
    },
    UVD: {
      ...SharedUVD,
      findDuplicateDone: async (url) => {
        calls.push(["findDuplicateDone", url]);
        if (duplicate instanceof Error) throw duplicate;
        return duplicate;
      }
    },
    uiJobs,
    toast: (...args) => calls.push(["toast", ...args]),
    formatTimeAgo: (at) => {
      calls.push(["formatTimeAgo", at]);
      return "3분 전";
    },
    sendMessage: async (message) => {
      calls.push(["sendMessage", message]);
      if (options.sendError) throw options.sendError;
      return { ok: true };
    },
    getUvdSettings: () => {
      calls.push(["getUvdSettings"]);
      return settings;
    }
  });

  return {
    ...controller,
    calls,
    modal,
    text,
    meta,
    forceButton,
    cancelButton,
    folderButton,
    setSettings: (value) => {
      settings = value;
    },
    setDuplicate: (value) => {
      duplicate = value;
    }
  };
}

function listenerCounts(harness) {
  return [
    harness.forceButton.listenerCount("click"),
    harness.cancelButton.listenerCount("click"),
    harness.folderButton.listenerCount("click")
  ];
}

async function main() {
  const bypass = makeHarness();
  check(bypass.calls, [], "constructor is side-effect free");
  check(
    await bypass.confirmNotDuplicate("https://example.com/video", {
      force: true
    }),
    true,
    "force bypasses duplicate checks"
  );
  check(
    bypass.calls.some((call) => call[0] === "findDuplicateDone"),
    false,
    "force bypass skips history lookup"
  );

  bypass.calls.length = 0;
  bypass.setSettings({ warnDuplicates: false });
  check(
    await bypass.confirmNotDuplicate("https://example.com/video"),
    true,
    "disabled warning bypasses duplicate checks"
  );
  check(
    bypass.calls.some((call) => call[0] === "findDuplicateDone"),
    false,
    "warning bypass skips history lookup"
  );

  bypass.calls.length = 0;
  bypass.setSettings({ warnDuplicates: true });
  check(await bypass.confirmNotDuplicate("file:///tmp/video"), true,
    "non-http URL bypasses duplicate checks");
  check(
    bypass.calls.some((call) => call[0] === "findDuplicateDone"),
    false,
    "invalid URL bypass skips history lookup"
  );

  const running = makeHarness({
    jobs: [[
      "job-1",
      {
        status: "running",
        pageUrl: "https://www.youtube.com/watch?v=abcdefghijk&t=10"
      }
    ]]
  });
  check(
    await running.confirmNotDuplicate(
      "https://youtu.be/abcdefghijk?utm_source=test"
    ),
    false,
    "normalized active URL is blocked"
  );
  check(
    running.calls.find((call) => call[0] === "toast"),
    ["toast", "이미 받는 중입니다", "ok"],
    "active URL shows the existing toast"
  );
  check(
    running.calls.some((call) => call[0] === "findDuplicateDone"),
    false,
    "active URL skips history lookup"
  );

  const lookupFailure = makeHarness({ duplicate: new Error("storage failed") });
  check(
    await lookupFailure.confirmNotDuplicate("https://example.com/video"),
    true,
    "history lookup failure proceeds silently"
  );
  check(
    lookupFailure.calls.filter((call) => call[0] === "findDuplicateDone").length,
    1,
    "history is looked up once"
  );

  const missing = makeHarness();
  check(
    await missing.confirmNotDuplicate("https://example.com/video"),
    true,
    "missing duplicate proceeds"
  );

  const duplicate = {
    at: 123,
    size: 2.25 * 1024 * 1024,
    title: "중복 영상 제목",
    filename: "saved.mp4",
    path: "/downloads/saved.mp4",
    downloadId: 37
  };
  const force = makeHarness({ duplicate });
  const forceResult = force.confirmNotDuplicate("https://example.com/video");
  await Promise.resolve();
  check(force.modal.classList.contains("hidden"), false, "modal is shown");
  check(
    force.text.textContent,
    "「중복 영상 제목」은(는) 이전에 저장했습니다.",
    "modal duplicate text is preserved"
  );
  check(
    force.meta.textContent,
    "3분 전 · 2.3MB · saved.mp4",
    "modal time, size, and filename are formatted"
  );
  check(force.modal.dataset, {
    path: "/downloads/saved.mp4",
    did: "37"
  }, "modal datasets are populated");
  check(listenerCounts(force), [1, 1, 1], "one listener is bound per action");
  await force.forceButton.click();
  check(await forceResult, true, "force action proceeds");
  check(force.modal.classList.contains("hidden"), true, "force hides modal");
  check(listenerCounts(force), [0, 0, 0], "force removes all listeners");
  await force.forceButton.click();
  check(listenerCounts(force), [0, 0, 0], "force listener is one-shot");

  const cancel = makeHarness({ duplicate });
  const cancelResult = cancel.confirmNotDuplicate("https://example.com/video");
  await Promise.resolve();
  await cancel.cancelButton.click();
  check(await cancelResult, false, "cancel action stops download");
  check(listenerCounts(cancel), [0, 0, 0], "cancel removes all listeners");

  const folder = makeHarness({
    duplicate,
    sendError: new Error("runtime unavailable")
  });
  const folderResult = folder.confirmNotDuplicate("https://example.com/video");
  await Promise.resolve();
  await folder.folderButton.click();
  check(await folderResult, false, "folder action stops download");
  check(
    folder.calls.find((call) => call[0] === "sendMessage"),
    ["sendMessage", {
      type: "SHOW_DOWNLOAD",
      downloadId: 37,
      path: "/downloads/saved.mp4"
    }],
    "folder action sends the preserved payload"
  );
  check(
    listenerCounts(folder),
    [0, 0, 0],
    "folder failure is silent and removes all listeners"
  );

  const noModal = makeHarness({ duplicate, withoutModal: true });
  check(
    await noModal.confirmNotDuplicate("https://example.com/video"),
    true,
    "missing modal proceeds"
  );
  check(listenerCounts(noModal), [0, 0, 0], "missing modal binds no listeners");

  console.log(
    `popup duplicate confirmation unit: ${assertions} assertions passed`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
