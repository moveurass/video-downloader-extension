"use strict";

const assert = require("node:assert/strict");

const modulePath = require.resolve("../src/popup-init.js");
const sentinel = { untouched: true };
globalThis.UVDPopupInit = sentinel;
delete require.cache[modulePath];

const PopupInit = require(modulePath);
assert.equal(globalThis.UVDPopupInit, sentinel, "CommonJS require does not publish globally");
assert.deepEqual(Object.keys(PopupInit), ["start"]);
assert.equal(typeof PopupInit.start, "function");

const calls = [];
const apiProxy = (name) =>
  new Proxy(
    {},
    {
      get(_target, property) {
        return (...args) => {
          calls.push(`${name}.${String(property)}`);
          return args;
        };
      }
    }
  );
const moduleProxy = (name) =>
  new Proxy(
    {},
    {
      get(_target, property) {
        return (...args) => {
          calls.push(`${name}.${String(property)}`);
          return apiProxy(name);
        };
      }
    }
  );

const document = {
  title: "Injected popup",
  querySelector(selector) {
    calls.push(`document.querySelector:${selector}`);
    return { selector };
  },
  querySelectorAll() {
    return [];
  }
};

const root = {
  document,
  navigator: {},
  setInterval() {},
  clearInterval() {},
  setTimeout() {},
  URL,
  chrome: {
    runtime: { sendMessage() {} },
    tabs: { sendMessage() {} }
  },
  UVD: { DEFAULT_SETTINGS: { injected: true } },
  UVDSites: apiProxy("UVDSites"),
  UVDPopupMedia: apiProxy("PopupMedia"),
  Naming: {},
  UVDQuality: {},
  UVDQueueState: {},
  UVDPopupQueueUI: {},
  UVDPopupLibraryUI: {},
  UVDPopupSeriesNetwork: {},
  UVDPopupWatchlistUI: {}
};

for (const name of [
  "UVDPopupDisplayUtils",
  "UVDPopupHelperState",
  "UVDPopupQualityState",
  "UVDPopupProgressUI",
  "UVDPopupRecoveryUI",
  "UVDPopupClipboardHistory",
  "UVDPopupSettingsUI",
  "UVDPopupSeriesUI",
  "UVDPopupSeriesDiscovery",
  "UVDPopupSeriesWatchlistFlow",
  "UVDPopupSeriesBannerUI",
  "UVDPopupDuplicateConfirmation",
  "UVDPopupPlaylistUI",
  "UVDPopupMediaRenderer",
  "UVDPopupMediaLoader",
  "UVDPopupDownloadRequests",
  "UVDPopupDomEvents",
  "UVDPopupRuntimeEvents"
]) {
  root[name] = moduleProxy(name);
}

assert.equal(PopupInit.start(root), undefined, "start preserves top-level return behavior");
assert.deepEqual(calls.slice(0, 6), [
  "document.querySelector:#list",
  "document.querySelector:#empty",
  "document.querySelector:#pageHost",
  "document.querySelector:#helperBar",
  "document.querySelector:#helperDot",
  "document.querySelector:#helperText"
]);
assert.ok(
  calls.indexOf("UVDPopupDomEvents.bind") <
    calls.indexOf("UVDPopupClipboardHistory.autofillOnce"),
  "DOM binding precedes one-shot clipboard autofill"
);
assert.ok(
  calls.indexOf("UVDPopupClipboardHistory.autofillOnce") <
    calls.indexOf("UVDPopupRuntimeEvents.bind"),
  "clipboard autofill precedes runtime binding"
);
assert.ok(
  calls.indexOf("UVDPopupRuntimeEvents.bind") <
    calls.indexOf("UVDPopupSettingsUI.loadSettings"),
  "runtime binding precedes async bootstrap"
);

(async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  const bootstrapCalls = calls.filter((call) =>
    [
      "UVDPopupSettingsUI.loadSettings",
      "UVDPopupClipboardHistory.setupClipboardWatch",
      "UVDPopupProgressUI.restoreActiveDownloads",
      "UVDPopupMediaLoader.loadMedia",
      "UVDPopupDisplayUtils.updateLinkCount",
      "UVDPopupClipboardHistory.loadRecentStrip"
    ].includes(call)
  );
  assert.deepEqual(bootstrapCalls, [
    "UVDPopupSettingsUI.loadSettings",
    "UVDPopupClipboardHistory.setupClipboardWatch",
    "UVDPopupProgressUI.restoreActiveDownloads",
    "UVDPopupMediaLoader.loadMedia",
    "UVDPopupDisplayUtils.updateLinkCount",
    "UVDPopupClipboardHistory.loadRecentStrip"
  ]);
  console.log("popup init: side-effect-free export and injected-root startup passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
