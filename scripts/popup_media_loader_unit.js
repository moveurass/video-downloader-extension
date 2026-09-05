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
  const renderedItemCounts = [];
  let mediaResponseItems = [{
    url: "https://cdn.test/cawb-035.mp4",
    pageUrl,
    title: "",
    pageTitle: "",
    displayName: "영상",
    filename: "동영상_720p.mp4",
    quality: "720p",
    type: "video"
  }];
  let stablePageItems = [];

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
            items: mediaResponseItems.map((item) => ({ ...item }))
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
    ensureSiteItems: (items, tabLike) => {
      if (items.length) {
        stablePageItems = items.map((item) => ({ ...item }));
      }
      if (stablePageItems.length) {
        return stablePageItems.map((item) => ({ ...item }));
      }
      return [{
        url: tabLike.url,
        pageUrl: tabLike.url,
        type: "page",
        isPagePlaceholder: true,
        title: "CAWB-035"
      }];
    },
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
      renderedItemCounts.push(allItems.length);
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

  mediaResponseItems = [];
  const rapidRenderStart = renderedItemCounts.length;
  await Promise.all([loader.loadMedia(), loader.loadMedia()]);
  check(
    allItems.length > 0,
    true,
    "aborted/empty reload restores the last good 123av card"
  );
  check(
    renderedItemCounts.slice(rapidRenderStart).length > 0 &&
      renderedItemCounts
        .slice(rapidRenderStart)
        .every((itemCount) => itemCount > 0),
    true,
    "rapid 123av reloads never paint the global empty state"
  );

  check(
    MediaLoader.youtubeVideoId(
      "https://www.youtube.com/watch?v=current&t=30"
    ),
    "current",
    "YouTube watch identity ignores navigation-only parameters"
  );
  check(
    MediaLoader.thumbnailMatchesPage(
      "https://i.ytimg.com/vi/previous/hqdefault.jpg",
      "https://www.youtube.com/watch?v=current"
    ),
    false,
    "a previous watch thumbnail is rejected"
  );
  check(
    MediaLoader.youtubeThumbnailForPage(
      "https://www.youtube.com/watch?v=current"
    ),
    "https://i.ytimg.com/vi/current/hqdefault.jpg",
    "the current watch id provides a safe thumbnail fallback"
  );

  const oldWatchUrl = "https://www.youtube.com/watch?v=previous";
  const newWatchUrl = "https://www.youtube.com/watch?v=current";
  const spaTab = { id: 8, url: newWatchUrl, title: "Previous video - YouTube" };
  let spaCurrentTabId = null;
  let spaCurrentTabUrl = oldWatchUrl;
  let spaItems = [{
    pageUrl: oldWatchUrl,
    title: "Previous video",
    thumbnail: "https://i.ytimg.com/vi/previous/hqdefault.jpg"
  }];
  let spaMetaReads = 0;
  const spaRenders = [];
  const spaRuntimeMessages = [];
  const spaPageKey = (url) => {
    try {
      return new URL(url).searchParams.get("v") || new URL(url).pathname;
    } catch {
      return "";
    }
  };
  const spaLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [spaTab],
        get: async () => spaTab,
        sendMessage: async (_tabId, message) => {
          if (message.type !== "GET_PAGE_META") return { ok: true };
          spaMetaReads += 1;
          if (spaMetaReads === 1) {
            return {
              pageUrl: newWatchUrl,
              videoId: "current",
              identityConfirmed: false,
              title: "Previous video",
              thumbnail:
                "https://i.ytimg.com/vi/previous/hqdefault.jpg"
            };
          }
          return {
            pageUrl: newWatchUrl,
            videoId: "current",
            identityConfirmed: true,
            title: "",
            thumbnail: "https://i.ytimg.com/vi/current/hqdefault.jpg"
          };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          spaRuntimeMessages.push(message);
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: newWatchUrl,
                pageUrl: newWatchUrl,
                isSiteDownload: true,
                title: "Previous video",
                pageTitle: "Previous video",
                displayName: "Previous video",
                filename: "Previous video.mp4",
                thumbnail:
                  "https://i.ytimg.com/vi/previous/hqdefault.jpg"
              }]
            };
          }
          if (message.type === "PROBE_PAGE_META") {
            return {
              ok: true,
              source: "youtube-oembed",
              finalUrl: newWatchUrl,
              videoId: "current",
              identityConfirmed: true,
              title: "Current video",
              thumbnail: "https://i.ytimg.com/vi/current/hqdefault.jpg"
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => elements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items, tabLike) =>
      items.length
        ? items
        : [{
            url: tabLike.url,
            pageUrl: tabLike.url,
            isSiteDownload: true,
            title: "YouTube 영상"
          }],
    pageKey: spaPageKey,
    isInstagramUrl: () => false,
    isTiktokUrl: () => false,
    isYoutubeUrl: () => true,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: () => true,
    isHlsItem: () => false,
    cleanTitleText: (value) => String(value || "").trim(),
    isUglyName: () => false,
    refreshHelperStatus: async () => {},
    render: () => {
      spaRenders.push(spaItems.map((item) => ({ ...item })));
    },
    loadAvailableQualities: async () => {},
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => spaItems,
    setAllItems: (items) => {
      spaItems = items;
    },
    getCurrentTabId: () => spaCurrentTabId,
    setCurrentTabId: (value) => {
      spaCurrentTabId = value;
    },
    getCurrentTabUrl: () => spaCurrentTabUrl,
    setCurrentTabUrl: (value) => {
      spaCurrentTabUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {},
    setTimeout: (callback) => callback()
  });

  await spaLoader.loadMedia();
  check(
    spaRenders[0],
    [{
      url: newWatchUrl,
      pageUrl: newWatchUrl,
      isSiteDownload: true,
      title: "YouTube 영상"
    }],
    "the old card is replaced immediately by the new-page placeholder"
  );
  check(
    spaRuntimeMessages.find((message) => message.type === "GET_MEDIA")?.title,
    "",
    "a lagging YouTube browser-tab title is not cached under the new watch id"
  );
  check(spaMetaReads, 3, "page metadata is retried while the player title is empty");
  check(
    spaRuntimeMessages.some(
      (message) =>
        message.type === "PROBE_PAGE_META" &&
        message.expectedKey === "current"
    ),
    true,
    "an empty SPA player title falls back to current-id page metadata"
  );
  check(spaItems[0].title, "Current video", "the new player title replaces stale state");
  check(
    spaItems[0].thumbnail,
    "https://i.ytimg.com/vi/current/hqdefault.jpg",
    "the new watch thumbnail replaces stale state"
  );
  check(spaItems[0].filename, undefined, "the old title-based filename is cleared");
  check(
    spaRuntimeMessages.find((message) => message.type === "PAGE_META")?.pageUrl,
    newWatchUrl,
    "refetched metadata is bound to the current watch URL"
  );

  spaCurrentTabUrl = null;
  spaItems = [];
  spaTab.title = "Current video - YouTube";
  const firstPaintMessageStart = spaRuntimeMessages.length;
  await spaLoader.loadMedia();
  check(
    spaRuntimeMessages
      .slice(firstPaintMessageStart)
      .find((message) => message.type === "GET_MEDIA")?.title,
    "Current video - YouTube",
    "initial YouTube load forwards the real tab title for filename locking"
  );

  const firstSupjav = "https://supjav.com/111111.html";
  const nextSupjav = "https://supjav.com/455636.html";
  const supjavTab = {
    id: 9,
    url: nextSupjav,
    title: "Previous downloaded title SNOS-100 - Supjav"
  };
  let supjavCurrentUrl = firstSupjav;
  const supjavRuntime = [];
  const supjavLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [supjavTab],
        get: async () => supjavTab,
        sendMessage: async (_tabId, message) => {
          if (message.type !== "GET_PAGE_META") return { ok: true };
          return {
            pageUrl: nextSupjav,
            lastUrl: nextSupjav,
            title: "Current watch page title",
            thumbnail: "https://img.supjav.com/images/2026/09/current.jpg",
            identityConfirmed: true
          };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          supjavRuntime.push(message);
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: "https://cdn.test/fst/current-feature.m3u8",
                pageUrl: nextSupjav,
                type: "stream",
                isHls: true,
                duration: 7200,
                title: "Previous downloaded title SNOS-100",
                pageTitle: "Previous downloaded title SNOS-100",
                displayName: "Previous downloaded title SNOS-100",
                filename: "Previous downloaded title SNOS-100.mp4",
                thumbnail: "https://img.supjav.com/old.jpg"
              }]
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => elements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items) => items,
    pageKey: (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}`;
      } catch {
        return "";
      }
    },
    isInstagramUrl: () => false,
    isTiktokUrl: () => false,
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: () => false,
    isHlsItem: () => true,
    cleanTitleText: (value) => String(value || "").trim(),
    isUglyName: () => false,
    refreshHelperStatus: async () => {},
    render: () => {},
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
    getCurrentTabUrl: () => supjavCurrentUrl,
    setCurrentTabUrl: (value) => {
      supjavCurrentUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {},
    setTimeout: (callback) => callback()
  });
  allItems = [];
  currentTabId = null;
  await supjavLoader.loadMedia({ navigation: true });
  check(
    supjavRuntime.find((message) => message.type === "GET_MEDIA")?.title,
    "",
    "known-code navigation does not cache a lagged browser-tab title"
  );
  check(
    allItems[0].title,
    "Current watch page title",
    "GET_PAGE_META replaces the previous download title on a new numeric page"
  );
  check(
    allItems[0].thumbnail,
    "https://img.supjav.com/images/2026/09/current.jpg",
    "GET_PAGE_META replaces the previous download cover on a new numeric page"
  );
  check(
    allItems[0].filename,
    undefined,
    "the previous download filename is not kept across numeric watch pages"
  );

  spaCurrentTabUrl = oldWatchUrl;
  spaItems = [{
    pageUrl: oldWatchUrl,
    title: "Previous video",
    thumbnail: "https://i.ytimg.com/vi/previous/hqdefault.jpg"
  }];
  const raceRenderStart = spaRenders.length;
  await Promise.all([
    spaLoader.loadMedia({ navigation: true }),
    spaLoader.loadMedia({ navigation: true })
  ]);
  const raceRenders = spaRenders.slice(raceRenderStart);
  check(
    raceRenders.length > 0 &&
      raceRenders.every(
        (items) => items.length > 0 && items[0].pageUrl === newWatchUrl
      ),
    true,
    "a superseded load after navigation never strands the helper page empty"
  );

  let patchedItems = [{
    url: "https://cdn.test/snos-342/master.m3u8",
    pageUrl: "https://123av.com/ko/v/snos-342",
    title: "SNOS-342 긴 실제 영상 제목",
    thumbnail: "https://img.test/snos-342.jpg"
  }];
  let imageSrc = patchedItems[0].thumbnail;
  let imageSrcWrites = 0;
  let mediaRebuilds = 0;
  const patchElements = {
    ".name": { textContent: patchedItems[0].title, title: patchedItems[0].title },
    ".meta-grid": { innerHTML: "meta" },
    ".filename-value": { textContent: "SNOS-342.mp4" },
    ".btn-dl": { textContent: "받기", disabled: false },
    ".thumb": { innerHTML: "" },
    ".thumb-img": {
      getAttribute: (name) => name === "src" ? imageSrc : "",
      setAttribute: (name, value) => {
        if (name === "src") {
          imageSrc = value;
          imageSrcWrites += 1;
        }
      }
    }
  };
  const patchCard = {
    dataset: { mediaIdentity: "code:SNOS-342\nmedia" },
    querySelector: (selector) => patchElements[selector] || null
  };
  const patchList = {
    querySelector: (selector) => selector === ".card" ? patchCard : null
  };
  Object.defineProperty(patchList, "innerHTML", {
    set() {
      mediaRebuilds += 1;
    }
  });
  const patchRenderer = MediaRenderer.createRenderer({
    listEl: patchList,
    document: {},
    ensureSiteItems: (items) => items,
    pageKey: () => "code:SNOS-342",
    displayName: (item) => item.title,
    downloadFilename: () => "SNOS-342.mp4",
    siteLabel: () => "123av.com",
    thumbHtml: () => "",
    metaRowsHtml: () => "meta",
    getAllItems: () => patchedItems,
    setAllItems: (items) => {
      patchedItems = items;
    },
    getCurrentTabUrl: () => patchedItems[0].pageUrl
  });
  check(patchRenderer.patch(), true, "same-page card supports incremental patching");
  check(imageSrcWrites, 0, "unchanged thumbnail src is preserved");
  check(mediaRebuilds, 0, "incremental patch does not clear the media pane");

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
