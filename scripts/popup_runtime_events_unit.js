"use strict";

const assert = require("node:assert/strict");
const PopupRuntimeEvents = require("../src/popup-runtime-events.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function makeHarness(overrides = {}) {
  const calls = [];
  const state = {
    currentTabId: 7,
    currentTabUrl: "https://example.com/watch?v=current",
    allItems: [],
    historyItems: [],
    watchlistItems: [],
    activeTabName: "main",
    trackedJobIds: new Set()
  };
  const buttons = {
    "#btnLinkDl": { disabled: true, textContent: "준비 중" },
    "#btnThisPage": { disabled: true, textContent: "이 페이지" }
  };
  const deps = {
    $: (selector) => {
      calls.push(`$:${selector}`);
      return buttons[selector];
    },
    pageKey: (url) => new URL(url).searchParams.get("v") || new URL(url).pathname,
    ensureSiteItems: (items, page) => {
      calls.push(["ensureSiteItems", items, page]);
      return [{ ensured: true }, ...items];
    },
    render: () => calls.push("render"),
    refreshHelperStatus: () => calls.push("refreshHelperStatus"),
    applyJobProgress: (job) => calls.push(["applyJobProgress", job]),
    updateQuickPageUi: () => calls.push("updateQuickPageUi"),
    loadRecentStrip: () => calls.push("loadRecentStrip"),
    runningJobCount: () => 0,
    renderHistory: () => calls.push("renderHistory"),
    updateRetryFailedButton: () => calls.push("updateRetryFailedButton"),
    renderWatchlist: () => calls.push("renderWatchlist"),
    getCurrentTabId: () => state.currentTabId,
    getCurrentTabUrl: () => state.currentTabUrl,
    setCurrentTabUrl: (value) => {
      calls.push("setCurrentTabUrl");
      state.currentTabUrl = value;
    },
    setAllItems: (value) => {
      calls.push("setAllItems");
      state.allItems = value;
    },
    setHistoryItems: (value) => {
      calls.push("setHistoryItems");
      state.historyItems = value;
    },
    setWatchlistItems: (value) => {
      calls.push("setWatchlistItems");
      state.watchlistItems = value;
    },
    getActiveTabName: () => state.activeTabName,
    getTrackedJobIds: () => state.trackedJobIds,
    loadMedia: () => calls.push("loadMedia"),
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => {},
    ...overrides
  };
  return {
    calls,
    state,
    buttons,
    deps,
    handler: PopupRuntimeEvents.createHandler(deps)
  };
}

check(typeof PopupRuntimeEvents.createHandler, "function");
check(typeof PopupRuntimeEvents.bind, "function");

{
  let registered;
  const harness = makeHarness();
  const handler = PopupRuntimeEvents.bind({
    ...harness.deps,
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) {
            registered = value;
          }
        }
      }
    }
  });
  check(handler, registered, "bind registers and returns the same handler");
}

{
  const { handler, state, calls } = makeHarness();
  handler({
    type: "MEDIA_UPDATED",
    tabId: 7,
    items: [
      {
        url: "https://cdn.example/video.mp4",
        pageUrl: "https://example.com/watch?v=other",
        thumbnail: "wrong-site.jpg",
        isSiteDownload: true,
        title: "Other"
      },
      {
        url: "https://cdn.example/other.mp4",
        pageUrl: "https://example.com/watch?v=other",
        thumbnail: "wrong-media.jpg"
      },
      {
        url: "https://cdn.example/current.mp4",
        pageUrl: "https://example.com/watch?v=current",
        thumbnail: "current.jpg"
      }
    ]
  });
  check(state.allItems.slice(1), [
    {
      url: state.currentTabUrl,
      pageUrl: state.currentTabUrl,
      thumbnail: undefined,
      isSiteDownload: true,
      title: undefined,
      pageTitle: undefined,
      displayName: undefined,
      filename: undefined
    },
    {
      url: "https://cdn.example/current.mp4",
      pageUrl: "https://example.com/watch?v=current",
      thumbnail: "current.jpg"
    }
  ]);
  check(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "ensureSiteItems",
    "setAllItems",
    "render",
    "refreshHelperStatus"
  ]);
  check(calls[0][2], {
    url: state.currentTabUrl,
    title: ""
  });
}

