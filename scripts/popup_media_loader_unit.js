"use strict";

const assert = require("node:assert/strict");
const Naming = require("../src/naming.js");
const UVD = require("../src/uvd-common.js");
const PopupMedia = require("../src/popup-media.js");
const MediaLoader = require("../src/popup-media-loader.js");
const MediaRenderer = require("../src/popup-media-renderer.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

async function main() {
  const pageUrl = "https://123av.com/ko/v/cawb-035-uncensore";
  const tab = {
    id: 7,
    url: pageUrl,
    title: "CAWB-035 실제 영상 제목 - 123AV"
  };
  const tabMessages = [];
  const runtimeMessages = [];
  let allItems = [];
  let currentTabId = null;
  let currentTabUrl = null;
  let qualitiesLoading = false;
  let renderCount = 0;

  const elements = {
    quickBox: { classList: classList() },
    btnThisPage: { textContent: "" },
    quickHint: { textContent: "" },
    linkInput: { value: "", title: "" }
  };
  const chrome = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      sendMessage: async (tabId, message, options) => {
        tabMessages.push({ tabId, message, options });
        if (message.type === "GET_PAGE_META") {
          // Reproduce the live failure: the page has a cover already, while
          // its SPA title extractor has not produced text yet.
          return { title: "", thumbnail: "https://img.test/cawb-035.jpg" };
        }
        return { ok: true };
      }
    },
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        if (message.type === "GET_MEDIA") {
          return {
            items: [{
              url: "https://cdn.test/cawb-035.mp4",
              pageUrl,
              title: "",
              pageTitle: "",
              displayName: "영상",
              filename: "동영상_720p.mp4",
              quality: "720p",
              type: "video"
            }]
          };
        }
        return { ok: true };
      }
    }
  };

  const loader = MediaLoader.createLoader({
    chrome,
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => elements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items) => items,
    pageKey: (url) => String(url || "").replace(/[?#].*$/, ""),
    isInstagramUrl: () => false,
    isTiktokUrl: () => false,
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: () => false,
    isHlsItem: () => false,
    cleanTitleText: (value) => PopupMedia.cleanTitleText(value, Naming),
    isUglyName: PopupMedia.isUglyName,
    refreshHelperStatus: async () => {},
    render: () => {
      renderCount += 1;
    },
    loadAvailableQualities: async () => {},
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => allItems,
    setAllItems: (items) => {
      allItems = items;
    },
    getCurrentTabId: () => currentTabId,
    setCurrentTabId: (value) => {
      currentTabId = value;
    },
    getCurrentTabUrl: () => currentTabUrl,
    setCurrentTabUrl: (value) => {
      currentTabUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => qualitiesLoading,
    setQualitiesLoading: (value) => {
      qualitiesLoading = value;
    }
  });

  await loader.loadMedia();

  check(currentTabId, 7, "active tab id");
  check(currentTabUrl, pageUrl, "active page URL");
  check(
    runtimeMessages.find((message) => message.type === "GET_MEDIA")?.title,
    tab.title,
    "GET_MEDIA carries the current browser-tab title"
  );
  check(
    tabMessages.find((entry) => entry.message.type === "GET_PAGE_META")?.options,
    { frameId: 0 },
    "page metadata is requested only from the top frame"
  );
  check(
    allItems[0].title,
    "CAWB-035 실제 영상 제목",
    "tab title fills a thumbnail-only page-meta response"
  );
  check(
    allItems[0].pageTitle,
    "CAWB-035 실제 영상 제목",
    "fresh tab title reaches pageTitle"
  );
  check(
    allItems[0].displayName,
    "CAWB-035 실제 영상 제목",
    "fresh tab title replaces a generic display label"
  );
  check(
    runtimeMessages.find((message) => message.type === "PAGE_META")?.pageMeta
      ?.title,
    "CAWB-035 실제 영상 제목",
    "fresh fallback title is returned to background state"
  );
  check(renderCount, 2, "loader renders before and after quality discovery");

  const genericItem = {
    filename: "동영상_720p.mp4",
    pageUrl,
    quality: "720p"
  };
  const display = PopupMedia.displayName(genericItem, { Naming });
  check(display, "CAWB-035", "generic card title falls back to URL code");
  check(
    PopupMedia.downloadFilename(genericItem, {
      Naming,
      UVD,
      selectedQuality: "720p"
    }),
    "CAWB-035_720p.mp4",
    "generic filename falls back to URL code"
  );
  check(
    MediaRenderer.primaryDownloadLabel(
      "CAWB-035 실제 영상 제목",
      "123av.com/ko/v/cawb-035-uncensore"
    ),
    "CAWB-035 실제 영상 제목 받기",
    "primary action uses the human title instead of the raw URL"
  );

  console.log(`popup media loader: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
