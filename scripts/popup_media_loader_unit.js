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
  check(
    renderCount,
    3,
    "loader paints early, after media settle, and after quality discovery"
  );

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
    MediaLoader.youtubeVideoId("https://notyoutube.com/watch?v=current"),
    "",
    "lookalike YouTube hosts do not produce a video id"
  );
  check(
    MediaLoader.youtubeVideoId("https://youtube.com.evil.example/watch?v=current"),
    "",
    "suffix YouTube hosts do not produce a video id"
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
      },
      removeAttribute: (name) => {
        if (name === "src") {
          imageSrc = "";
          imageSrcWrites += 1;
        }
      }
    }
  };
  const patchCard = {
    dataset: { mediaIdentity: "code:SNOS-342\nmedia\nhttps://cdn.test/snos-342/master.m3u8" },
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

  patchedItems[0] = { ...patchedItems[0], thumbnail: undefined };
  check(patchRenderer.patch(), true, "cleared thumbnail still patches in place");
  check(imageSrc, "", "cleared thumbnail removes the previous image");
  check(mediaRebuilds, 0, "clearing a thumbnail does not rebuild the pane");

  const ttPermalink =
    "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150";
  const ttCover = "https://p19-common-sign.tiktokcdn-us.com/cover";
  let ttPatchSrc = "";
  let ttPatchSrcWrites = 0;
  let ttDataThumb = "";
  const ttPatchImg = {
    getAttribute: (name) => {
      if (name === "src") return ttPatchSrc;
      if (name === "data-thumb-url") return ttDataThumb;
      return "";
    },
    setAttribute: (name, value) => {
      if (name === "src") {
        ttPatchSrc = value;
        ttPatchSrcWrites += 1;
      }
      if (name === "data-thumb-url") ttDataThumb = value;
    },
    removeAttribute: (name) => {
      if (name === "src") {
        ttPatchSrc = "";
        ttPatchSrcWrites += 1;
      }
      if (name === "data-thumb-url") ttDataThumb = "";
    }
  };
  const ttPatchThumb = { innerHTML: "" };
  const ttPatchCard = {
    dataset: {
      mediaIdentity: `tt:7674902153491664150\nmedia\n${ttPermalink}`
    },
    querySelector: (selector) =>
      selector === ".thumb-img"
        ? ttPatchImg
        : selector === ".thumb"
          ? ttPatchThumb
          : selector === ".name"
            ? { textContent: "", title: "" }
            : selector === ".meta-grid"
              ? { innerHTML: "meta" }
              : selector === ".filename-value"
                ? { textContent: "" }
                : selector === ".btn-dl"
                  ? { disabled: true, textContent: "" }
                  : null
  };
  let ttPatchItems = [{
    url: ttPermalink,
    pageUrl: ttPermalink,
    title: "jumping killing shoot",
    thumbnail: ttCover
  }];
  const ttPatchRenderer = MediaRenderer.createRenderer({
    listEl: {
      querySelector: (selector) => (selector === ".card" ? ttPatchCard : null)
    },
    document: {},
    ensureSiteItems: (items) => items,
    pageKey: () => "tt:7674902153491664150",
    displayName: (item) => item.title,
    downloadFilename: () => "tiktok.mp4",
    siteLabel: () => "TikTok",
    thumbHtml: (item) =>
      `<img class="thumb-img" data-thumb-url="${item.thumbnail}" alt="" />`,
    metaRowsHtml: () => "meta",
    getAllItems: () => ttPatchItems,
    setAllItems: (items) => {
      ttPatchItems = items;
    },
    getCurrentTabUrl: () => ttPermalink
  });
  check(ttPatchRenderer.patch(), true, "on-page TikTok card patches in place");
  check(
    ttPatchSrcWrites,
    0,
    "on-page PAGE_META must not paint a TikTok CDN cover as img.src"
  );
  check(
    ttDataThumb,
    ttCover,
    "on-page cover is parked on data-thumb-url for FETCH_THUMB"
  );

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
  check(
    MediaRenderer.needsRemoteThumbHydration(
      "https://p19-common-sign.tiktokcdn-us.com/obj/tos/~tplv-cropcenter"
    ),
    true,
    "TikTok CDN covers need FETCH_THUMB hydration"
  );
  check(
    MediaRenderer.needsRemoteThumbHydration("data:image/jpeg;base64,abc"),
    false,
    "data URLs are already displayable"
  );

  const hydrateItem = {
    thumbnail: "https://p19-common-sign.tiktokcdn-us.com/cover",
    pageUrl: "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150"
  };
  let hydratedSrc = hydrateItem.thumbnail;
  const hydrateImg = {
    getAttribute: (name) => (name === "src" ? hydratedSrc : ""),
    setAttribute: (name, value) => {
      if (name === "src") hydratedSrc = value;
    }
  };
  const hydrateCard = {
    querySelector: (selector) =>
      selector === ".thumb-img" ? hydrateImg : null
  };
  const hydrateRenderer = MediaRenderer.createRenderer({
    listEl: { querySelector: (selector) => (selector === ".card" ? hydrateCard : null) },
    document: {},
    fetchThumbDataUrl: async (url, referer) => {
      check(url, hydrateItem.thumbnail, "hydrate fetches the CDN cover");
      check(referer, hydrateItem.pageUrl, "hydrate sends the permalink as referer");
      return "data:image/jpeg;base64,Y292ZXI=";
    }
  });
  await hydrateRenderer.hydrateRemoteThumbnails([hydrateItem]);
  check(
    hydrateItem.thumbnail,
    "data:image/jpeg;base64,Y292ZXI=",
    "hydrate stores a data URL on the card item"
  );
  check(hydratedSrc, "data:image/jpeg;base64,Y292ZXI=", "hydrate patches the visible img");

  const fallbackThumb = { innerHTML: '<span class="thumb-fallback">🎬</span>' };
  const fallbackCard = {
    querySelector: (selector) =>
      selector === ".thumb-img" ? null : selector === ".thumb" ? fallbackThumb : null
  };
  const fallbackItem = {
    thumbnail: "https://p19-common-sign.tiktokcdn-us.com/cover",
    pageUrl: "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150"
  };
  const fallbackRenderer = MediaRenderer.createRenderer({
    listEl: {
      querySelector: (selector) => (selector === ".card" ? fallbackCard : null)
    },
    document: {},
    thumbHtml: (item) => `<img class="thumb-img" src="${item.thumbnail}" alt="" />`,
    fetchThumbDataUrl: async () => "data:image/jpeg;base64,YQ=="
  });
  await fallbackRenderer.hydrateRemoteThumbnails([fallbackItem]);
  check(
    fallbackThumb.innerHTML.includes("data:image/jpeg;base64,YQ=="),
    true,
    "hydrate recreates the img after a 🎬 fallback"
  );

  let raceTabUrl =
    "https://www.tiktok.com/@one/video/1111111111111111111";
  let racePainted = "";
  const raceImg = {
    getAttribute: (name) => (name === "src" ? racePainted : ""),
    setAttribute: (name, value) => {
      if (name === "src") racePainted = value;
    },
    removeAttribute: () => {}
  };
  const raceCard = {
    dataset: {
      mediaIdentity: "tt:1111111111111111111\nmedia\nhttps://cdn.a/a.mp4"
    },
    querySelector: (selector) =>
      selector === ".thumb-img" ? raceImg : null
  };
  let finishHydrateA;
  const hydrateA = new Promise((resolve) => {
    finishHydrateA = resolve;
  });
  const raceRenderer = MediaRenderer.createRenderer({
    listEl: {
      querySelector: (selector) => (selector === ".card" ? raceCard : null)
    },
    document: {},
    pageKey: (url) => {
      const match = String(url || "").match(/\/video\/(\d+)/);
      return match ? `tt:${match[1]}` : "";
    },
    getCurrentTabUrl: () => raceTabUrl,
    getAllItems: () => [
      {
        url: raceTabUrl,
        pageUrl: raceTabUrl,
        thumbnail: "https://cdn.example/a.jpg"
      }
    ],
    fetchThumbDataUrl: async () => {
      await hydrateA;
      return "data:image/jpeg;base64,VIDEOA";
    }
  });
  const staleHydrate = raceRenderer.hydrateRemoteThumbnails([
    {
      thumbnail: "https://cdn.example/a.jpg",
      pageUrl: "https://www.tiktok.com/@one/video/1111111111111111111"
    }
  ]);
  raceTabUrl = "https://www.tiktok.com/@two/video/2222222222222222222";
  raceCard.dataset.mediaIdentity =
    "tt:2222222222222222222\nmedia\nhttps://cdn.b/b.mp4";
  finishHydrateA();
  await staleHydrate;
  check(
    racePainted !== "data:image/jpeg;base64,VIDEOA",
    true,
    "in-flight hydrate for video A must not paint video B's card"
  );

  const onPagePermalink =
    "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150";
  const onPageCdn =
    "https://v16-webapp-prime.us.tiktok.com/video/tos/on-page.mp4";
  const onPageCover = "https://p19-common-sign.tiktokcdn-us.com/cover";
  const onPageTab = {
    id: 11,
    url: onPagePermalink,
    title: "jumping killing shoot | TikTok"
  };
  let onPageItems = [];
  let onPageTabUrl = null;
  let onPageTabId = null;
  const onPageHydrateCalls = [];
  const onPageElements = {
    quickBox: { classList: classList() },
    btnThisPage: { textContent: "" },
    quickHint: { textContent: "" },
    linkInput: { value: "", title: "" }
  };
  const onPageLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [onPageTab],
        get: async () => onPageTab,
        sendMessage: async (_tabId, message) => {
          if (message.type === "GET_PAGE_META") {
            return {
              title: "TikTok",
              thumbnail: "",
              pageUrl: onPagePermalink,
              lastUrl: onPagePermalink
            };
          }
          if (message.type === "EXTRACT_TIKTOK") {
            return { ok: true, urls: [onPageCdn], thumbnail: "" };
          }
          return { ok: true };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: onPageCdn,
                pageUrl: onPagePermalink,
                title: "TikTok",
                pageTitle: "TikTok",
                thumbnail: "",
                source: "tiktok-page",
                site: "tiktok",
                type: "video"
              }]
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => onPageElements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items) =>
      (items || []).map((item) => ({ ...item })),
    pageKey: (url) => {
      const match = String(url || "").match(/\/video\/(\d+)/);
      return match ? `tt:${match[1]}` : String(url || "").replace(/[?#].*$/, "");
    },
    isInstagramUrl: () => false,
    isTiktokUrl: (url) => /tiktok\.com/i.test(url || ""),
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: (url) => /\/@[\w.-]+\/video\/\d+/.test(url || ""),
    isHlsItem: () => false,
    cleanTitleText: (value) => value,
    isUglyName: PopupMedia.isUglyName,
    refreshHelperStatus: async () => {},
    render: () => {},
    patchMedia: () => false,
    hydrateRemoteThumbnails: async (items) => {
      onPageHydrateCalls.push(
        (items || []).map((item) => String(item?.thumbnail || ""))
      );
    },
    loadAvailableQualities: async (item) => {
      onPageItems = [{
        ...item,
        thumbnail: onPageCover,
        title: "jumping killing shoot"
      }];
    },
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => onPageItems,
    setAllItems: (items) => {
      onPageItems = items;
    },
    getCurrentTabId: () => onPageTabId,
    setCurrentTabId: (value) => {
      onPageTabId = value;
    },
    getCurrentTabUrl: () => onPageTabUrl,
    setCurrentTabUrl: (value) => {
      onPageTabUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {}
  });
  await onPageLoader.loadMedia();
  check(onPageTabUrl, onPagePermalink, "on-page loader stays on the video permalink");
  check(
    onPageItems[0].thumbnail,
    onPageCover,
    "on-page TikTok video card gets the formats cover without pasting"
  );
  check(
    onPageHydrateCalls.some((batch) => batch.includes(onPageCover)),
    true,
    "on-page formats cover is handed to FETCH_THUMB hydrate"
  );
  check(
    onPageItems[0].url,
    onPageCdn,
    "on-page EXTRACT play-CDN is still the media url"
  );

  const Sites = require("../src/site-detection.js");
  const ttAvatar =
    "https://p16-sign.tiktokcdn.com/tos-alisg-avt-0068/face~tplv-tiktokx-cropcenter:1080:1080.jpeg";
  check(
    MediaLoader.usablePageThumbnail(ttAvatar, onPagePermalink),
    "",
    "PAGE_META profile photo is not a usable on-page thumb"
  );
  const onPageKey = "tt:7674902153491664150";
  check(
    MediaLoader.usablePageThumbnail(onPageCover, onPagePermalink),
    "",
    "unscoped HTTPS cover is not trusted until stamped with the video id"
  );
  check(
    MediaLoader.usablePageThumbnail(onPageCover, onPagePermalink, onPageKey),
    onPageCover,
    "formats cover stamped with tt:videoId stays usable"
  );
  check(
    MediaLoader.preferPageThumbnail(
      ttAvatar,
      onPageCover,
      onPagePermalink,
      undefined,
      onPageKey
    ),
    onPageCover,
    "on-page merge prefers the stamped video cover over the avatar"
  );
  check(
    MediaLoader.preferPageThumbnail(
      onPageCover,
      ttAvatar,
      onPagePermalink,
      onPageKey,
      undefined
    ),
    onPageCover,
    "avatar PAGE_META cannot replace a stamped video cover"
  );
  check(
    Sites.pickTiktokCoverFromCandidates([ttAvatar, onPageCover]),
    onPageCover,
    "candidate list with avatar + cover never picks the profile photo"
  );

  let avatarMetaItems = [];
  let avatarMetaUrl = null;
  let avatarMetaId = null;
  const avatarMetaTab = {
    id: 12,
    url: onPagePermalink,
    title: "jumping killing shoot | TikTok"
  };
  const avatarMetaLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [avatarMetaTab],
        get: async () => avatarMetaTab,
        sendMessage: async (_tabId, message) => {
          if (message.type === "GET_PAGE_META") {
            return {
              title: "TikTok",
              thumbnail: ttAvatar,
              pageUrl: onPagePermalink,
              lastUrl: onPagePermalink
            };
          }
          return { ok: true };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: onPageCdn,
                pageUrl: onPagePermalink,
                title: "TikTok",
                thumbnail: ttAvatar,
                source: "tiktok-page",
                site: "tiktok",
                type: "video"
              }]
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => onPageElements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items) => (items || []).map((item) => ({ ...item })),
    pageKey: (url) => {
      const match = String(url || "").match(/\/video\/(\d+)/);
      return match ? `tt:${match[1]}` : String(url || "").replace(/[?#].*$/, "");
    },
    isInstagramUrl: () => false,
    isTiktokUrl: (url) => /tiktok\.com/i.test(url || ""),
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: (url) => /\/@[\w.-]+\/video\/\d+/.test(url || ""),
    isHlsItem: () => false,
    cleanTitleText: (value) => value,
    isUglyName: PopupMedia.isUglyName,
    refreshHelperStatus: async () => {},
    render: () => {},
    patchMedia: () => false,
    hydrateRemoteThumbnails: async () => {},
    loadAvailableQualities: async (item) => {
      avatarMetaItems = [{
        ...item,
        thumbnail: onPageCover
      }];
    },
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => avatarMetaItems,
    setAllItems: (items) => {
      avatarMetaItems = items;
    },
    getCurrentTabId: () => avatarMetaId,
    setCurrentTabId: (value) => {
      avatarMetaId = value;
    },
    getCurrentTabUrl: () => avatarMetaUrl,
    setCurrentTabUrl: (value) => {
      avatarMetaUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {}
  });
  await avatarMetaLoader.loadMedia();
  check(
    avatarMetaItems[0].thumbnail,
    onPageCover,
    "on-page loader drops GET_MEDIA/PAGE_META avatar and keeps the formats cover"
  );
  check(
    avatarMetaItems[0].thumbnail !== ttAvatar,
    true,
    "profile photo never remains item.thumbnail after on-page load"
  );

  const videoA =
    "https://www.tiktok.com/@one/video/1111111111111111111";
  const videoB =
    "https://www.tiktok.com/@two/video/2222222222222222222";
  const coverA =
    "https://p19-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/cover-a.jpeg";
  const coverB =
    "https://p19-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/cover-b.jpeg";
  let navTab = { id: 13, url: videoA, title: "Video A | TikTok" };
  let navItems = [];
  let navUrl = null;
  let navId = null;
  const navLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [navTab],
        get: async () => navTab,
        sendMessage: async (_tabId, message) => {
          if (message.type === "GET_PAGE_META") {
            return {
              title: navTab.title,
              thumbnail: navTab.url === videoA ? coverA : coverB,
              pageUrl: navTab.url,
              lastUrl: navTab.url
            };
          }
          return { ok: true };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: navTab.url,
                pageUrl: navTab.url,
                title: "TikTok",
                thumbnail: navTab.url === videoA ? coverA : coverB,
                source: "tiktok-page"
              }]
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => onPageElements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items, tabLike) => {
      const url = tabLike?.url || navUrl;
      if (!items?.length) {
        return [{
          url,
          pageUrl: url,
          title: "TikTok",
          isSiteDownload: true,
          isPagePlaceholder: true
        }];
      }
      return items.map((item) => ({ ...item, pageUrl: url, url: item.url || url }));
    },
    pageKey: (url) => {
      const match = String(url || "").match(/\/video\/(\d+)/);
      return match ? `tt:${match[1]}` : String(url || "").replace(/[?#].*$/, "");
    },
    isInstagramUrl: () => false,
    isTiktokUrl: (url) => /tiktok\.com/i.test(url || ""),
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: (url) => /\/@[\w.-]+\/video\/\d+/.test(url || ""),
    isHlsItem: () => false,
    cleanTitleText: (value) => value,
    isUglyName: PopupMedia.isUglyName,
    refreshHelperStatus: async () => {},
    render: () => {},
    patchMedia: () => false,
    hydrateRemoteThumbnails: async () => {},
    loadAvailableQualities: async (item) => {
      const key = String(item.pageUrl || item.url || "").match(/\/video\/(\d+)/);
      navItems = [{
        ...item,
        thumbnail: key?.[1] === "1111111111111111111" ? coverA : coverB,
        thumbnailPageKey: key ? `tt:${key[1]}` : undefined,
        thumbnailSource: "formats"
      }];
    },
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => navItems,
    setAllItems: (items) => {
      navItems = items;
    },
    getCurrentTabId: () => navId,
    setCurrentTabId: (value) => {
      navId = value;
    },
    getCurrentTabUrl: () => navUrl,
    setCurrentTabUrl: (value) => {
      navUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {}
  });
  await navLoader.loadMedia();
  check(navItems[0].thumbnail, coverA, "first permalink shows video A's formats cover");
  navTab = { id: 13, url: videoB, title: "Video B | TikTok" };
  await navLoader.loadMedia({ navigation: true });
  check(
    navItems[0].thumbnail !== coverA,
    true,
    "after A → B navigation the card does not keep video A's cover"
  );
  check(
    navItems[0].thumbnail,
    coverB,
    "after A → B navigation the card uses video B's formats cover"
  );

  const igPermalink = "https://www.instagram.com/reel/DABC123xyz/";
  const igPlayCdn =
    "https://scontent.cdninstagram.com/o1/v/t16/f2/m86/play.mp4";
  const igCover =
    "https://scontent.cdninstagram.com/v/t51.2885-15/e35/cover.jpg";
  const igTab = {
    id: 21,
    url: igPermalink,
    title: "송민구(@minkoosong) • Instagram"
  };
  let igItems = [];
  let igTabUrl = null;
  let igTabId = null;
  const igHydrateCalls = [];
  const igElements = {
    quickBox: { classList: classList() },
    btnThisPage: { textContent: "" },
    quickHint: { textContent: "" },
    linkInput: { value: "", title: "" }
  };
  const igLoader = MediaLoader.createLoader({
    chrome: {
      tabs: {
        query: async () => [igTab],
        get: async () => igTab,
        sendMessage: async (_tabId, message) => {
          if (message.type === "GET_PAGE_META") {
            return {
              title: "송민구(@minkoosong)",
              thumbnail: "",
              pageUrl: igPermalink,
              lastUrl: igPermalink
            };
          }
          if (message.type === "EXTRACT_INSTAGRAM") {
            return { ok: true, urls: [igPlayCdn], thumbnail: "" };
          }
          return { ok: true };
        }
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "GET_MEDIA") {
            return {
              items: [{
                url: igPlayCdn,
                pageUrl: igPermalink,
                title: "송민구(@minkoosong)",
                pageTitle: "송민구(@minkoosong)",
                thumbnail: "",
                source: "instagram-page",
                site: "instagram",
                type: "video"
              }]
            };
          }
          return { ok: true };
        }
      }
    },
    listEl: { innerHTML: "" },
    pageHost: { textContent: "", title: "" },
    $: (selector) => igElements[selector.slice(1)] || null,
    UVD: {
      isPlaylistOnlyUrl: () => false,
      isWatchInPlaylistUrl: () => false
    },
    ensureSiteItems: (items) =>
      (items || []).map((item) => ({ ...item })),
    pageKey: (url) => {
      const match = String(url || "").match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      return match ? `ig:${match[1]}:${match[2]}` : String(url || "").replace(/[?#].*$/, "");
    },
    isInstagramUrl: (url) => /instagram\.com\/(?:p|reel)\//i.test(url || ""),
    isTiktokUrl: () => false,
    isYoutubeUrl: () => false,
    isXUrl: () => false,
    isFacebookUrl: () => false,
    isBilibiliUrl: () => false,
    isSitePage: (url) => /instagram\.com\/(?:p|reel)\//i.test(url || ""),
    isHlsItem: () => false,
    cleanTitleText: (value) => value,
    isUglyName: PopupMedia.isUglyName,
    refreshHelperStatus: async () => {},
    render: () => {},
    patchMedia: () => false,
    hydrateRemoteThumbnails: async (items) => {
      igHydrateCalls.push(
        (items || []).map((item) => String(item?.thumbnail || ""))
      );
    },
    loadAvailableQualities: async (item) => {
      igItems = [{
        ...item,
        thumbnail: igCover,
        thumbnailSource: "formats",
        title: "송민구(@minkoosong)"
      }];
    },
    loadPlaylistInfo: async () => {},
    hidePlaylistBox: () => {},
    getAllItems: () => igItems,
    setAllItems: (items) => {
      igItems = items;
    },
    getCurrentTabId: () => igTabId,
    setCurrentTabId: (value) => {
      igTabId = value;
    },
    getCurrentTabUrl: () => igTabUrl,
    setCurrentTabUrl: (value) => {
      igTabUrl = value;
    },
    getAvailableQualities: () => [],
    setAvailableQualities: () => {},
    getQualitiesLoading: () => false,
    setQualitiesLoading: () => {}
  });
  await igLoader.loadMedia();
  check(igTabUrl, igPermalink, "on-page Instagram loader stays on the reel permalink");
  check(
    igItems[0].thumbnail,
    igCover,
    "on-page Instagram reel card gets the formats cover without pasting"
  );
  check(
    igHydrateCalls.some((batch) => batch.includes(igCover)),
    true,
    "on-page Instagram formats cover is handed to FETCH_THUMB hydrate"
  );

  check(
    MediaRenderer.needsRemoteThumbHydration(igCover),
    true,
    "Instagram CDN covers need FETCH_THUMB hydration"
  );

  const igHydrateItem = {
    thumbnail: igCover,
    pageUrl: igPermalink
  };
  let igHydratedSrc = igHydrateItem.thumbnail;
  const igHydrateImg = {
    getAttribute: (name) => (name === "src" ? igHydratedSrc : ""),
    setAttribute: (name, value) => {
      if (name === "src") igHydratedSrc = value;
    },
    removeAttribute: () => {}
  };
  const igHydrateCard = {
    querySelector: (selector) =>
      selector === ".thumb-img" ? igHydrateImg : null
  };
  const igHydrateRenderer = MediaRenderer.createRenderer({
    listEl: { querySelector: (selector) => (selector === ".card" ? igHydrateCard : null) },
    document: {},
    fetchThumbDataUrl: async (url, referer) => {
      check(url, igCover, "Instagram hydrate fetches the CDN cover");
      check(referer, igPermalink, "Instagram hydrate sends the reel as referer");
      return "data:image/jpeg;base64,SUdDT1ZFUg==";
    }
  });
  await igHydrateRenderer.hydrateRemoteThumbnails([igHydrateItem]);
  check(
    igHydrateItem.thumbnail,
    "data:image/jpeg;base64,SUdDT1ZFUg==",
    "Instagram hydrate stores a data URL on the card item"
  );
  check(
    igHydratedSrc,
    "data:image/jpeg;base64,SUdDT1ZFUg==",
    "Instagram hydrate patches the visible img"
  );

  let igPatchSrc = "";
  let igPatchSrcWrites = 0;
  let igDataThumb = "";
  const igPatchImg = {
    getAttribute: (name) => {
      if (name === "src") return igPatchSrc;
      if (name === "data-thumb-url") return igDataThumb;
      return "";
    },
    setAttribute: (name, value) => {
      if (name === "src") {
        igPatchSrc = value;
        igPatchSrcWrites += 1;
      }
      if (name === "data-thumb-url") igDataThumb = value;
    },
    removeAttribute: (name) => {
      if (name === "src") {
        igPatchSrc = "";
        igPatchSrcWrites += 1;
      }
      if (name === "data-thumb-url") igDataThumb = "";
    }
  };
  const igPatchThumb = { innerHTML: "" };
  const igPatchCard = {
    dataset: {
      mediaIdentity: `ig:reel:DABC123xyz\nmedia\n${igPlayCdn}`
    },
    querySelector: (selector) =>
      selector === ".thumb-img"
        ? igPatchImg
        : selector === ".thumb"
          ? igPatchThumb
          : selector === ".name"
            ? { textContent: "", title: "" }
            : selector === ".meta-grid"
              ? { innerHTML: "meta" }
              : selector === ".filename-value"
                ? { textContent: "" }
                : selector === ".btn-dl"
                  ? { disabled: true, textContent: "" }
                  : null
  };
  let igPatchItems = [{
    url: igPlayCdn,
    pageUrl: igPermalink,
    title: "송민구(@minkoosong)",
    thumbnail: igCover
  }];
  const igPatchRenderer = MediaRenderer.createRenderer({
    listEl: {
      querySelector: (selector) => (selector === ".card" ? igPatchCard : null)
    },
    document: {},
    ensureSiteItems: (items) => items,
    pageKey: () => "ig:reel:DABC123xyz",
    displayName: (item) => item.title,
    downloadFilename: () => "instagram.mp4",
    siteLabel: () => "Instagram",
    thumbHtml: (item) =>
      `<img class="thumb-img" data-thumb-url="${item.thumbnail}" alt="" />`,
    metaRowsHtml: () => "meta",
    getAllItems: () => igPatchItems,
    setAllItems: (items) => {
      igPatchItems = items;
    },
    getCurrentTabUrl: () => igPermalink
  });
  check(igPatchRenderer.patch(), true, "on-page Instagram card patches in place");
  check(
    igPatchSrcWrites,
    0,
    "on-page PAGE_META must not paint an Instagram CDN cover as img.src"
  );
  check(
    igDataThumb,
    igCover,
    "on-page Instagram cover is parked on data-thumb-url for FETCH_THUMB"
  );

  const igHydrated = "data:image/jpeg;base64,SUdDT1ZFUg==";
  let staySrc = igHydrated;
  let staySrcWrites = 0;
  let stayDataThumb = "";
  let stayInner = "";
  const stayImg = {
    getAttribute: (name) => {
      if (name === "src") return staySrc;
      if (name === "data-thumb-url") return stayDataThumb;
      return "";
    },
    setAttribute: (name, value) => {
      if (name === "src") {
        staySrc = value;
        staySrcWrites += 1;
      }
      if (name === "data-thumb-url") stayDataThumb = value;
    },
    removeAttribute: (name) => {
      if (name === "src") {
        staySrc = "";
        staySrcWrites += 1;
      }
      if (name === "data-thumb-url") stayDataThumb = "";
    }
  };
  const stayThumb = {
    get innerHTML() {
      return stayInner;
    },
    set innerHTML(value) {
      stayInner = value;
    }
  };
  const stayCard = {
    dataset: {
      mediaIdentity: `ig:reel:DABC123xyz\nmedia\n${igPlayCdn}`
    },
    querySelector: (selector) =>
      selector === ".thumb-img"
        ? stayImg
        : selector === ".thumb"
          ? stayThumb
          : selector === ".name"
            ? { textContent: "송민구(@minkoosong)", title: "송민구(@minkoosong)" }
            : selector === ".meta-grid"
              ? { innerHTML: "meta" }
              : selector === ".filename-value"
                ? { textContent: "" }
                : selector === ".btn-dl"
                  ? { disabled: true, textContent: "" }
                  : null
  };
  let stayItems = [{
    url: igPlayCdn,
    pageUrl: igPermalink,
    title: "송민구(@minkoosong)",
    thumbnail: igHydrated,
    thumbnailPageKey: "ig:reel:DABC123xyz"
  }];
  const stayRenderer = MediaRenderer.createRenderer({
    listEl: {
      querySelector: (selector) => (selector === ".card" ? stayCard : null)
    },
    document: {},
    ensureSiteItems: (items) => items,
    pageKey: () => "ig:reel:DABC123xyz",
    isInstagramPostUrl: (url) => /instagram\.com\/reel\//i.test(url || ""),
    isInstagramHost: (url) => /instagram\.com/i.test(url || ""),
    displayName: (item) => item.title,
    downloadFilename: () => "instagram.mp4",
    siteLabel: () => "Instagram",
    thumbHtml: (item) =>
      item?.thumbnail
        ? `<img class="thumb-img" src="${item.thumbnail}" alt="" />`
        : `<span class="thumb-fallback">🎬</span>`,
    metaRowsHtml: () => "meta",
    getAllItems: () => stayItems,
    setAllItems: (items) => {
      stayItems = items;
    },
    getCurrentTabUrl: () => igPermalink,
    fetchThumbDataUrl: async () => {
      throw new Error("hydrate must not run after a stable Instagram data URL");
    }
  });
  stayItems = [{
    url: igPlayCdn,
    pageUrl: igPermalink,
    title: "송민구(@minkoosong)",
    thumbnail: ""
  }];
  check(
    stayRenderer.patch(),
    true,
    "same Instagram reel still patches after PAGE_META clears the thumb"
  );
  check(staySrc, igHydrated, "data-URL cover stays after an empty same-reel patch");
  check(
    stayItems[0].thumbnail,
    igHydrated,
    "empty PAGE_META writes the painted data URL back onto the item"
  );
  check(stayInner.includes("🎬"), false, "empty patch must not rebuild a 🎬 fallback");

  stayItems = [{
    url: "https://scontent.cdninstagram.com/o1/v/t16/f2/m86/other.mp4",
    pageUrl: igPermalink,
    title: "송민구(@minkoosong)",
    thumbnail: igCover
  }];
  const writesBeforeCdn = staySrcWrites;
  check(
    stayRenderer.patch(),
    true,
    "play-CDN url swap on the same shortcode still patches in place"
  );
  check(
    staySrc,
    igHydrated,
    "data-URL cover stays after a same-reel CDN thumbnail patch"
  );
  check(staySrcWrites, writesBeforeCdn, "CDN patch does not rewrite a good data-URL src");
  check(
    stayItems[0].thumbnail,
    igHydrated,
    "CDN PAGE_META must not replace a hydrated Instagram data URL"
  );

  check(
    MediaLoader.preferPageThumbnail(
      igHydrated,
      igCover,
      igPermalink
    ),
    igHydrated,
    "PAGE_META CDN cover must not replace a hydrated Instagram data URL"
  );
  check(
    MediaLoader.preferPageThumbnail(
      igHydrated,
      "",
      igPermalink
    ),
    igHydrated,
    "empty PAGE_META must not drop a hydrated Instagram data URL"
  );

  console.log(`popup media loader: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
