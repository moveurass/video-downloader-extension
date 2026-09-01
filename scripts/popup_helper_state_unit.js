"use strict";

const assert = require("node:assert/strict");
const HelperState = require("../src/popup-helper-state.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    contains(name) {
      return values.has(name);
    },
    values
  };
}

function element(classes = []) {
  return { classList: classList(classes), textContent: "", value: "" };
}

function makeHarness() {
  const elements = {
    helperBar: element(["hidden"]),
    helperText: element(),
    btnHelperFix: element(["hidden"]),
    btnHelperStart: element(["hidden"]),
    btnHelperRecheck: element(["hidden"]),
    linkInput: element(),
    setHelperOutDir: element()
  };
  const intervals = [];
  const cleared = [];
  const messages = [];
  const toasts = [];
  const responses = [];
  let currentTabUrl = "";
  let allItems = [];

  const controller = HelperState.createController({
    $: (selector) => elements[selector.slice(1)] || null,
    helperBar: elements.helperBar,
    helperText: elements.helperText,
    isSitePage: (url) => url.startsWith("site:"),
    getCurrentTabUrl: () => currentTabUrl,
    getAllItems: () => allItems,
    sendMessage: async (message) => {
      messages.push(message);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    toast: (...args) => toasts.push(args),
    setInterval: (fn, ms) => {
      const timer = { id: intervals.length + 1, fn, ms };
      intervals.push(timer);
      return timer.id;
    },
    clearInterval: (id) => cleared.push(id)
  });

  return {
    controller,
    elements,
    intervals,
    cleared,
    messages,
    toasts,
    responses,
    setCurrentTabUrl(value) {
      currentTabUrl = value;
    },
    setAllItems(value) {
      allItems = value;
    }
  };
}

async function main() {
  const h = makeHarness();
  const c = h.controller;

  check(h.intervals.length, 0, "constructor does not start polling");
  check(h.messages.length, 0, "constructor does not check health");
  check(c.getHelperOk(), false, "helper starts disconnected");
  check(c.getHelperOutDirCache(), "", "outDir starts empty");

  c.setHelperOk(true);
  c.setHelperOutDirCache("/tmp/manual");
  check(c.getHelperOk(), true, "helper accessor is live");
  check(c.getHelperOutDirCache(), "/tmp/manual", "outDir accessor is live");
  c.updateHelperOutDirUi("");
  check(h.elements.setHelperOutDir.textContent, "/tmp/manual", "empty update keeps cache");

  c.startHelperPoll();
  c.startHelperPoll(8000);
  check(h.intervals.map((timer) => timer.ms), [2800], "poll start dedupes");
  c.stopHelperPoll();
  check(h.cleared, [1], "poll stop clears active timer");
  c.startHelperPoll(8000);
  check(h.intervals.map((timer) => timer.ms), [2800, 8000], "explicit slow cadence");

  c.setHelperOk(false);
  c.setHelperOutDirCache("");
  h.setCurrentTabUrl("site:video");
  h.responses.push({ ok: false, ytdlp: false });
  await c.refreshHelperStatus();
  check(h.messages.at(-1), { type: "YTDLP_HEALTH", force: false }, "health request");
  check(c.getHelperOk(), false, "failed health updates accessor");
  check(h.elements.helperBar.classList.contains("hidden"), false, "bar shown");
  check(h.elements.helperBar.classList.contains("warn"), true, "warning class");
  check(h.elements.helperBar.classList.contains("ok"), false, "no ok class");
  check(h.elements.helperText.textContent,
    "도우미 꺼짐 — 실행 파일 저장 후 더블클릭 (자동 재확인 중)",
    "warning text");
  check(h.elements.btnHelperFix.classList.contains("hidden"), false, "fix shown");
  check(h.elements.btnHelperStart.classList.contains("hidden"), false, "starter shown");
  check(h.elements.btnHelperRecheck.classList.contains("hidden"), false, "recheck shown");
  check(h.intervals.at(-1).ms, 2800, "failed health uses fast cadence");

  h.responses.push({
    ok: true,
    ytdlp: true,
    ytdlpVersion: "2026.08.31",
    outDir: "/Users/show/Downloads/VideoDownloader/"
  });
  await c.refreshHelperStatus(true);
  check(h.messages.at(-1), { type: "YTDLP_HEALTH", force: true }, "forced health request");
  check(c.getHelperOk(), true, "healthy response updates accessor");
  check(c.getHelperOutDirCache(), "/Users/show/Downloads/VideoDownloader/",
    "health updates outDir");
  check(h.elements.setHelperOutDir.textContent, "/Users/show/Downloads/VideoDownloader/",
    "health renders outDir");
  check(h.elements.helperBar.classList.contains("ok"), true, "ok class");
  check(h.elements.helperBar.classList.contains("warn"), false, "warning removed");
  check(h.elements.helperText.textContent,
    "도우미 준비됨 · yt-dlp 2026.08.31 · Downloads/VideoDownloader",
    "version and path text");
  check(h.elements.btnHelperFix.classList.contains("hidden"), true, "fix hidden");
  check(h.elements.btnHelperStart.classList.contains("hidden"), true, "starter hidden");
  check(h.elements.btnHelperRecheck.classList.contains("hidden"), true, "recheck hidden");
  check(h.intervals.at(-1).ms, 8000, "healthy response uses slow cadence");
  check(h.toasts.at(-1), ["도우미 연결됨 — YouTube 등 받기 가능", "ok"],
    "reconnect toast");

  h.setCurrentTabUrl("");
  const messageCount = h.messages.length;
  await c.refreshHelperStatus();
  check(h.messages.length, messageCount, "unneeded healthy check skips request");
  check(h.elements.helperBar.classList.contains("hidden"), true, "unneeded healthy bar hidden");

  h.setCurrentTabUrl("site:video");
  h.responses.push(new Error("offline"));
  await c.refreshHelperStatus(true);
  check(c.getHelperOk(), false, "transport error disconnects helper");
  check(h.elements.helperBar.classList.contains("warn"), true, "error warning class");
  check(h.elements.btnHelperFix.classList.contains("hidden"), false, "error controls shown");
  check(h.intervals.at(-1).ms, 2800, "transport error uses fast cadence");
  check(h.toasts.at(-1), ["도우미 연결이 끊겼습니다", "error"], "disconnect toast");
  check(h.elements.setHelperOutDir.textContent, "/Users/show/Downloads/VideoDownloader/",
    "disconnect preserves last outDir");

  c.setHelperOutDirCache("");
  c.updateHelperOutDirUi("");
  check(h.elements.setHelperOutDir.textContent,
    "도우미 꺼짐 — 실행 후 여기에 표시됩니다",
    "disconnected empty-path text");
  c.setHelperOk(true);
  c.updateHelperOutDirUi("");
  check(h.elements.setHelperOutDir.textContent, "연결됨 (경로 미보고)",
    "connected empty-path text");

  h.setAllItems([{ site: "youtube" }]);
  h.setCurrentTabUrl("");
  h.responses.push({ ok: true, ytdlp: true });
  const itemNeedMessageCount = h.messages.length;
  await c.refreshHelperStatus(true);
  check(h.messages.length, itemNeedMessageCount + 1, "site item requires health check");

  console.log(`popup helper state unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
