"use strict";

const assert = require("node:assert/strict");
const QualityState = require("../src/popup-quality-state.js");
const PopupMedia = require("../src/popup-media.js");

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

function makeChipsRoot() {
  let html = "";
  let buttons = [];
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      buttons = [...value.matchAll(/<button[^>]*data-quality="([^"]+)"[^>]*>/g)]
        .map((match) => {
          const listeners = {};
          return {
            disabled: /\sdisabled(?:\s|>)/.test(match[0]),
            getAttribute: (name) =>
              name === "data-quality" ? match[1] : null,
            addEventListener: (name, fn) => {
              listeners[name] = fn;
            },
            click: () => listeners.click?.()
          };
        });
    },
    querySelectorAll: () => buttons,
    buttons: () => buttons
  };
}

function makeHarness() {
  const qualityBox = { classList: classList(["hidden"]) };
  const chipsRoot = makeChipsRoot();
  const runtimeMessages = [];
  const tabMessages = [];
  const runtimeResponses = [];
  const tabResponses = [];
  let currentTabId = 42;
  let currentTabUrl = "https://example.com/watch";
  let allItems = [];
  let settings = {};

  const controller = QualityState.createController({
    UVDPopupMedia: PopupMedia,
    UVD: {
      qualityForSite: (value, url) => value.siteQuality?.[url] || ""
    },
    $: (selector) =>
      selector === "#qualityBox"
        ? qualityBox
        : selector === "#globalQualityChips"
          ? chipsRoot
          : null,
    getCurrentTabId: () => currentTabId,
    getCurrentTabUrl: () => currentTabUrl,
    getAllItems: () => allItems,
    setAllItems: (value) => {
      allItems = value;
    },
    getUvdSettings: () => settings,
    isDownloadableSiteVideo: (url) => /social\.example/.test(url || ""),
    isSitePage: (url) => /social\.example/.test(url || ""),
    sendRuntimeMessage: async (message) => {
      runtimeMessages.push(message);
      const response = runtimeResponses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sendTabMessage: async (tabId, message) => {
      tabMessages.push({ tabId, message });
      const response = tabResponses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    getDocumentTitle: () => "",
    siteLabel: () => "Example",
    escapeHtml: (value) => String(value),
    escapeAttr: (value) => String(value)
  });

  return {
    controller,
    qualityBox,
    chipsRoot,
    runtimeMessages,
    runtimeResponses,
    tabMessages,
    tabResponses,
    setCurrentTabUrl: (value) => {
      currentTabUrl = value;
    },
    setAllItems: (value) => {
      allItems = value;
    },
    getAllItems: () => allItems,
    setSettings: (value) => {
      settings = value;
    }
  };
}

async function main() {
  const h = makeHarness();
  const c = h.controller;

  check(h.runtimeMessages.length, 0, "constructor has no runtime side effect");
  check(h.tabMessages.length, 0, "constructor has no tab side effect");
  check(c.getSelectedQuality(), "best", "initial selection");
  check(
    c.getAvailableQualities().map((q) => q.id),
    ["best", "4K", "1080p", "720p", "480p"],
    "initial quality choices"
  );
  check(c.getQualitiesLoading(), false, "initial loading state");

  c.setSelectedQuality("720p");
  c.setAvailableQualities([{ id: "720p", label: "720p" }]);
  c.setQualitiesLoading(true);
  check(c.getSelectedQuality(), "720p", "selected accessor is live");
  check(c.getAvailableQualities()[0].id, "720p", "qualities accessor is live");
  check(c.getQualitiesLoading(), true, "loading accessor is live");

  check(
    c.qualityFromMediaUrl("https://cdn.example/video_1080p.m3u8"),
    { id: "1080p", label: "1080p", height: 1080 },
    "quality inferred from URL"
  );
  check(
    c.qualityFromMediaUrl("https://cdn.example/video.mp4?height=2160"),
    { id: "4K", label: "4K", height: 2160 },
    "quality inferred from query"
  );
  check(c.qualityFromMediaUrl("https://cdn.example/video.m3u8"), null,
    "unknown URL has no inferred quality");

  h.tabResponses.push({ height: 720, quality: "best" });
  check(
    await c.fetchPlayerHeight(42),
    { id: "720p", label: "720p", height: 720 },
    "player height maps to quality"
  );
  check(
    h.tabMessages.at(-1),
    { tabId: 42, message: { type: "GET_PLAYER_HEIGHT" } },
    "player request payload"
  );

  c.setAvailableQualities([{ id: "480p", label: "480p", height: 480 }]);
  c.applySiteDefaultQuality("https://example.com/watch");
  check(c.getSelectedQuality(), "480p", "single concrete quality auto-selected");
  c.setAvailableQualities([
    { id: "best", label: "최고" },
    { id: "720p", label: "720p", height: 720 },
    { id: "480p", label: "480p", height: 480 }
  ]);
  c.applySiteDefaultQuality("https://example.com/watch");
  check(c.getSelectedQuality(), "best", "multiple choices prefer best");

  h.setCurrentTabUrl("https://social.example/video/1");
  h.setAllItems([{ title: "YouTube", url: "https://cdn.example/720p.mp4" }]);
  h.runtimeResponses.push({
    ok: true,
    qualities: [
      { id: "1080p", label: "1080p", height: 1080 },
      { id: "720p", label: "720p", height: 720 }
    ],
    duration: 90,
    estimatedSize: 10485760,
    title: "Resolved title",
    thumbnail: "https://img.example/thumb.jpg"
  });
  await c.loadAvailableQualities(h.getAllItems()[0]);
  check(h.runtimeMessages.at(-1), {
    type: "LIST_QUALITIES",
    url: "https://cdn.example/720p.mp4",
    pageUrl: "https://social.example/video/1",
    tabId: 42,
    mediaType: undefined,
    itemHeight: 720,
    itemQuality: "720p",
    forceYtDlp: true
  }, "quality probe payload");
  check(
    c.getAvailableQualities().map((q) => q.id),
    ["best", "1080p", "720p"],
    "probe results preserve normalized ordering"
  );
  check(c.getSelectedQuality(), "best", "probe selection default");
  check(c.getQualitiesLoading(), false, "probe clears loading");
  check(
    {
      title: h.getAllItems()[0].title,
      duration: h.getAllItems()[0].duration,
      height: h.getAllItems()[0].height,
      quality: h.getAllItems()[0].quality,
      thumbnail: h.getAllItems()[0].thumbnail
    },
    {
      title: "Resolved title",
      duration: 90,
      height: 1080,
      quality: "1080p",
      thumbnail: "https://img.example/thumb.jpg"
    },
    "probe metadata patches card item"
  );

  h.runtimeResponses.push(new Error("offline"));
  h.tabResponses.push(null, null);
  h.setAllItems([{ url: "https://cdn.example/video.mp4" }]);
  await c.loadAvailableQualities(h.getAllItems()[0]);
  check(
    c.getAvailableQualities(),
    [{ id: "best", label: "최고" }],
    "probe failure falls back to bare best"
  );

  c.setAvailableQualities([
    { id: "best", label: "최고" },
    { id: "720p", label: "720p", height: 720 },
    { id: "480p", label: "480p", height: 480 }
  ]);
  c.setSelectedQuality("best");
  c.setQualitiesLoading(false);
  c.syncGlobalQualityBox(false);
  check(h.qualityBox.classList.contains("hidden"), false, "global chips shown");
  check(h.chipsRoot.buttons().length, 3, "global chips rendered");
  h.chipsRoot.buttons()[1].click();
  check(c.getSelectedQuality(), "720p", "chip click updates live selection");
  check(/q-chip active[^>]*data-quality="720p"/.test(h.chipsRoot.innerHTML), true,
    "chip click rerenders active class");

  c.syncGlobalQualityBox(true);
  check(h.qualityBox.classList.contains("hidden"), true, "card picker hides global chips");

  check(QualityState.heightToQualityId(1440), "1440p", "quality alias exported");
  check(QualityState.formatMb(5 * 1024 * 1024), "5.0MB", "format alias exported");

  console.log(`popup quality state unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
