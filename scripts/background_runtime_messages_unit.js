"use strict";

const assert = require("node:assert/strict");
const {
  createDispatcher,
  DEDICATED_MESSAGE_TYPES
} = require("../src/background-runtime-messages.js");

function makeHarness(options = {}) {
  const calls = [];
  const responses = [];
  const unhandled = { handled: false, keepChannel: false };
  const resultFor = (name) =>
    options.handledBy === name
      ? { handled: true, keepChannel: options.keepChannel ?? true }
      : unhandled;
  const handler = (name) => (message, tabId, sendResponse) => {
    calls.push({ name, message, tabId, sendResponse });
    return resultFor(name);
  };
  const deps = {
    handleDownloadMessage(message, sendResponse) {
      calls.push({ name: "download", message, sendResponse });
      return resultFor("download");
    },
    routeBackgroundMessage(message, sendResponse) {
      calls.push({ name: "background", message, sendResponse });
      return resultFor("background");
    },
    handleQualityMessage(message, tabId) {
      calls.push({ name: "quality", message, tabId });
      return options.qualityError
        ? Promise.reject(new Error(options.qualityError))
        : Promise.resolve({ ok: true, qualities: ["best"] });
    },
    handleBackgroundDownloadMessage: handler("background-download"),
    handleBackgroundSeriesMessage: handler("series"),
    handleMediaMessage(message, tabId, sender, sendResponse) {
      calls.push({ name: "media", message, tabId, sender, sendResponse });
      return resultFor("media");
    },
    handleHelperMessage: handler("helper"),
    handleChunkAssembly(message, sendResponse) {
      calls.push({ name: "chunk", message, sendResponse });
      return resultFor("chunk");
    },
    handleDirectDownloadMessage: handler("direct")
  };
  const { dispatch } = createDispatcher(deps);
  const sender = { tab: { id: 17 } };
  const sendResponse = (response) => responses.push(response);
  return { dispatch, sender, sendResponse, calls, responses };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  assert.equal(DEDICATED_MESSAGE_TYPES.has("SAVE_PAGE_DONE"), true);
  const dedicated = makeHarness();
  assert.equal(
    dedicated.dispatch(
      { type: "OFFSCREEN_SAVE_IDB" },
      dedicated.sender,
      dedicated.sendResponse
    ),
    false
  );
  assert.equal(dedicated.calls.length, 0);

  const first = makeHarness({ handledBy: "background", keepChannel: false });
  assert.equal(
    first.dispatch({ type: "PING" }, first.sender, first.sendResponse),
    false
  );
  assert.deepEqual(first.calls.map((call) => call.name), [
    "download",
    "background"
  ]);

  const ordered = makeHarness({ handledBy: "direct" });
  assert.equal(
    ordered.dispatch({ type: "DIRECT", tabId: 22 }, ordered.sender, ordered.sendResponse),
    true
  );
  assert.deepEqual(ordered.calls.map((call) => call.name), [
    "download",
    "background",
    "background-download",
    "series",
    "media",
    "helper",
    "chunk",
    "direct"
  ]);
  assert.equal(ordered.calls.find((call) => call.name === "media").tabId, 22);
  assert.equal(
    ordered.calls.find((call) => call.name === "media").sender,
    ordered.sender
  );

  const quality = makeHarness();
  assert.equal(
    quality.dispatch({ type: "LIST_QUALITIES" }, quality.sender, quality.sendResponse),
    true
  );
  await flush();
  assert.deepEqual(quality.responses, [{ ok: true, qualities: ["best"] }]);
  assert.deepEqual(quality.calls.map((call) => call.name), [
    "download",
    "background",
    "quality"
  ]);
  assert.equal(quality.calls[2].tabId, 17);

  const qualityFailure = makeHarness({ qualityError: "probe failed" });
  qualityFailure.dispatch(
    { type: "LIST_QUALITIES" },
    qualityFailure.sender,
    qualityFailure.sendResponse
  );
  await flush();
  assert.deepEqual(qualityFailure.responses, [{
    ok: false,
    error: "probe failed",
    qualities: [{ id: "best", label: "최고" }]
  }]);

  const none = makeHarness();
  assert.equal(
    none.dispatch({ type: "UNKNOWN" }, none.sender, none.sendResponse),
    false
  );

  console.log("background runtime messages: exclusions and handler order passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
