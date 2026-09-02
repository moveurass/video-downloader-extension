"use strict";

const assert = require("node:assert/strict");
const Naming = require("../src/naming.js");
const Sites = require("../src/site-detection.js");
const DownloadEngine = require("../src/download-engine.js");
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

function makeHarness() {
  const onHeadersReceived = listenerEvent();
  const onBeforeRequest = listenerEvent();
  const onRemoved = listenerEvent();
  const onUpdated = listenerEvent();
  const onActivated = listenerEvent();
  const badgeText = [];
  const badgeTitles = [];
  const messages = [];
  const detached = [];
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
    HLS: {
      probe: async () => null,
      heightFromString: () => 0
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
    titlesMatchVideo: (a, b) =>
      Naming.cleanPageTitle(a) === Naming.cleanPageTitle(b),
    withTabReferer: async (_tabId, operation) => operation(),
    detachJobsFromTab: (tabId) => detached.push(tabId),
    now: () => 1234,
    console: { warn: () => {} }
  });
  return {
    store,
    events: { onHeadersReceived, onBeforeRequest, onRemoved, onUpdated, onActivated },
    badgeText,
    badgeTitles,
    messages,
    detached,
    tabs
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const harness = makeHarness();
  const { store, events, detached, tabs } = harness;

  equal(store.pageIdentityKey("https://youtube.com/watch?v=alpha&t=3"), "yt:alpha");
  equal(store.pageIdentityKey("https://youtu.be/bravo?t=1"), "yt:bravo");
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
    "missav.example:code:DM-14"
  );
  equal(store.pageIdentityKey("file:///tmp/video.mp4"), "");

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

  tabs.set(12, {
    id: 12,
    url: "https://youtube.com/watch?v=old",
    title: "Old video"
  });
  store.setTabMeta(12, {
    lastUrl: "https://youtube.com/watch?v=old",
    title: "Old video",
    thumbnail: "https://example.com/old.jpg"
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
    { url: "https://youtube.com/watch?v=new" },
    tabs.get(12)
  );
  equal(store.getTabItems(12).length, 0);
  equal(store.getTabMeta(12).title, undefined);
  deepEqual(detached, [12]);

  store.addMedia(12, {
    url: "https://cdn.example.com/new.mp4",
    type: "video",
    duration: 100
  });
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
