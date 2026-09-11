"use strict";

const assert = require("node:assert/strict");
const Privileges = require("../src/message-privileges.js");
const { createDispatcher } = require("../src/background-runtime-messages.js");

const extensionSender = {
  url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/popup.html"
};
const contentSender = {
  tab: { id: 9, url: "https://watch.example/v" },
  url: "https://watch.example/v"
};

assert.equal(Privileges.senderMaySend("SET_SETTINGS", extensionSender), true);
assert.equal(Privileges.senderMaySend("SET_SETTINGS", contentSender), false);
assert.equal(Privileges.senderMaySend("FILES_TRASH", contentSender), false);
assert.equal(Privileges.senderMaySend("PAGE_MEDIA", contentSender), true);
assert.equal(Privileges.senderMaySend("VIDEO_CHUNK", contentSender), true);
assert.equal(Privileges.isContentScriptSender(contentSender), true);
assert.equal(Privileges.isExtensionSender(extensionSender), true);

const calls = [];
const { dispatch } = createDispatcher({
  privileges: Privileges,
  handleDownloadMessage() {
    return { handled: false, keepChannel: false };
  },
  routeBackgroundMessage(message, sendResponse) {
    calls.push(message.type);
    sendResponse({ ok: true });
    return { handled: true, keepChannel: false };
  },
  handleQualityMessage() {
    return Promise.resolve({ ok: true });
  },
  handleBackgroundDownloadMessage() {
    return { handled: false, keepChannel: false };
  },
  handleBackgroundSeriesMessage() {
    return { handled: false, keepChannel: false };
  },
  handleMediaMessage() {
    return { handled: false, keepChannel: false };
  },
  handleHelperMessage() {
    return { handled: false, keepChannel: false };
  },
  handleChunkAssembly() {
    return { handled: false, keepChannel: false };
  },
  handleDirectDownloadMessage() {
    return { handled: false, keepChannel: false };
  }
});

const blocked = [];
assert.equal(
  dispatch({ type: "SET_SETTINGS" }, contentSender, (value) => blocked.push(value)),
  false
);
assert.deepEqual(blocked, [{ ok: false, error: "forbidden" }]);
assert.deepEqual(calls, []);

assert.equal(
  dispatch({ type: "PING" }, extensionSender, () => {}),
  false
);
assert.deepEqual(calls, ["PING"]);

console.log("message privileges: content scripts cannot reach privileged routes");
