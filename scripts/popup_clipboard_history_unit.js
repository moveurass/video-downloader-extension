"use strict";

const assert = require("node:assert/strict");
const PopupClipboardHistory = require("../src/popup-clipboard-history.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    values,
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    }
  };
}

function element(extra = {}) {
  return {
    value: "",
    textContent: "",
    title: "",
    innerHTML: "",
    dataset: {},
    classList: classList(["hidden"]),
    listeners: {},
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    getAttribute(name) {
      return this.attributes?.[name] ?? null;
    },
    ...extra
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const elements = {
    clipBanner: element(),
    clipBannerUrl: element({ textContent: "—" }),
    linkInput: element(),
    libSite: element(),
    libSeries: element(),
    btnRetryFailed: element(),
    recentStrip: element(),
    recentList: element(),
    historyList: element()
  };
  const state = {
    settings: { clipboardWatch: false },
    currentTabUrl: "",
    historyItems: [],
    libFilter: { q: "", status: "done", site: "", series: "" },
    lastSeriesRun: null,
    currentTabId: 17,
    selectedQuality: "1080p",
    seriesPending: null
  };
  const clipboard = { reads: [], error: null };
  const timers = [];
  const cleared = [];
  const message = async (payload) => {
    calls.push(["sendMessage", payload]);
    if (overrides.sendMessage) return overrides.sendMessage(payload);
    if (payload.type === "GET_RECENT_DONE") return { items: [] };
    if (payload.type === "GET_HISTORY") return { history: [] };
    return { ok: true, items: [] };
  };
  const fn = (name, implementation) => (...args) => {
    calls.push([name, ...args]);
    return implementation?.(...args);
  };
  const setState = (key) => (value) => {
    calls.push([`set:${key}`, value]);
    state[key] = value;
  };
  const UVD = {
    parseUrlsFromText(text) {
      return String(text || "")
        .split(/\s+/)
        .filter((value) => /^https?:/.test(value));
    },
    isPlaylistUrl: (url) => url.includes("playlist"),
    queryLibrary: async () => [],
    getHistory: async () => [],
    getRecentDone: async () => [],
    getFailedRetryable: async () => [],
    ...overrides.UVD
  };
  const isSupported = (url) => /supported|youtube|multi/.test(url);
  const deps = {
    $: (selector) => elements[selector.slice(1)] || null,
    navigator: {
      clipboard: {
        async readText() {
          calls.push(["readText"]);
          if (clipboard.error) throw clipboard.error;
          return clipboard.reads.shift() || "";
        }
      }
    },
    setInterval(callback, ms) {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
    sendMessage: message,
    UVD,
    UVDPopupLibraryUI: {
      filterValues: (items) => ({
        sites: items.map((item) => item.site).filter(Boolean),
        series: items.map((item) => item.seriesPrefix).filter(Boolean)
      }),
      filterOptions: (values, current, label) =>
        `${label}|${current}|${values.join(",")}`,
      renderHistory: (items) => `history:${items.length}`
    },
    isYoutubeUrl: isSupported,
    isTiktokUrl: isSupported,
    isInstagramUrl: isSupported,
    isXUrl: isSupported,
    isFacebookUrl: isSupported,
    isBilibiliUrl: isSupported,
    isSitePage: (url) => url.includes("site-page"),
    pageKey: (url) => url.replace(/[?#].*$/, ""),
    normalizePastedUrl: (value) =>
      value === "raw-supported" ? "https://supported.example/video" : value,
    updateLinkCount: fn("updateLinkCount"),
    escapeHtml: (value) => `H(${value})`,
    escapeAttr: (value) => `A(${value})`,
    formatTimeAgo: () => "방금",
    bindRecoveryButtons: fn("bindRecoveryButtons"),
    updateSeriesRetryButton: fn(
      "updateSeriesRetryButton",
      async () => undefined
    ),
    retrySeriesFailed: fn("retrySeriesFailed", async () => undefined),
    switchTab: fn("switchTab"),
    offerSeriesComplete: fn("offerSeriesComplete", async () => undefined),
    toast: fn("toast"),
    refreshHelperStatus: fn("refreshHelperStatus", async () => undefined),
    ensureQueuePoll: fn("ensureQueuePoll"),
    refreshJobsFromBackground: fn(
      "refreshJobsFromBackground",
      async () => undefined
    ),
    downloadByPastedLink: fn(
      "downloadByPastedLink",
      async () => undefined
    ),
    userError: (value) => `friendly:${value}`,
    maxConcurrentStarts: 2,
    getUvdSettings: () => state.settings,
    setUvdSettings: setState("settings"),
    getCurrentTabUrl: () => state.currentTabUrl,
    setCurrentTabUrl: setState("currentTabUrl"),
    getHistoryItems: () => state.historyItems,
    setHistoryItems: setState("historyItems"),
    getLibFilter: () => state.libFilter,
    setLibFilter: setState("libFilter"),
    getLastSeriesRun: () => state.lastSeriesRun,
    setLastSeriesRun: setState("lastSeriesRun"),
    getCurrentTabId: () => state.currentTabId,
    setCurrentTabId: setState("currentTabId"),
    getSelectedQuality: () => state.selectedQuality,
    setSelectedQuality: setState("selectedQuality"),
    getSeriesPending: () => state.seriesPending,
    setSeriesPending: setState("seriesPending"),
    ...overrides.deps
  };
  const controller = PopupClipboardHistory.createController(deps);
  return {
    calls,
    elements,
    state,
    clipboard,
    timers,
    cleared,
    UVD,
    controller
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  check(typeof PopupClipboardHistory.createController, "function");

  {
    const h = makeHarness();
    check(
      [
        "setupClipboardWatch",
        "autofillOnce",
        "loadHistoryUi",
        "loadRecentStrip",
        "retryFailedDownloads",
        "renderHistory",
        "dismissClipboard"
      ].map((name) => typeof h.controller[name]),
      Array(7).fill("function")
    );
    h.controller.setClipWatchTimer("old-timer");
    h.controller.setupClipboardWatch();
    check(h.cleared, ["old-timer"]);
    check(h.elements.clipBanner.classList.values.has("hidden"), true);
    check(h.timers.length, 0);
  }

  {
    const h = makeHarness();
    h.state.settings.clipboardWatch = true;
    h.clipboard.reads.push("https://supported.example/video");
    h.controller.setupClipboardWatch();
    await flush();
    check(h.timers.map((timer) => timer.ms), [2500]);
    check(h.controller.getLastClipSeen(), "https://supported.example/video");
    check(h.elements.clipBannerUrl.textContent, "https://supported.example/video");
    check(h.elements.clipBanner.dataset.url, "https://supported.example/video");
    check(h.elements.clipBanner.classList.values.has("hidden"), false);

    h.controller.dismissClipboard("");
    check(h.controller.getDismissedClip(), "https://supported.example/video");
    check(h.elements.clipBanner.classList.values.has("hidden"), true);
    h.clipboard.reads.push("https://supported.example/video");
    await h.controller.pollClipboardOnce();
    check(h.calls.filter(([name]) => name === "readText").length, 2);
  }

  {
    const h = makeHarness();
    h.state.settings.clipboardWatch = true;
    h.state.currentTabUrl = "https://supported.example/video?tab=1";
    h.clipboard.reads.push("https://supported.example/video#clip");
    await h.controller.pollClipboardOnce();
    check(h.controller.getLastClipSeen(), "");
    h.state.currentTabUrl = "";
    h.elements.linkInput.value = "prefix https://supported.example/input suffix";
    h.clipboard.reads.push("https://supported.example/input");
    await h.controller.pollClipboardOnce();
    check(h.controller.getLastClipSeen(), "");
    h.clipboard.error = new Error("denied");
    await h.controller.pollClipboardOnce();
    check(h.controller.getLastClipSeen(), "");
  }

  {
    const h = makeHarness();
    h.clipboard.reads.push(
      "https://multi.example/one https://multi.example/two"
    );
    await h.controller.autofillOnce();
    check(
      h.elements.linkInput.value,
      "https://multi.example/one\nhttps://multi.example/two"
    );
    check(h.calls.at(-1), ["updateLinkCount"]);

    h.elements.linkInput.value = "";
    h.clipboard.reads.push("raw-supported");
    await h.controller.autofillOnce();
    check(h.elements.linkInput.value, "https://supported.example/video");
    h.state.settings.clipboardWatch = true;
    h.elements.linkInput.value = "";
    await h.controller.autofillOnce();
    check(h.calls.filter(([name]) => name === "readText").length, 2);
  }

  {
    const library = [
      { id: 1, site: "youtube", seriesPrefix: "ABC" },
      { id: 2, status: "error", pageUrl: "https://failed.example" }
    ];
    const h = makeHarness({
      sendMessage: async (payload) =>
        payload.type === "QUERY_LIBRARY"
          ? { ok: true, items: library }
          : { history: library }
    });
    h.state.libFilter = { q: "term", status: "", site: "", series: "" };
    await h.controller.loadHistoryUi();
    await flush();
    check(h.calls[0], [
      "sendMessage",
      {
        type: "QUERY_LIBRARY",
        query: { q: "term", status: "done", site: "", series: "" }
      }
    ]);
    check(h.state.historyItems, library);
    check(h.elements.libSite.innerHTML, "모든 사이트||youtube");
    check(h.elements.libSeries.innerHTML, "모든 시리즈||ABC");
    check(h.elements.historyList.innerHTML, "history:2");
    check(h.elements.btnRetryFailed.textContent, "실패 재시도 · 1");
  }

  {
    const fallback = [{ id: "local" }];
    let queryCalls = 0;
    const h = makeHarness({
      sendMessage: async () => {
        throw new Error("runtime down");
      },
      UVD: {
        queryLibrary: async () => {
          queryCalls += 1;
          throw new Error("query down");
        },
        getHistory: async () => fallback
      }
    });
    await h.controller.loadHistoryUi();
    await flush();
    check(queryCalls, 1);
    check(h.state.historyItems, fallback);
  }

  {
    const h = makeHarness({
      sendMessage: async (payload) => {
        if (payload.type === "GET_RECENT_DONE") {
          return {
            items: [
              {
                title: "Recent title",
                path: "/tmp/file.mp4",
                downloadId: 9
              }
            ]
          };
        }
        return { history: [] };
      }
    });
    await h.controller.loadRecentStrip();
    check(h.elements.recentStrip.classList.values.has("hidden"), false);
    check(h.elements.recentList.innerHTML.includes("H(Recent title)"), true);
    check(h.elements.recentList.innerHTML.includes("A(/tmp/file.mp4)"), true);
    check(h.calls.at(-1), ["bindRecoveryButtons", h.elements.recentList]);
  }

  {
    const h = makeHarness({
      UVD: {
        getFailedRetryable: async () => [
          { pageUrl: "https://failed.example/1" },
          { url: "https://failed.example/2" },
          { url: "https://failed.example/3" }
        ]
      },
      sendMessage: async (payload) =>
        payload.type === "DOWNLOAD_BATCH" ? { ok: false } : {}
    });
    await h.controller.retryFailedDownloads();
    check(h.calls.slice(0, 3), [
      ["switchTab", "main"],
      ["toast", "3개 실패 항목 재시도 중…", "ok"],
      ["refreshHelperStatus", true]
    ]);
    check(
      h.calls.find(([name]) => name === "sendMessage"),
      [
        "sendMessage",
        {
          type: "DOWNLOAD_BATCH",
          urls: [
            "https://failed.example/1",
            "https://failed.example/2"
          ],
          tabId: 17,
          preferQuality: "1080p"
        }
      ]
    );
    check(
      h.calls.filter(([name]) => name === "downloadByPastedLink"),
      [
        [
          "downloadByPastedLink",
          "https://failed.example/1",
          { skipDupCheck: true }
        ],
        [
          "downloadByPastedLink",
          "https://failed.example/2",
          { skipDupCheck: true }
        ]
      ]
    );
  }

  {
    const h = makeHarness();
    h.state.lastSeriesRun = { seriesId: "SERIES" };
    h.elements.btnRetryFailed.dataset.seriesRetry = "1";
    await h.controller.retryFailedDownloads();
    check(h.calls, [["retrySeriesFailed"]]);

    h.state.historyItems = [
      { status: "error", pageUrl: "https://failed", seriesId: "SERIES" },
      { status: "error", url: "https://other", tags: ["SERIES"] }
    ];
    h.controller.updateRetryFailedButton();
    await flush();
    check(h.elements.btnRetryFailed.textContent, "시리즈 실패 · 2");
    check(h.elements.btnRetryFailed.dataset.seriesRetry, "1");
    check(
      h.calls.some(([name]) => name === "updateSeriesRetryButton"),
      true
    );
  }

  {
    const seriesButton = element({
      attributes: {
        "data-title": "Series",
        "data-url": "https://series.example"
      }
    });
    const h = makeHarness();
    h.elements.historyList.querySelectorAll = () => [seriesButton];
    h.state.historyItems = [{ id: 1 }];
    h.controller.renderHistory();
    await seriesButton.listeners.click[0]();
    check(h.calls.slice(-3), [
      ["switchTab", "main"],
      ["offerSeriesComplete", "Series", "https://series.example"],
      [
        "toast",
        "시리즈 목록을 만들지 못했습니다. 제목에 품번이 있거나 재생목록이어야 합니다",
        "error"
      ]
    ]);
  }

  console.log(`popup clipboard/history: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
