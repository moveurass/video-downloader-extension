"use strict";

const assert = require("node:assert/strict");
const Naming = require("../src/naming.js");
const Sites = require("../src/site-detection.js");
const DownloadEngine = require("../src/download-engine.js");
const HLS = require("../src/hls-downloader.js");
const { createStore } = require("../src/background-media-state.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};
const ok = (...args) => {
  assertions += 1;
  assert.ok(...args);
};

function listenerEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener, ...options) {
      listeners.push({ listener, options });
    }
  };
}

function makeHarness(overrides = {}) {
  const onHeadersReceived = listenerEvent();
  const onBeforeRequest = listenerEvent();
  const onRemoved = listenerEvent();
  const onUpdated = listenerEvent();
  const onActivated = listenerEvent();
  const badgeText = [];
  const badgeTitles = [];
  const messages = [];
  const tabMessages = [];
  const detached = [];
  const timers = new Map();
  let timerId = 0;
  const tabs = new Map([
    [7, { id: 7, url: "https://example.com/watch/one", title: "Example video" }]
  ]);
  const chrome = {
    webRequest: { onHeadersReceived, onBeforeRequest },
    tabs: {
      onRemoved,
      onUpdated,
      onActivated,
      get: async (tabId) => {
        if (!tabs.has(tabId)) throw new Error("missing tab");
        return tabs.get(tabId);
      },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        return { ok: true };
      }
    },
    action: {
      setBadgeBackgroundColor: () => {},
      setBadgeText: (value) => badgeText.push(value),
      setTitle: (value) => badgeTitles.push(value)
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
      }
    }
  };
  const store = createStore({
    chrome,
    Naming,
    HLS: overrides.HLS || {
      probe: async () => null,
      heightFromString: () => 0,
      estimateMediaBytes: HLS.estimateMediaBytes
    },
    ...Sites,
    isLikelyMedia: (url, mime = "", size = 0) =>
      DownloadEngine.isLikelyMedia(url, mime, size, {
        isInstagramCdnUrl: Sites.isInstagramCdnUrl,
        isJunkMedia: Naming.isJunkMedia
      }),
    classifyMedia: DownloadEngine.classifyMedia,
    qualityLabel: (height) => (height ? `${height}p` : null),
    hashUrl: (url) => `hash-${url.length}`,
    titlesMatchVideo: (a, b) => {
      const codeA = Naming.extractProductCode(a);
      const codeB = Naming.extractProductCode(b);
      if (codeA && codeB) return codeA === codeB;
      return Naming.cleanPageTitle(a) === Naming.cleanPageTitle(b);
    },
    withTabReferer: async (_tabId, operation) => operation(),
    detachJobsFromTab: (tabId) => detached.push(tabId),
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    now: () => 1234,
    console: { warn: () => {} }
  });
  return {
    store,
    events: { onHeadersReceived, onBeforeRequest, onRemoved, onUpdated, onActivated },
    badgeText,
    badgeTitles,
    messages,
    tabMessages,
    detached,
    tabs,
    runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) callback();
    },
    pendingTimerCount: () => timers.size
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const harness = makeHarness();
  const { store, events, detached, tabs, tabMessages } = harness;

  equal(store.pageIdentityKey("https://youtube.com/watch?v=alpha&t=3"), "yt:alpha");
  equal(store.pageIdentityKey("https://youtu.be/bravo?t=1"), "yt:bravo");
  equal(
    store.thumbnailMatchesPageKey(
      "https://i.ytimg.com/vi/old/hqdefault.jpg",
      "yt:new"
    ),
    false
  );
  equal(
    store.thumbnailMatchesPageKey(
      "https://i.ytimg.com/vi_webp/new/maxresdefault.webp",
      "yt:new"
    ),
    true
  );
  equal(
    store.pageIdentityKey("https://www.tiktok.com/@name/video/123456"),
    "tt:123456"
  );
  equal(
    store.pageIdentityKey("https://instagram.com/reel/Clip_One/"),
    "ig:reel:Clip_One"
  );
  equal(
    store.pageIdentityKey("https://missav.example/dm14/v/snos-309"),
    "missav.example:code:SNOS-309"
  );
  equal(
    store.pageIdentityKey(
      "https://123av.com/ko/v/cawb-035-uncensore"
    ),
    "123av.com:code:CAWB-035"
  );
  equal(
    store.pageIdentityKey("https://123av.com/ko/v/snos-309"),
    "123av.com:code:SNOS-309"
  );
  equal(store.pageIdentityKey("file:///tmp/video.mp4"), "");

  const provisionalYoutubeUrl =
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const provisionalYoutube = store.makeSitePlaceholder({
    id: 16,
    url: provisionalYoutubeUrl,
    title: "Actual video title - YouTube"
  });
  equal(provisionalYoutube.title, "Actual video title");
  equal(
    provisionalYoutube.thumbnail,
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "URL-derived thumbnail is safe before identity confirmation"
  );
  equal(
    provisionalYoutube.filename,
    "Actual video title.mp4",
    "first-paint filename uses the provisional real tab title"
  );
  store.setTabMeta(17, {
    lastUrl: provisionalYoutubeUrl,
    title: "Actual video title",
    thumbnail:
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    videoId: "dQw4w9WgXcQ",
    identityConfirmed: false
  });
  store.setTabMeta(17, {
    lastUrl: provisionalYoutubeUrl,
    title: "",
    thumbnail: "",
    videoId: "dQw4w9WgXcQ",
    identityConfirmed: false
  });
  equal(store.getTabMeta(17).title, "Actual video title");
  equal(
    store.getTabMeta(17).thumbnail,
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "same-id unconfirmed metadata cannot clear the last good title/thumbnail"
  );

  store.setTabMeta(7, {
    lastUrl: "https://example.com/watch/one",
    title: "First title",
    thumbnail: "https://example.com/first.jpg"
  });
  store.addMedia(7, {
    url: "https://cdn.example.com/first.mp4",
    type: "video",
    duration: 90,
    pageUrl: "https://example.com/watch/one"
  });
  equal(store.getTabItems(7).length, 1);
  equal(store.getTabItems(7)[0].thumbnail, "https://example.com/first.jpg");

  store.setTabMeta(7, {
    lastUrl: "https://example.com/watch/two",
    title: undefined,
    thumbnail: undefined
  });
  equal(store.getTabItems(7).length, 0);
  equal(store.getTabMeta(7).title, undefined);
  equal(store.getTabMeta(7).thumbnail, undefined);
  equal(
    store.getTabMeta(7).pageKey,
    store.pageIdentityKey("https://example.com/watch/two")
  );

  store.clearTabMediaState(7, {
    keepLastUrl: "https://example.com/watch/three"
  });
  equal(store.getTabMeta(7).lastUrl, "https://example.com/watch/three");
  equal(store.getTabMeta(7).host, "example.com");

  const merged = store.mergePrefer(
    { title: "video_123", thumbnail: "https://example.com/thumb.jpg", size: 1 },
    { title: "Readable video title", thumbnail: "data:image/jpeg;base64,abc", size: 2 }
  );
  equal(merged.title, "Readable video title");
  equal(merged.thumbnail, "data:image/jpeg;base64,abc");
  equal(merged.size, 2);

  store.addMedia(9, {
    url: "blob:https://example.com/blob",
    type: "video",
    duration: 100
  });
  store.addMedia(9, {
    url: "https://cdn.example.com/short.mp4",
    type: "video",
    duration: 3
  });
  store.addMedia(9, {
    url: "https://cdn.example.com/master.m3u8",
    type: "stream",
    duration: 100,
    height: 1080
  });
  await flush();
  const displayable = store.getMediaForTab(9);
  equal(displayable.length, 1);
  equal(displayable[0].url, "https://cdn.example.com/master.m3u8");
  equal(displayable[0].quality, "1080p");
  equal(displayable[0].foundAt, 1234);
  ok(store.probedUrls.has("https://cdn.example.com/master.m3u8"));

  const descriptorUrl = "https://123av.com/ko/v/cawb-035-uncensore";
  store.setTabMeta(10, { lastUrl: descriptorUrl });
  store.addMedia(10, {
    url: "https://cdn.example.com/cawb-035.mp4",
    pageUrl: descriptorUrl,
    filename: "동영상_720p.mp4",
    quality: "720p",
    type: "video",
    duration: 120
  });
  equal(store.getMediaForTab(10)[0].title, "CAWB-035");
  equal(store.getMediaForTab(10)[0].filename, "CAWB-035_720p.mp4");
  store.setTabMeta(10, {
    lastUrl: descriptorUrl,
    title: "CAWB-035 실제 영상 제목 - 123AV"
  });
  equal(store.getMediaForTab(10)[0].title, "CAWB-035 실제 영상 제목");
  equal(
    store.getMediaForTab(10)[0].filename,
    "CAWB-035 실제 영상 제목_720p.mp4"
  );

  store.bind();
  store.bind();
  equal(events.onHeadersReceived.listeners.length, 1);
  equal(events.onBeforeRequest.listeners.length, 1);
  equal(events.onRemoved.listeners.length, 1);
  equal(events.onUpdated.listeners.length, 1);
  equal(events.onActivated.listeners.length, 1);
  deepEqual(events.onHeadersReceived.listeners[0].options, [
    // Filtered like onBeforeRequest so scripts/images/documents do not wake
    // the worker for every response in every tab.
    {
      urls: ["<all_urls>"],
      types: ["media", "xmlhttprequest", "other", "object"]
    },
    ["responseHeaders"]
  ]);
  deepEqual(events.onBeforeRequest.listeners[0].options, [
    {
      urls: ["<all_urls>"],
      types: ["media", "xmlhttprequest", "other", "object"]
    }
  ]);

  events.onHeadersReceived.listeners[0].listener({
    tabId: 11,
    method: "GET",
    url: "https://cdn.example.com/captured.mp4",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "1048576" }
    ]
  });
  equal(store.getTabItems(11).length, 1);
  equal(store.getTabItems(11)[0].mime, "video/mp4");
  equal(store.getTabItems(11)[0].size, 1048576);

  events.onBeforeRequest.listeners[0].listener({
    tabId: 11,
    type: "media",
    url: "https://doubleclick.example/ad.mp4"
  });
  equal(store.getTabItems(11).length, 1);

  harness.runTimers();
  await flush();
  const messagesBeforeBurst = harness.messages.length;
  for (let index = 0; index < 8; index += 1) {
    store.addMedia(11, {
      url: "https://cdn.example.com/captured.mp4",
      type: "video",
      duration: 120,
      size: 1_000_000 + index
    });
  }
  equal(
    harness.pendingTimerCount(),
    1,
    "rapid tab updates coalesce into one trailing broadcast"
  );
  equal(
    harness.messages.length,
    messagesBeforeBurst,
    "coalesced updates do not broadcast before the trailing window"
  );
  harness.runTimers();
  await flush();
  equal(
    harness.messages
      .slice(messagesBeforeBurst)
      .filter((message) => message.type === "MEDIA_UPDATED" && message.tabId === 11)
      .length,
    1,
    "a rapid update burst emits one MEDIA_UPDATED message"
  );

  tabs.set(12, {
    id: 12,
    url: "https://youtube.com/watch?v=old",
    title: "Old video"
  });
  store.setTabMeta(12, {
    lastUrl: "https://youtube.com/watch?v=old",
    title: "Old video",
    thumbnail: "https://i.ytimg.com/vi/old/hqdefault.jpg",
    videoId: "old",
    identityConfirmed: true
  });
  store.addMedia(12, {
    url: "https://cdn.example.com/old.mp4",
    type: "video",
    duration: 100,
    pageUrl: "https://youtube.com/watch?v=old"
  });
  events.onUpdated.listeners[0].listener(
    12,
    { url: "https://youtube.com/watch?v=old&t=30" },
    tabs.get(12)
  );
  equal(store.getTabItems(12).length, 1);
  equal(detached.length, 0);

  events.onUpdated.listeners[0].listener(
    12,
    {
      url: "https://youtube.com/watch?v=new",
      title: "Old video"
    },
    tabs.get(12)
  );
  equal(store.getTabItems(12).length, 0);
  equal(store.getTabMeta(12).title, undefined);
  equal(store.getTabMeta(12).identityConfirmed, false);
  deepEqual(detached, [12]);
  store.setTabMeta(12, {
    lastUrl: "https://youtube.com/watch?v=new",
    thumbnail: "https://i.ytimg.com/vi/old/hqdefault.jpg"
  });
  equal(
    store.getTabMeta(12).thumbnail,
    undefined,
    "old YouTube thumbnails cannot re-enter current tab metadata"
  );
  store.setTabMeta(12, {
    lastUrl: "https://youtube.com/watch?v=new",
    thumbnail: "https://i.ytimg.com/vi/new/hqdefault.jpg",
    videoId: "new",
    identityConfirmed: true
  });
  equal(
    store.getTabMeta(12).thumbnail,
    "https://i.ytimg.com/vi/new/hqdefault.jpg"
  );
  await flush();
  const navigationUpdate = harness.messages
    .filter((message) => message.type === "MEDIA_UPDATED" && message.tabId === 12)
    .at(-1);
  equal(
    navigationUpdate?.pageUrl,
    "https://youtube.com/watch?v=new",
    "media updates identify the SPA page they belong to"
  );
  equal(
    navigationUpdate?.items?.[0]?.isSiteDownload,
    true,
    "a downloadable SPA URL broadcasts a placeholder instead of an empty list"
  );
  equal(
    navigationUpdate?.items?.[0]?.pageUrl,
    "https://youtube.com/watch?v=new"
  );
  equal(
    navigationUpdate?.items?.[0]?.thumbnail,
    "https://i.ytimg.com/vi/new/hqdefault.jpg",
    "cross-video navigation derives a thumbnail only from the new URL id"
  );
  equal(
    navigationUpdate?.items?.[0]?.title,
    "YouTube 영상",
    "cross-video navigation does not reuse the previous tab title"
  );
  ok(
    tabMessages.some(
      ({ tabId, message }) =>
        tabId === 12 &&
        message.type === "SCAN_NOW" &&
        message.pageUrl === "https://youtube.com/watch?v=new"
    ),
    "identity changes trigger an in-tab rescan"
  );

  const sniffPreview = {
    url: "https://cdn.example.com/preview/480p/playlist.m3u8",
    type: "stream",
    isHls: true,
    source: "script-sniff",
    duration: 30,
    height: 480,
    width: 854,
    segmentCount: 6,
    pageUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  };
  const networkFeature = {
    url: "https://cdn.example.com/feature/1080p/index.m3u8",
    type: "stream",
    isHls: true,
    source: "network",
    duration: 7200,
    height: 1080,
    width: 1920,
    bandwidth: 5_000_000,
    estimatedSize: 4_500_000_000,
    segmentCount: 1200,
    pageUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  };

  ok(
    Naming.mediaScore(networkFeature) > Naming.mediaScore(sniffPreview),
    "full-length HLS outscores a 30s sniff preview"
  );
  equal(
    Naming.isJunkMedia(sniffPreview),
    false,
    "short HLS previews are not hard-deleted"
  );
  equal(
    Naming.isJunkMedia({
      url: "https://cdn.example.com/sample/trailer/playlist.m3u8",
      type: "stream",
      isHls: true,
      duration: 28
    }),
    false,
    "HLS URLs with preview tokens stay available when they are the only stream"
  );
  ok(
    Naming.compareMediaCandidates(sniffPreview, networkFeature) > 0,
    "duration-first compare ranks the feature ahead of the sniff"
  );
  ok(
    Naming.isKnownCodeVideoPage("https://supjav.com/455636.html"),
    "numeric Supjav article URLs are known-code video pages"
  );
  equal(
    Naming.isKnownCodeVideoPage("https://supjav.com/"),
    false,
    "known-code homepages are not video pages"
  );

  const unprobedFeature = {
    url: "https://cdn.example.com/feature/unprobed/index.m3u8",
    type: "stream",
    isHls: true,
    source: "network",
    pageUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  };
  ok(
    Naming.compareMediaCandidates(sniffPreview, unprobedFeature) > 0,
    "unknown duration is incomparable: 30s sniff must not beat unprobed feature"
  );
  ok(
    Naming.mediaScore(unprobedFeature) > Naming.mediaScore(sniffPreview),
    "mediaScore also prefers the unprobed feature over a short sniff"
  );
  ok(
    Naming.compareMediaCandidates(
      {
        url: "https://cdn.example.com/a/playlist.m3u8",
        type: "stream",
        isHls: true,
        source: "script-sniff",
        duration: 30,
        height: 480
      },
      {
        url: "https://cdn.example.com/b/index.m3u8",
        type: "stream",
        isHls: true,
        source: "network"
      }
    ) > 0,
    "unprobed network feature beats a 30s sniff even without preview URL tokens"
  );

  store.setTabMeta(20, {
    lastUrl: "https://supjav.com/455636.html",
    host: "supjav.com",
    title: "SNOS-309"
  });
  store.addMedia(20, sniffPreview);
  store.addMedia(20, networkFeature);
  await flush();
  equal(store.getTabItems(20).length, 2, "both HLS captures stay in the tab map");
  const rankedKnownCode = store.getMediaForTab(20);
  equal(rankedKnownCode.length, 1, "popup still shows a single primary item");
  equal(
    rankedKnownCode[0].url,
    networkFeature.url,
    "A: sniff 30s 480p loses to network 7200s 1080p on known-code hosts"
  );
  const asyncKnownCode = await store.getMediaForTabAsync(20, {
    pageUrl: "https://supjav.com/455636.html",
    title: "SNOS-309"
  });
  equal(
    asyncKnownCode[0]?.url,
    networkFeature.url,
    "known-code pages stay on the HLS capture path (not a yt-dlp placeholder)"
  );
  equal(asyncKnownCode[0]?.isSiteDownload, undefined);

  store.setTabMeta(25, {
    lastUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  });
  store.addMedia(25, {
    ...sniffPreview,
    url: "https://cdn.example.com/race/preview/playlist.m3u8"
  });
  store.addMedia(25, unprobedFeature);
  await flush();
  const raced = store.getMediaForTab(25);
  equal(raced.length, 1, "race: single primary item");
  equal(
    raced[0].url,
    unprobedFeature.url,
    "race: sniff duration=30 + feature no duration ? feature wins"
  );
  store.addMedia(25, {
    ...sniffPreview,
    url: "https://cdn.example.com/race/preview/playlist.m3u8",
    duration: 30,
    height: 720,
    segmentCount: 8
  });
  await flush();
  equal(
    store.getMediaForTab(25)[0].url,
    unprobedFeature.url,
    "no oscillation: probing the sniff later still leaves the feature winning"
  );
  equal(
    store.getMediaForTab(25)[0].url,
    store.getMediaForTab(25)[0].url,
    "two candidates updating keep a stable winner"
  );

  const emptySupjav = store.makeSitePlaceholder({
    id: 31,
    url: "https://supjav.com/455636.html",
    title: "Supjav title"
  });
  ok(emptySupjav, "numeric known-code host gets a placeholder");
  equal(emptySupjav.isPagePlaceholder, true);
  equal(
    emptySupjav.isSiteDownload,
    false,
    "Supjav placeholder stays on the HLS path (not yt-dlp)"
  );
  const asyncEmptySupjav = await store.getMediaForTabAsync(32, {
    pageUrl: "https://supjav.com/455636.html",
    title: "Supjav title"
  });
  equal(asyncEmptySupjav.length, 1, "empty Supjav tab still paints a card");
  equal(asyncEmptySupjav[0].isPagePlaceholder, true);
  equal(asyncEmptySupjav[0].isSiteDownload, false);

  store.setTabMeta(30, {
    lastUrl: "https://123av.com/ko/v/snos-341",
    host: "123av.com",
    title: "SNOS-341",
    thumbnail: "https://img.test/snos-341.jpg"
  });
  store.addMedia(30, {
    url: "https://cdn.example.com/341.m3u8",
    type: "stream",
    duration: 100,
    thumbnail: "https://img.test/snos-341.jpg",
    pageUrl: "https://123av.com/ko/v/snos-341",
    host: "123av.com"
  });
  equal(store.getTabMeta(30).thumbnail, "https://img.test/snos-341.jpg");
  store.setTabMeta(30, {
    lastUrl: "https://123av.com/ko/v/snos-342",
    host: "123av.com",
    title: "SNOS-342",
    thumbnail: "https://img.test/snos-341.jpg"
  });
  equal(store.getTabItems(30).length, 0, "known-code page change clears other-id media");
  equal(
    store.getTabMeta(30).thumbnail,
    undefined,
    "known-code page change clears other-id thumbs"
  );
  store.addMedia(30, {
    url: "https://cdn.example.com/341-stale.m3u8",
    type: "stream",
    duration: 100,
    thumbnail: "https://img.test/snos-341.jpg",
    pageUrl: "https://123av.com/ko/v/snos-341"
  });
  equal(
    store.getTabItems(30).length,
    0,
    "stale PAGE_MEDIA from the previous code is ignored"
  );

  store.setTabMeta(33, {
    lastUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  });
  store.addMedia(33, {
    url: "https://cdn.example.com/tv/sample.m3u8",
    type: "stream",
    isHls: true,
    source: "script-sniff",
    duration: 30,
    height: 480,
    pageUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  });
  store.addMedia(33, {
    url: "https://cdn.example.com/fst/master.m3u8",
    type: "stream",
    isHls: true,
    source: "injected",
    pageUrl: "https://supjav.com/455636.html",
    host: "supjav.com"
  });
  await flush();
  equal(
    store.getMediaForTab(33)[0].url,
    "https://cdn.example.com/fst/master.m3u8",
    "iframe-injected feature rebound to the watch URL enters tabMedia and wins"
  );

  store.setTabMeta(21, {
    lastUrl: "https://supjav.com/only-preview.html",
    host: "supjav.com"
  });
  store.addMedia(21, {
    ...sniffPreview,
    url: "https://cdn.example.com/only/preview/playlist.m3u8",
    pageUrl: "https://supjav.com/only-preview.html"
  });
  await flush();
  const onlyPreview = store.getMediaForTab(21);
  equal(onlyPreview.length, 1, "B: a lone 30s preview is still shown");
  equal(
    onlyPreview[0].url,
    "https://cdn.example.com/only/preview/playlist.m3u8"
  );

  const harnessProbe = makeHarness({
    HLS: {
      probe: async (url) => {
        if (/preview/.test(url)) {
          return {
            kind: "media",
            duration: 30,
            segmentCount: 8,
            inferredHeight: 480
          };
        }
        if (/feature/.test(url)) {
          return {
            kind: "media",
            duration: 7200,
            segmentCount: 1200,
            inferredHeight: 1080
          };
        }
        return null;
      },
      heightFromString: () => 0,
      estimateMediaBytes: HLS.estimateMediaBytes
    }
  });
  harnessProbe.store.setTabMeta(22, {
    lastUrl: "https://123av.com/ko/v/snos-309",
    host: "123av.com"
  });
  harnessProbe.store.addMedia(22, {
    url: "https://cdn.example.com/preview/playlist.m3u8",
    type: "stream",
    isHls: true,
    source: "script-sniff",
    height: 480,
    pageUrl: "https://123av.com/ko/v/snos-309",
    host: "123av.com"
  });
  harnessProbe.store.addMedia(22, {
    url: "https://cdn.example.com/feature/playlist.m3u8",
    type: "stream",
    isHls: true,
    source: "network",
    pageUrl: "https://123av.com/ko/v/snos-309",
    host: "123av.com"
  });
  await flush();
  await flush();
  const afterProbe = harnessProbe.store.getMediaForTab(22);
  equal(afterProbe.length, 1);
  equal(
    afterProbe[0].url,
    "https://cdn.example.com/feature/playlist.m3u8",
    "C: after maybeProbeHls fills durations, the longest HLS wins"
  );
  equal(afterProbe[0].duration, 7200);
  equal(afterProbe[0].height, 1080);
  equal(
    afterProbe[0].estimatedSize,
    1200 * 220_000,
    "C: feature playlist size is not the 30s preview capacity"
  );

  store.addMedia(23, {
    url: "https://cdn.example.com/bumper.mp4",
    type: "video",
    duration: 5,
    width: 640,
    height: 360
  });
  equal(
    store.getTabItems(23).length,
    0,
    "D: progressive short mp4 junk is still discarded"
  );
  store.addMedia(23, {
    url: "https://cdn.example.com/clip.mp4",
    type: "video",
    duration: 12,
    width: 640,
    height: 360
  });
  equal(
    store.getTabItems(23).length,
    0,
    "D: sub-15s low-res progressive clips stay junk"
  );
  store.addMedia(23, {
    url: "https://cdn.example.com/preview/promo/ad.mp4",
    type: "video",
    duration: 45,
    width: 1280,
    height: 720
  });
  equal(
    store.getTabItems(23).length,
    0,
    "D: progressive preview-path mp4 junk is unchanged"
  );

  store.setTabMeta(24, {
    lastUrl: "https://example.net/watch/clip",
    host: "example.net"
  });
  store.addMedia(24, {
    url: "https://cdn.example.net/sniff/playlist.m3u8",
    type: "stream",
    isHls: true,
    source: "script-sniff",
    duration: 30,
    height: 480,
    pageUrl: "https://example.net/watch/clip"
  });
  store.addMedia(24, {
    url: "https://cdn.example.net/play/master.m3u8",
    type: "stream",
    isHls: true,
    source: "network",
    duration: 1800,
    height: 720,
    pageUrl: "https://example.net/watch/clip"
  });
  await flush();
  equal(
    store.getMediaForTab(24)[0].url,
    "https://cdn.example.net/play/master.m3u8",
    "two HLS URLs on a generic host still prefer the longest duration"
  );

  const oldCodeUrl = "https://123av.com/ko/v/snos-341-uncensore";
  const newCodeUrl = "https://123av.com/ko/v/snos-342";
  store.setTabMeta(15, { lastUrl: oldCodeUrl, title: "SNOS-341" });
  store.setTabMeta(15, { lastUrl: newCodeUrl, title: undefined });
  const codeNavigationUpdate = harness.messages
    .filter((message) => message.type === "MEDIA_UPDATED" && message.tabId === 15)
    .at(-1);
  equal(codeNavigationUpdate?.pageUrl, newCodeUrl);
  equal(codeNavigationUpdate?.items?.length, 1);
  equal(
    codeNavigationUpdate?.items?.[0]?.isPagePlaceholder,
    true,
    "known-code navigation immediately broadcasts a non-empty placeholder"
  );

  const prevSupjav = "https://supjav.com/111111.html";
  const nextSupjav = "https://supjav.com/455636.html";
  store.setTabMeta(34, {
    lastUrl: prevSupjav,
    host: "supjav.com",
    title: "Previous downloaded title SNOS-100",
    thumbnail: "https://img.supjav.com/old.jpg",
    fromPageMeta: true
  });
  store.addMedia(34, {
    url: "https://cdn.example.com/old-feature.m3u8",
    type: "stream",
    isHls: true,
    source: "network",
    duration: 5000,
    pageUrl: prevSupjav,
    host: "supjav.com"
  });
  equal(
    store.getMediaForTab(34)[0].title,
    "SNOS-100 Previous downloaded title"
  );
  store.setTabMeta(34, {
    lastUrl: nextSupjav,
    host: "supjav.com",
    title: "Previous downloaded title SNOS-100"
  });
  equal(store.getTabItems(34).length, 0, "numeric Supjav navigation clears media");
  equal(
    store.getTabMeta(34).title,
    undefined,
    "lagged chrome tab title is not applied after a known-code page change"
  );
  equal(
    store.getTabMeta(34).thumbnail,
    undefined,
    "previous cover is cleared on numeric Supjav navigation"
  );
  store.setTabMeta(34, {
    lastUrl: nextSupjav,
    host: "supjav.com",
    title: "Previous downloaded title SNOS-100"
  });
  equal(
    store.getTabMeta(34).title,
    undefined,
    "GET_MEDIA-style lagged tab title cannot rename the new watch page"
  );
  store.setTabMeta(34, {
    lastUrl: nextSupjav,
    host: "supjav.com",
    title: "Current watch page title",
    thumbnail: "https://img.supjav.com/images/2026/09/current.jpg",
    fromPageMeta: true
  });
  equal(store.getTabMeta(34).title, "Current watch page title");
  equal(
    store.getTabMeta(34).thumbnail,
    "https://img.supjav.com/images/2026/09/current.jpg"
  );
  store.addMedia(34, {
    url: "https://cdn.example.com/fst/current-feature.m3u8",
    type: "stream",
    isHls: true,
    source: "injected",
    duration: 7200,
    pageUrl: nextSupjav,
    host: "supjav.com"
  });
  const currentFeature = store.getMediaForTab(34)[0];
  equal(
    currentFeature.title,
    "Current watch page title",
    "feature HLS uses the current PAGE_META title, not the previous download"
  );
  equal(
    currentFeature.thumbnail,
    "https://img.supjav.com/images/2026/09/current.jpg",
    "feature HLS uses the current PAGE_META cover"
  );
  ok(
    String(currentFeature.filename || "").includes("Current watch page title"),
    "saved filename is locked from the current page title"
  );
  ok(
    !String(currentFeature.filename || "").includes("SNOS-100"),
    "saved filename does not reuse the previous video name"
  );

  store.addMedia(12, {
    url: "https://cdn.example.com/new.mp4",
    type: "video",
    duration: 100
  });
  equal(
    store.getTabItems(12)[0].pageUrl,
    "https://youtube.com/watch?v=new",
    "network captures without pageUrl inherit the current tab identity"
  );
  events.onRemoved.listeners[0].listener(12);
  equal(store.getTabItems(12).length, 0);
  equal(store.getTabMeta(12), undefined);
  deepEqual(detached, [12, 12]);

  tabs.set(13, { id: 13, url: "https://youtube.com/watch?v=active" });
  await events.onActivated.listeners[0].listener({ tabId: 13 });
  ok(
    harness.badgeText.some(
      (entry) => entry.tabId === 13 && entry.text === "↓"
    )
  );
  await flush();

  console.log(`background media state: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