{
  const { handler, state } = makeHarness();
  handler({
    type: "MEDIA_UPDATED",
    tabId: 7,
    pageUrl: state.currentTabUrl,
    items: [{
      url: "https://cdn.example/current-without-page.mp4",
      thumbnail: "current.jpg"
    }]
  });
  check(
    state.allItems[1],
    {
      url: "https://cdn.example/current-without-page.mp4",
      pageUrl: state.currentTabUrl,
      thumbnail: "current.jpg"
    },
    "tab-scoped network media without pageUrl is bound to the current page"
  );
}

{
  let stableItems = [{
    url: "https://cdn.test/snos-342/master.m3u8",
    pageUrl: "https://123av.com/ko/v/snos-342-uncensore",
    title: "SNOS-342 긴 실제 영상 제목",
    thumbnail: "https://img.test/snos-342.jpg"
  }];
  const timers = new Map();
  let timerId = 0;
  let patchCount = 0;
  let renderCount = 0;
  const harness = makeHarness({
    ensureSiteItems: (items) => {
      if (items.length) stableItems = items;
      return stableItems.map((item) => ({ ...item }));
    },
    render: () => {
      renderCount += 1;
    },
    patchMedia: () => {
      patchCount += 1;
      return true;
    },
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  harness.state.currentTabUrl =
    "https://123av.com/ko/v/snos-342-uncensore";
  harness.state.allItems = stableItems;

  for (const items of [
    [],
    [{
      url: "https://cdn.test/snos-342/master.m3u8",
      pageUrl: harness.state.currentTabUrl,
      title: "SNOS-342_720p"
    }],
    []
  ]) {
    harness.handler({
      type: "MEDIA_UPDATED",
      tabId: 7,
      pageUrl: harness.state.currentTabUrl,
      items
    });
    check(
      harness.state.allItems.length > 0,
      true,
      "rapid same-page media updates never expose an empty state"
    );
  }
  check(timers.size, 1, "rapid media updates coalesce into one paint");
  [...timers.values()][0]();
  check(patchCount, 1, "same-page media update patches the card in place");
  check(renderCount, 0, "same-page updates avoid full media rebuilds");

  harness.handler({
    type: "DOWNLOAD_JOB",
    job: { id: "rapid-job", status: "running", percent: 30 }
  });
  check(renderCount, 0, "job progress does not rebuild the media pane");
}

{
  const { handler, state, calls } = makeHarness();
  state.allItems = [{
    pageUrl: "https://www.youtube.com/watch?v=old",
    title: "Old video",
    thumbnail: "https://i.ytimg.com/vi/old/hqdefault.jpg"
  }];
  state.currentTabUrl = "https://www.youtube.com/watch?v=old";
  handler({
    type: "MEDIA_UPDATED",
    tabId: 7,
    pageUrl: "https://www.youtube.com/watch?v=new",
    pageKey: "yt:new",
    items: [{
      pageUrl: "https://www.youtube.com/watch?v=new",
      title: "New video"
    }]
  });
  check(
    state.currentTabUrl,
    "https://www.youtube.com/watch?v=new",
    "SPA update adopts the newly reported watch URL"
  );
  check(
    state.allItems,
    [
      { ensured: true },
      {
        pageUrl: "https://www.youtube.com/watch?v=new",
        title: undefined,
        thumbnail: undefined,
        pageTitle: undefined,
        displayName: undefined,
        filename: undefined
      }
    ],
    "SPA update paints the new payload/placeholder instead of an empty list"
  );
  check(calls, [
    "setCurrentTabUrl",
    [
      "ensureSiteItems",
      [{
        pageUrl: "https://www.youtube.com/watch?v=new",
        title: undefined,
        thumbnail: undefined,
        pageTitle: undefined,
        displayName: undefined,
        filename: undefined
      }],
      {
        url: "https://www.youtube.com/watch?v=new",
        title: ""
      }
    ],
    "setAllItems",
    "render",
    "refreshHelperStatus",
    "loadMedia"
  ]);
}

{
  const { handler, state } = makeHarness();
  state.currentTabUrl = "https://www.youtube.com/watch?v=current";
  handler({
    type: "MEDIA_UPDATED",
    tabId: 7,
    pageUrl: state.currentTabUrl,
    identityConfirmed: false,
    items: [{
      pageUrl: state.currentTabUrl,
      title: "Previous video",
      pageTitle: "Previous video",
      thumbnail: "https://i.ytimg.com/vi/previous/hqdefault.jpg"
    }]
  });
  check(
    state.allItems[1],
    {
      pageUrl: state.currentTabUrl,
      title: undefined,
      pageTitle: undefined,
      thumbnail: undefined,
      displayName: undefined,
      filename: undefined
    },
    "unconfirmed YouTube updates cannot repaint old identity-bound metadata"
  );
}

{
  const { handler, calls } = makeHarness();
  handler({ type: "MEDIA_UPDATED", tabId: 99, items: [{}] });
  check(calls, [], "media updates from another tab are ignored");
}

{
  const { handler, state, buttons, calls } = makeHarness();
  const job = { id: "job-1", status: "done" };
  handler({ type: "DOWNLOAD_JOB", job });
  check([...state.trackedJobIds], ["job-1"]);
  check(buttons, {
    "#btnLinkDl": { disabled: false, textContent: "받기" },
    "#btnThisPage": { disabled: false, textContent: "이 페이지" }
  });
  check(calls, [
    ["applyJobProgress", job],
    "$:#btnLinkDl",
    "$:#btnThisPage",
    "updateQuickPageUi",
    "loadRecentStrip"
  ]);
}

{
  const { handler, buttons } = makeHarness();
  buttons["#btnLinkDl"].textContent = "추가…";
  handler({ type: "DOWNLOAD_JOB", job: { status: "running" } });
  check(buttons["#btnLinkDl"], { disabled: true, textContent: "추가…" });
}

{
  const { handler, calls } = makeHarness();
  handler({ type: "HLS_PROGRESS", tabId: 99 });
  handler({ type: "HLS_PROGRESS", tabId: 99, progress: { percent: 10 } });
  check(calls, [], "missing and foreign progress are ignored");
}

{
  const { handler, state, calls } = makeHarness();
  const progress = { jobId: "job-2", percent: 20 };
  handler({ type: "HLS_PROGRESS", tabId: 99, progress });
  check([...state.trackedJobIds], ["job-2"]);
  check(calls, [["applyJobProgress", progress]]);
}

for (const message of [
  { type: "HLS_PROGRESS", tabId: 7, progress: { percent: 1 } },
  { type: "HLS_PROGRESS", tabId: -1, progress: { percent: 2 } },
  { type: "HLS_PROGRESS", tabId: 99, progress: { global: true, percent: 3 } }
]) {
  const { handler, calls } = makeHarness();
  handler(message);
  check(calls, [["applyJobProgress", message.progress]]);
}

{
  const harness = makeHarness({ runningJobCount: () => 1 });
  const progress = { percent: 40 };
  harness.handler({ type: "HLS_PROGRESS", tabId: 99, progress });
  check(harness.calls, [["applyJobProgress", progress]]);
}

{
  const { handler, state, calls } = makeHarness();
  state.activeTabName = "history";
  const history = [{ id: "history-1" }];
  handler({ type: "HISTORY_UPDATED", history });
  check(state.historyItems, history);
  check(calls, [
    "setHistoryItems",
    "loadRecentStrip",
    "renderHistory",
    "updateRetryFailedButton"
  ]);
}

{
  const { handler, calls } = makeHarness();
  handler({ type: "HISTORY_UPDATED", history: [] });
  check(calls, [
    "setHistoryItems",
    "loadRecentStrip",
    "updateRetryFailedButton"
  ]);
}

{
  const { handler, state, calls } = makeHarness();
  state.activeTabName = "watch";
  const watchlist = [{ id: "watch-1" }];
  handler({ type: "WATCHLIST_UPDATED", watchlist });
  check(state.watchlistItems, watchlist);
  check(calls, ["setWatchlistItems", "renderWatchlist"]);
}

{
  const { handler, state, calls } = makeHarness();
  handler({ type: "WATCHLIST_UPDATED", watchlist: "invalid" });
  check(state.watchlistItems, []);
  check(calls, []);
}

console.log(`popup runtime events: ${assertions} assertions passed`);
