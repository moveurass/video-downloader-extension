"use strict";

const assert = require("node:assert/strict");
const Flow = require("../src/popup-series-watchlist-flow.js");
const WatchlistUI = require("../src/popup-watchlist-ui.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList() {
  const values = new Set();
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

function element(attributes = {}) {
  return {
    value: "",
    textContent: "",
    title: "",
    disabled: false,
    innerHTML: "",
    classList: classList(),
    listeners: {},
    attributes,
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const retryButton = element();
  const seriesButton = element();
  const linkInput = element();
  const watchRoot = element();
  watchRoot.actions = [];
  watchRoot.rows = [];
  watchRoot.querySelectorAll = (selector) =>
    selector === "[data-act]" ? watchRoot.actions : watchRoot.rows;
  const elements = {
    btnSeriesRetryFailed: retryButton,
    btnSeriesGo: seriesButton,
    linkInput,
    watchList: watchRoot
  };
  const state = {
    seriesPending: null,
    lastSeriesRun: null,
    historyItems: [],
    currentTabId: 41,
    selectedQuality: "1080p",
    watchlistItems: [],
    allItems: [],
    currentTabUrl: "",
    activeTabName: "main"
  };
  const setters = (key) => (value) => {
    calls.push([`set:${key}`, value]);
    state[key] = value;
  };
  const fn = (name, implementation) => (...args) => {
    calls.push([name, ...args]);
    return implementation?.(...args);
  };
  const sendMessage = async (payload) => {
    calls.push(["sendMessage", payload]);
    if (overrides.sendMessage) return overrides.sendMessage(payload, calls);
    if (payload.type === "GET_WATCHLIST") {
      return { watchlist: state.watchlistItems };
    }
    return { ok: true };
  };
  const siteMatcher = (url) =>
    /youtube|youtu\.be|tiktok|instagram|x\.com|facebook|bilibili/.test(
      String(url)
    );
  const UVD = {
    getFailedRetryable: async () => [],
    getWatchlist: async () => [],
    parseUrlsFromText: (text) =>
      String(text || "").match(/https?:\/\/\S+/g) || [],
    isPlaylistUrl: (url) => String(url).includes("list="),
    extractSeriesInfo: (value) =>
      String(value).includes("SER") ? { prefix: "SER" } : null,
    siteFromUrl: (url) => new global.URL(url).hostname,
    ...overrides.UVD
  };
  const deps = {
    $: (selector) => elements[selector.slice(1)] || null,
    document: { title: "Popup title" },
    URL: global.URL,
    sendMessage,
    UVD,
    UVDPopupWatchlistUI: WatchlistUI,
    isDownloadableSiteVideo: siteMatcher,
    isYoutubeUrl: siteMatcher,
    isTiktokUrl: siteMatcher,
    isInstagramHost: (url) => /instagram/.test(url),
    isInstagramPostUrl: (url) => /\/(p|reel)\//.test(url),
    isInstagramUrl: siteMatcher,
    isXUrl: siteMatcher,
    isFacebookUrl: siteMatcher,
    isBilibiliUrl: siteMatcher,
    isSitePage: siteMatcher,
    resolveSeriesIdFromPayload: () => "resolved-series",
    normalizePastedUrl: (url) =>
      String(url).startsWith("youtube.com")
        ? `https://${url}`
        : String(url || ""),
    fnameBaseFromLink: () => "link-title",
    cleanTitleText: (value) => String(value || "").trim(),
    pageKey: (url) => String(url).replace(/[?#].*$/, ""),
    isHlsItem: (item) => /\.m3u8/.test(item?.url || ""),
    looksLikeDirectMedia: (url) => /\.mp4(?:$|\?)/.test(url),
    formatTimeAgo: () => "방금",
    escapeHtml: String,
    escapeAttr: String,
    downloadByPastedLink: fn(
      "downloadByPastedLink",
      overrides.downloadByPastedLink
    ),
    refreshHelperStatus: fn("refreshHelperStatus", async () => {}),
    ensureQueuePoll: fn("ensureQueuePoll"),
    refreshJobsFromBackground: fn(
      "refreshJobsFromBackground",
      async () => {}
    ),
    switchTab: fn("switchTab"),
    hideSeriesBanner: fn("hideSeriesBanner"),
    updateSeriesGoButton: fn("updateSeriesGoButton"),
    toast: fn("toast"),
    userError: (error) => `friendly:${error}`,
    maxConcurrentStarts: 2,
    getSeriesPending: () => state.seriesPending,
    setSeriesPending: setters("seriesPending"),
    getLastSeriesRun: () => state.lastSeriesRun,
    setLastSeriesRun: setters("lastSeriesRun"),
    getHistoryItems: () => state.historyItems,
    setHistoryItems: setters("historyItems"),
    getCurrentTabId: () => state.currentTabId,
    setCurrentTabId: setters("currentTabId"),
    getSelectedQuality: () => state.selectedQuality,
    setSelectedQuality: setters("selectedQuality"),
    getWatchlistItems: () => state.watchlistItems,
    setWatchlistItems: setters("watchlistItems"),
    getAllItems: () => state.allItems,
    setAllItems: setters("allItems"),
    getCurrentTabUrl: () => state.currentTabUrl,
    setCurrentTabUrl: setters("currentTabUrl"),
    getActiveTabName: () => state.activeTabName,
    setActiveTabName: setters("activeTabName"),
    ...overrides.deps
  };
  const controller = Flow.createController(deps);
  return { calls, elements, state, UVD, controller };
}

async function main() {
  check(typeof Flow.createController, "function");
  {
    const h = makeHarness();
    check(h.calls, [], "construction must not invoke dependencies");
    check(
      [
        "updateSeriesRetryButton",
        "retrySeriesFailed",
        "runSeriesComplete",
        "loadWatchlistUi",
        "renderWatchlist",
        "downloadWatchSeriesGroup",
        "removeWatchSeriesGroup",
        "isWatchlistableUrl",
        "resolveWatchlistUrl",
        "addCurrentToWatchlist",
        "downloadAllWatchlist"
      ].map((name) => typeof h.controller[name]),
      Array(11).fill("function")
    );
  }

  {
    const h = makeHarness({
      UVD: {
        getFailedRetryable: async () => {
          throw new Error("local fallback");
        }
      }
    });
    h.state.seriesPending = { seriesId: "SER-1" };
    h.state.historyItems = [
      { status: "error", seriesId: "SER-1" },
      { status: "error", tags: ["SER-1"] },
      { status: "done", seriesId: "SER-1" }
    ];
    await h.controller.updateSeriesRetryButton();
    check(h.elements.btnSeriesRetryFailed.textContent, "실패 재시도 · 2");
    check(h.elements.btnSeriesRetryFailed.title, "이 시리즈 실패 2편 다시 받기");
  }

  {
    const failed = Array.from({ length: 22 }, (_, index) => ({
      pageUrl: `https://failed.example/${index}`
    }));
    const h = makeHarness({
      UVD: { getFailedRetryable: async () => failed },
      sendMessage: async (payload) =>
        payload.type === "DOWNLOAD_BATCH" ? { ok: true, count: 20 } : {}
    });
    h.state.lastSeriesRun = { seriesId: "SER-2" };
    await h.controller.retrySeriesFailed();
    const batch = h.calls.find(
      ([name, payload]) =>
        name === "sendMessage" && payload.type === "DOWNLOAD_BATCH"
    )[1];
    check(batch.urls.length, 20);
    check(batch.tabId, 41);
    check(batch.preferQuality, "1080p");
    check(
      h.calls.some(([name]) => name === "refreshJobsFromBackground"),
      true
    );
  }

  {
    const h = makeHarness({
      sendMessage: async (payload) =>
        payload.type === "SERIES_COMPLETE"
          ? { ok: true, mode: "playlist", queued: 2, seriesId: "server-id" }
          : { watchlist: [] }
    });
    h.state.seriesPending = {
      mode: "playlist",
      title: "Playlist",
      pageUrl: "https://youtube.example/list",
      items: [
        {
          title: "One",
          url: "https://video/1",
          key: "k1",
          id: "id1",
          seriesIndex: 7,
          thumbnail: "thumb",
          downloaded: true
        },
        { title: "Skip", url: "https://video/skip", selected: false },
        { title: "Two", url: "https://video/2", id: "id2" }
      ]
    };
    await h.controller.runSeriesComplete();
    const payload = h.calls.find(
      ([name, value]) =>
        name === "sendMessage" && value.type === "SERIES_COMPLETE"
    )[1];
    check(payload.count, 2);
    check(payload.entries, [
      {
        title: "One",
        url: "https://video/1",
        key: "k1",
        id: "id1",
        seriesIndex: 7,
        thumbnail: "thumb"
      },
      {
        title: "Two",
        url: "https://video/2",
        key: "id2",
        id: "id2",
        seriesIndex: 2,
        thumbnail: ""
      }
    ]);
    check(h.state.lastSeriesRun.seriesId, "server-id");
    check(h.elements.btnSeriesGo.disabled, false);
    check(
      h.calls.some(([name]) => name === "updateSeriesGoButton"),
      true
    );
  }

  {
    const scheduled = element({
      "data-act": "watch-sched",
      "data-id": "watch-1"
    });
    scheduled.value = "clear";
    const first = element({ "data-watch-id": "a" });
    const second = element({ "data-watch-id": "b" });
    const h = makeHarness({
      sendMessage: async (payload) => {
        if (payload.type === "REORDER_WATCHLIST") return null;
        if (payload.type === "GET_WATCHLIST") {
          return { watchlist: h.state.watchlistItems };
        }
        return { ok: true };
      }
    });
    h.state.watchlistItems = [
      { id: "a", url: "https://a.example" },
      { id: "b", url: "https://b.example" }
    ];
    h.elements.watchList.actions = [scheduled];
    h.elements.watchList.rows = [first, second];
    h.controller.renderWatchlist();
    await scheduled.listeners.change[0]();
    check(
      h.calls.find(
        ([name, payload]) =>
          name === "sendMessage" &&
          payload.type === "UPDATE_WATCHLIST_ITEM"
      )[1],
      {
        type: "UPDATE_WATCHLIST_ITEM",
        id: "watch-1",
        patch: { scheduleAt: 0, scheduleLabel: "" }
      }
    );
    first.listeners.dragstart[0]({
      dataTransfer: { setData() {}, effectAllowed: "" }
    });
    await second.listeners.drop[0]({ preventDefault() {} });
    check(h.state.watchlistItems.map((item) => item.id), ["b", "a"]);
  }

  {
    const h = makeHarness({
      downloadByPastedLink: async (url) => {
        if (url.endsWith("/1")) throw new Error("continue");
      },
      sendMessage: async (payload) =>
        payload.type === "GET_WATCHLIST" ? { watchlist: [] } : { ok: true }
    });
    h.state.watchlistItems = [
      { id: "1", url: "https://series.example/1", seriesId: "group" },
      { id: "2", url: "https://series.example/2", seriesId: "group" }
    ];
    await h.controller.downloadWatchSeriesGroup("group");
    check(
      h.calls.filter(([name]) => name === "downloadByPastedLink").map((call) => call[1]),
      ["https://series.example/1", "https://series.example/2"]
    );
    check(
      h.calls.filter(
        ([name, payload]) =>
          name === "sendMessage" && payload.type === "REMOVE_WATCHLIST"
      ).map((call) => call[1].id),
      ["2"]
    );
  }

  {
    const h = makeHarness();
    h.elements.linkInput.value = "https://cdn.example/raw.m3u8";
    h.state.allItems = [
      {
        pageUrl: "https://youtube.example/watch?v=page",
        url: "https://cdn.example/stream.m3u8",
        title: "Captured",
        thumbnail: "thumb"
      }
    ];
    h.state.currentTabUrl = "https://youtube.example/watch?v=tab";
    check(
      h.controller.resolveWatchlistUrl("https://cdn.example/forced.mp4"),
      "https://youtube.example/watch?v=page"
    );
    check(h.controller.isWatchlistableUrl("youtube.com/watch?v=1"), true);
    check(h.controller.isWatchlistableUrl("http://localhost/video"), false);
    await h.controller.addCurrentToWatchlist(
      "https://youtube.example/watch?v=page"
    );
    const added = h.calls.find(
      ([name, payload]) =>
        name === "sendMessage" && payload.type === "ADD_WATCHLIST"
    )[1].item;
    check(added.mediaUrl, "https://cdn.example/stream.m3u8");
    check(added.pageUrl, "https://youtube.example/watch?v=page");
    check(added.quality, "1080p");

    const before = h.calls.length;
    await h.controller.addCurrentToWatchlist(
      "https://instagram.com/profile"
    );
    check(
      h.calls.slice(before).some(
        ([name, message]) =>
          name === "toast" && message.includes("게시물·릴스")
      ),
      true
    );
  }

  {
    const h = makeHarness({
      sendMessage: async (payload) => {
        if (payload.type === "DOWNLOAD_BATCH") return { ok: true, count: 1 };
        if (payload.type === "GET_WATCHLIST") return { watchlist: [] };
        return { ok: true };
      }
    });
    h.state.watchlistItems = [
      { id: "a", url: "https://watch.example/a" },
      { id: "b", url: "https://watch.example/b" },
      { id: "c", url: "https://watch.example/c" }
    ];
    await h.controller.downloadAllWatchlist();
    const batch = h.calls.find(
      ([name, payload]) =>
        name === "sendMessage" && payload.type === "DOWNLOAD_BATCH"
    )[1];
    check(batch.urls, [
      "https://watch.example/a",
      "https://watch.example/b"
    ]);
    check(
      h.calls.find(
        ([name, payload]) =>
          name === "sendMessage" && payload.type === "REMOVE_WATCHLIST"
      )[1].id,
      "https://watch.example/a"
    );
  }

  console.log(`popup series/watchlist flow: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
