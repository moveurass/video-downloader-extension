"use strict";

const assert = require("node:assert/strict");
const { createController } = require("../src/background-context-menus.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function makeHarness() {
  const installed = event();
  const startup = event();
  const clicked = event();
  const calls = [];
  const menus = [];
  const media = new Map();
  const chrome = {
    runtime: {
      onInstalled: installed,
      onStartup: startup
    },
    contextMenus: {
      onClicked: clicked,
      removeAll(callback) {
        calls.push(["removeAll"]);
        callback();
      },
      create(details) {
        menus.push(details);
      }
    },
    tabs: {
      async sendMessage(...args) {
        calls.push(["sendMessage", ...args]);
      }
    },
    notifications: {
      create(details) {
        calls.push(["notification", details]);
      }
    }
  };
  const controller = createController({
    chrome,
    UVD: {},
    Naming: {},
    addMedia(tabId, item) {
      calls.push(["addMedia", tabId, item]);
      media.set(item.url, { ...item, filename: "resolved.mp4" });
    },
    getTabMap() {
      return media;
    },
    resolveFilename(...args) {
      calls.push(["resolveFilename", ...args]);
      return "resolved.mp4";
    },
    lockSaveName() {
      return "locked.mp4";
    },
    needsYtDlpHelper(url, pageUrl) {
      calls.push(["needsYtDlpHelper", url, pageUrl]);
      return url.includes("helper.test");
    },
    async getMediaForTabAsync(...args) {
      calls.push(["getMediaForTabAsync", ...args]);
      return [{
        url: "https://cdn.test/best.m3u8",
        title: "Best title",
        filename: "best.mp4",
        type: "video"
      }];
    },
    async runTrackedDownloadAsync(meta, operation) {
      calls.push(["runTrackedDownloadAsync", meta]);
      return operation();
    },
    async downloadSmart(...args) {
      calls.push(["downloadSmart", ...args]);
      return { ok: true };
    },
    async downloadPageFromUi(...args) {
      calls.push(["downloadPageFromUi", ...args]);
      return { ok: true };
    },
    setTimeout(callback, delay) {
      calls.push(["setTimeout", delay]);
      callback();
    },
    console: {
      warn(...args) {
        calls.push(["warn", ...args]);
      }
    }
  });
  return { controller, installed, startup, clicked, calls, menus };
}

async function main() {
  const harness = makeHarness();
  const { controller, installed, startup, clicked, calls, menus } = harness;

  deepEqual(calls, []);
  controller.bind();
  controller.bind();
  equal(installed.listeners.length, 1);
  equal(startup.listeners.length, 1);
  equal(clicked.listeners.length, 1);
  deepEqual(calls, [["removeAll"]]);
  deepEqual(menus, [
    {
      id: "uvd-download-media",
      title: "이 미디어 다운로드",
      contexts: ["video", "audio"]
    },
    {
      id: "uvd-download-best",
      title: "이 페이지 영상 다운로드",
      contexts: ["page", "frame"]
    },
    {
      id: "uvd-download-link",
      title: "이 링크 영상 다운로드",
      contexts: ["link"]
    },
    {
      id: "uvd-download-selection",
      title: "선택한 링크로 영상 다운로드",
      contexts: ["selection"]
    }
  ]);

  installed.listeners[0]();
  startup.listeners[0]();
  equal(calls.filter(([name]) => name === "removeAll").length, 3);

  const click = clicked.listeners[0];
  calls.length = 0;
  await click(
    {
      menuItemId: "uvd-download-media",
      srcUrl: "https://cdn.test/audio.mp3",
      mediaType: "audio"
    },
    { id: 7, url: "https://page.test/watch" }
  );
  deepEqual(calls[0], [
    "addMedia",
    7,
    {
      url: "https://cdn.test/audio.mp3",
      type: "audio",
      source: "context-menu",
      title: "",
      pageTitle: "",
      pageUrl: "https://page.test/watch"
    }
  ]);
  equal(calls[1][0], "resolveFilename");
  deepEqual(calls[2], [
    "runTrackedDownloadAsync",
    {
      tabId: 7,
      title: "resolved.mp4",
      pageUrl: "https://page.test/watch",
      filename: "resolved.mp4"
    }
  ]);
  deepEqual(calls[3], [
    "downloadSmart",
    7,
    "https://cdn.test/audio.mp3",
    "resolved.mp4",
    "best",
    "audio",
    {
      url: "https://cdn.test/audio.mp3",
      type: "audio",
      source: "context-menu",
      title: "",
      pageTitle: "",
      pageUrl: "https://page.test/watch",
      filename: "resolved.mp4"
    },
    { pageUrl: "https://page.test/watch" }
  ]);

  calls.length = 0;
  await click(
    { menuItemId: "uvd-download-link", linkUrl: "https://link.test/video" },
    { id: 8, url: "https://page.test" }
  );
  deepEqual(calls, [
    [
      "runTrackedDownloadAsync",
      {
        tabId: 8,
        title: "",
        pageUrl: "https://link.test/video",
        filename: ""
      }
    ],
    ["downloadPageFromUi", 8, "https://link.test/video", "best"]
  ]);

  calls.length = 0;
  await click(
    {
      menuItemId: "uvd-download-selection",
      selectionText: "watch https://selection.test/video now"
    },
    { id: 9 }
  );
  equal(calls[0][1].pageUrl, "https://selection.test/video");
  deepEqual(calls[1], [
    "downloadPageFromUi",
    9,
    "https://selection.test/video",
    "best"
  ]);

  calls.length = 0;
  await click(
    { menuItemId: "uvd-download-best" },
    { id: 10, url: "https://helper.test/post", title: "Helper title" }
  );
  deepEqual(calls.at(-1), [
    "downloadPageFromUi",
    10,
    "https://helper.test/post",
    "best"
  ]);
  equal(calls.some(([name]) => name === "sendMessage"), false);

  calls.length = 0;
  await click(
    { menuItemId: "uvd-download-best" },
    { id: 11, url: "https://plain.test/watch" }
  );
  deepEqual(calls[1], ["sendMessage", 11, { type: "SCAN_NOW" }]);
  deepEqual(calls[2], ["setTimeout", 800]);
  deepEqual(calls[3], [
    "getMediaForTabAsync",
    11,
    { pageUrl: "https://plain.test/watch" }
  ]);
  deepEqual(calls.at(-1), [
    "downloadSmart",
    11,
    "https://cdn.test/best.m3u8",
    "resolved.mp4",
    "best",
    "video",
    {
      url: "https://cdn.test/best.m3u8",
      title: "Best title",
      filename: "best.mp4",
      type: "video"
    },
    { pageUrl: "https://plain.test/watch" }
  ]);

  calls.length = 0;
  await click(
    { menuItemId: "uvd-download-selection", selectionText: "not a link" },
    { id: 12 }
  );
  equal(calls[0][0], "warn");
  equal(calls[1][0], "notification");
  equal(calls[1][1].message, "선택한 텍스트에 링크가 없습니다");

  calls.length = 0;
  equal(await click({ menuItemId: "uvd-download-best" }, {}), undefined);
  deepEqual(calls, []);

  console.log(`background context menus unit: ${assertions} assertions`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
