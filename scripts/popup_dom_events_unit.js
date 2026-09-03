"use strict";

const assert = require("node:assert/strict");
const PopupDomEvents = require("../src/popup-dom-events.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function element(attributes = {}) {
  const listeners = {};
  return {
    value: "",
    textContent: "",
    dataset: {},
    ...attributes,
    listeners,
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    async emit(type, event = {}) {
      for (const handler of listeners[type] || []) await handler(event);
    }
  };
}

function makeHarness(options = {}) {
  const calls = [];
  const ids = [
    "btnScan",
    "btnClear",
    "btnLinkDl",
    "btnThisPage",
    "linkInput",
    "btnSaveSettings",
    "setTemplate",
    "setSubfolder",
    "setMediaMode",
    "setCompleteSound",
    "btnClearHistory",
    "btnRetryFailed",
    "btnHelperFix",
    "btnHelperStart",
    "btnHelperRecheck",
    "btnPlDownload",
    "btnPlSelect",
    "btnPlRefresh",
    "btnSeriesGo",
    "btnSeriesDismiss",
    "btnSeriesRetryFailed",
    "btnSeriesSelAll",
    "btnSeriesSelPending",
    "btnSeriesSelNone",
    "seriesRange",
    "libSearch",
    "libStatus",
    "libSite",
    "libSeries",
    "btnAddWatch",
    "btnWatchDlAll",
    "btnClearWatch",
    "btnClipApply",
    "btnClipDismiss",
    "clipBanner",
    "clipBannerUrl"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const tabs = [element({ "data-tab": "main" }), element({ "data-tab": "library" })];
  const chips = [
    element({ "data-mode": "audio" }),
    element({ "data-mode": "video_subs" }),
    element({ "data-mode": "" })
  ];
  const state = {
    settings: { mediaMode: "video", subfolder: "Old" },
    allItems: [{ id: "item" }],
    historyItems: [{ id: "history" }],
    watchlistItems: [{ id: "watch" }],
    helperOk: false,
    playlistInfo: null,
    currentTabUrl: "https://tab.example/video",
    libFilter: { q: "", status: "done", site: "", series: "" },
    dismissedClip: "",
    lastClipSeen: "",
    currentTabId: null
  };
  const fn = (name, implementation) => (...args) => {
    calls.push([name, ...args]);
    return implementation?.(...args);
  };
  const setters = (key) => (value) => {
    calls.push([`set:${key}`, value]);
    state[key] = value;
  };
  const deps = {
    $: (selector) => elements[selector.slice(1)] || null,
    document: {
      querySelectorAll(selector) {
        if (selector === ".tab") return tabs;
        if (selector === ".mode-chip") return chips;
        return [];
      }
    },
    sendMessage: async (message) => {
      calls.push(["sendMessage", message]);
      if (message.type === "SET_SETTINGS") {
        return { settings: { ...state.settings, ...message.settings, saved: true } };
      }
      return {};
    },
    loadMedia: fn("loadMedia"),
    render: fn("render"),
    downloadByPastedLink: fn("downloadByPastedLink"),
    downloadThisPage: fn("downloadThisPage"),
    updateLinkCount: fn("updateLinkCount"),
    switchTab: fn("switchTab"),
    applyModeChips: fn("applyModeChips"),
    updateFooterNote: fn("updateFooterNote"),
    toast: fn("toast"),
    saveSettingsFromForm: fn("saveSettingsFromForm"),
    updateSettingsPreview: fn("updateSettingsPreview"),
    previewCompletionSound: fn("previewCompletionSound"),
    renderHistory: fn("renderHistory"),
    updateRetryFailedButton: fn("updateRetryFailedButton"),
    retryFailedDownloads: fn("retryFailedDownloads"),
    showHelperHelp: fn("showHelperHelp"),
    downloadHelperStarter: fn("downloadHelperStarter"),
    refreshHelperStatus: fn("refreshHelperStatus", () => {
      state.helperOk = true;
    }),
    downloadPlaylistAll: fn("downloadPlaylistAll"),
    selectPlaylistForDownload: fn("selectPlaylistForDownload"),
    loadPlaylistInfo: fn("loadPlaylistInfo"),
    runSeriesComplete: fn("runSeriesComplete"),
    hideSeriesBanner: fn("hideSeriesBanner"),
    retrySeriesFailed: fn("retrySeriesFailed"),
    setSeriesSelection: fn("setSeriesSelection"),
    toggleSeriesMissingOnly: fn("toggleSeriesMissingOnly"),
    setSeriesRange: fn("setSeriesRange"),
    loadHistoryUi: fn("loadHistoryUi"),
    addCurrentToWatchlist: fn("addCurrentToWatchlist"),
    downloadAllWatchlist: fn("downloadAllWatchlist"),
    renderWatchlist: fn("renderWatchlist"),
    hideClipBanner: fn("hideClipBanner"),
    dismissClipboard: fn("dismissClipboard", (url) => {
      state.dismissedClip = url || state.lastClipSeen || "";
    }),
    getUvdSettings: () => state.settings,
    setUvdSettings: setters("settings"),
    getAllItems: () => state.allItems,
    setAllItems: setters("allItems"),
    getHistoryItems: () => state.historyItems,
    setHistoryItems: setters("historyItems"),
    getWatchlistItems: () => state.watchlistItems,
    setWatchlistItems: setters("watchlistItems"),
    getHelperOk: () => state.helperOk,
    setHelperOk: setters("helperOk"),
    getPlaylistInfo: () => state.playlistInfo,
    setPlaylistInfo: setters("playlistInfo"),
    getCurrentTabUrl: () => state.currentTabUrl,
    setCurrentTabUrl: setters("currentTabUrl"),
    getLibFilter: () => state.libFilter,
    setLibFilter: setters("libFilter"),
    getCurrentTabId: () => state.currentTabId,
    setCurrentTabId: setters("currentTabId"),
    ...options.deps
  };
  PopupDomEvents.bind(deps);
  return { calls, deps, elements, tabs, chips, state };
}

async function main() {
  check(typeof PopupDomEvents.bind, "function");

  {
    const { elements, tabs, chips } = makeHarness();
    const registered = Object.entries(elements)
      .flatMap(([id, el]) =>
        Object.entries(el.listeners).map(([type, handlers]) => [
          id,
          type,
          handlers.length
        ])
      );
    check(registered.length, 35);
    check(
      registered.filter(([id]) => id === "linkInput"),
      [["linkInput", "input", 1], ["linkInput", "keydown", 1]]
    );
    check(tabs.map((tab) => tab.listeners.click.length), [1, 1]);
    check(chips.map((chip) => chip.listeners.click.length), [1, 1, 1]);
    check(elements.clipBanner.listeners, {});
    check(elements.clipBannerUrl.listeners, {});
  }

  {
    let release;
    const load = new Promise((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      deps: { loadMedia: () => load }
    });
    const pending = harness.elements.btnScan.emit("click");
    check(harness.elements.btnScan.textContent, "…");
    release();
    await pending;
    check(harness.elements.btnScan.textContent, "↻");

    await harness.elements.btnClear.emit("click");
    check(harness.calls.some(([name]) => name === "sendMessage"), false);
    harness.state.currentTabId = 42;
    await harness.elements.btnClear.emit("click");
    check(harness.state.allItems, []);
    check(harness.calls.slice(-3), [
      ["sendMessage", { type: "CLEAR_MEDIA", tabId: 42 }],
      ["set:allItems", []],
      ["render"]
    ]);
  }

  {
    const h = makeHarness();
    await h.elements.btnLinkDl.emit("click");
    await h.elements.btnThisPage.emit("click");
    await h.elements.linkInput.emit("input");
    let prevented = false;
    await h.elements.linkInput.emit("keydown", {
      key: "Enter",
      ctrlKey: true,
      preventDefault: () => {
        prevented = true;
      }
    });
    await h.elements.linkInput.emit("keydown", {
      key: "Enter",
      preventDefault: () => {
        throw new Error("must not prevent");
      }
    });
    check(prevented, true);
    check(h.calls, [
      ["downloadByPastedLink"],
      ["downloadThisPage"],
      ["updateLinkCount"],
      ["downloadByPastedLink"]
    ]);
    await h.tabs[1].emit("click");
    check(h.calls.at(-1), ["switchTab", "library"]);
  }

  {
    const h = makeHarness();
    h.state.settings = { mediaMode: "video" };
    h.state.allItems = [{ id: "fresh" }];
    await h.chips[0].emit("click");
    check(h.state.settings, { mediaMode: "audio", saved: true });
    check(h.calls, [
      ["set:settings", { mediaMode: "audio" }],
      ["applyModeChips"],
      ["sendMessage", {
        type: "SET_SETTINGS",
        settings: { mediaMode: "audio" }
      }],
      ["set:settings", { mediaMode: "audio", saved: true }],
      ["updateFooterNote"],
      ["render"],
      ["toast", "오디오만 (MP3)으로 받습니다", "ok"]
    ]);
    h.calls.length = 0;
    await h.chips[1].emit("click");
    check(h.calls.at(-1), ["toast", "영상 + 자막으로 받습니다", "ok"]);
    h.calls.length = 0;
    await h.chips[2].emit("click");
    check(h.calls.at(-1), ["toast", "영상(MP4)으로 받습니다", "ok"]);
  }

  {
    const h = makeHarness();
    h.elements.setSubfolder.value = "New";
    await h.elements.btnSaveSettings.emit("click");
    await h.elements.setTemplate.emit("input");
    await h.elements.setSubfolder.emit("input");
    await h.elements.setMediaMode.emit("change");
    check(h.state.settings.subfolder, "New");
    check(h.calls, [
      ["saveSettingsFromForm"],
      ["updateSettingsPreview", {}],
      ["set:settings", { mediaMode: "video", subfolder: "New" }],
      ["updateSettingsPreview"],
      ["updateSettingsPreview", {}]
    ]);

    h.calls.length = 0;
    h.elements.setCompleteSound.checked = false;
    await h.elements.setCompleteSound.emit("change");
    check(h.calls, [], "switching the chime off stays silent");
    h.elements.setCompleteSound.checked = true;
    await h.elements.setCompleteSound.emit("change");
    check(h.calls, [["previewCompletionSound"]], "switching it on previews it");

    h.calls.length = 0;
    h.state.historyItems = [{ id: "new-at-event-time" }];
    await h.elements.btnClearHistory.emit("click");
    check(h.state.historyItems, []);
    check(h.calls, [
      ["sendMessage", { type: "CLEAR_HISTORY" }],
      ["set:historyItems", []],
      ["renderHistory"],
      ["updateRetryFailedButton"],
      ["toast", "기록을 비웠습니다", "ok"]
    ]);
  }

  {
    const h = makeHarness();
    for (const id of ["btnRetryFailed", "btnHelperFix", "btnHelperStart"]) {
      await h.elements[id].emit("click");
    }
    await h.elements.btnHelperRecheck.emit("click");
    check(h.calls, [
      ["retryFailedDownloads"],
      ["showHelperHelp"],
      ["downloadHelperStarter"],
      ["toast", "도우미 상태 확인 중…", "ok"],
      ["refreshHelperStatus", true],
      ["toast", "도우미 연결됨", "ok"]
    ]);

    h.calls.length = 0;
    h.state.playlistInfo = { url: "https://playlist.example/list" };
    await h.elements.btnPlDownload.emit("click");
    await h.elements.btnPlSelect.emit("click");
    await h.elements.btnPlRefresh.emit("click");
    check(h.calls, [
      ["downloadPlaylistAll"],
      ["selectPlaylistForDownload"],
      ["loadPlaylistInfo", "https://playlist.example/list", true]
    ]);
    h.calls.length = 0;
    h.state.playlistInfo = null;
    h.state.currentTabUrl = "https://fresh.example/tab";
    await h.elements.btnPlRefresh.emit("click");
    check(h.calls, [["loadPlaylistInfo", "https://fresh.example/tab", true]]);
  }

  {
    const h = makeHarness();
    for (const id of [
      "btnSeriesGo",
      "btnSeriesDismiss",
      "btnSeriesRetryFailed",
      "btnSeriesSelAll",
      "btnSeriesSelPending",
      "btnSeriesSelNone"
    ]) {
      await h.elements[id].emit("click");
    }
    await h.elements.seriesRange.emit("click", {
      target: {
        closest: () => ({
          id: "btnSeriesMissingOnly",
          getAttribute: () => null
        })
      }
    });
    await h.elements.seriesRange.emit("click", {
      target: {
        closest: () => ({
          id: "range",
          getAttribute: () => "10"
        })
      }
    });
    check(h.calls, [
      ["runSeriesComplete"],
      ["hideSeriesBanner"],
      ["retrySeriesFailed"],
      ["setSeriesSelection", "all"],
      ["setSeriesSelection", "pending"],
      ["setSeriesSelection", "none"],
      ["toggleSeriesMissingOnly"],
      ["setSeriesRange", "10"]
    ]);
  }

  {
    const h = makeHarness();
    h.state.libFilter = { q: "old", status: "done", site: "", series: "" };
    h.elements.libSearch.value = "first";
    await h.elements.libSearch.emit("input");
    h.elements.libSearch.value = "second";
    await h.elements.libSearch.emit("input");
    await new Promise((resolve) => setTimeout(resolve, 240));
    check(h.state.libFilter.q, "second");
    check(h.calls.filter(([name]) => name === "loadHistoryUi").length, 1);

    h.elements.libStatus.value = "";
    h.elements.libSite.value = "youtube";
    h.elements.libSeries.value = "series-1";
    await h.elements.libStatus.emit("change");
    await h.elements.libSite.emit("change");
    await h.elements.libSeries.emit("change");
    check(h.state.libFilter, {
      q: "second",
      status: "done",
      site: "youtube",
      series: "series-1"
    });
    check(h.calls.filter(([name]) => name === "loadHistoryUi").length, 4);
  }

  {
    const h = makeHarness();
    await h.elements.btnAddWatch.emit("click");
    await h.elements.btnWatchDlAll.emit("click");
    h.state.watchlistItems = [{ id: "fresh" }];
    await h.elements.btnClearWatch.emit("click");
    check(h.state.watchlistItems, []);
    check(h.calls, [
      ["addCurrentToWatchlist"],
      ["downloadAllWatchlist"],
      ["sendMessage", { type: "CLEAR_WATCHLIST" }],
      ["set:watchlistItems", []],
      ["renderWatchlist"],
      ["toast", "나중 받기를 비웠습니다", "ok"]
    ]);
  }

  {
    const h = makeHarness();
    h.elements.clipBanner.dataset.url = "https://clip.example/video";
    await h.elements.btnClipApply.emit("click");
    check(h.elements.linkInput.value, "https://clip.example/video");
    check(h.calls, [
      ["updateLinkCount"],
      ["hideClipBanner"],
      ["toast", "링크를 적용했습니다 · 받기를 누르세요", "ok"],
      ["switchTab", "main"]
    ]);

    h.calls.length = 0;
    h.elements.clipBanner.dataset.url = "";
    h.state.lastClipSeen = "https://last.example/video";
    await h.elements.btnClipDismiss.emit("click");
    check(h.state.dismissedClip, "https://last.example/video");
    check(h.calls, [["dismissClipboard", ""]]);
  }

  console.log(`popup DOM events: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
