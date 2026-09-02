"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Minimal page-world sandbox for src/injected.js */
function makePage() {
  const listeners = [];
  const posted = [];
  const window = {
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    postMessage(data) {
      posted.push(data);
      // Deliver like the browser would: same window, async not required here.
      for (const fn of listeners) fn({ source: window, data });
    }
  };
  const appended = [];
  class SourceBuffer {
    appendBuffer(data) {
      appended.push(data.byteLength);
    }
  }
  class MediaSource {
    addSourceBuffer() {
      return new SourceBuffer();
    }
  }
  class XMLHttpRequest {
    open() {}
    send() {}
    addEventListener() {}
  }
  class HTMLMediaElement {
    play() {}
  }
  const sandbox = {
    window,
    MediaSource,
    XMLHttpRequest,
    HTMLMediaElement,
    ArrayBuffer,
    Uint8Array,
    Blob,
    URL: { createObjectURL: () => "blob:page/x" },
    location: { href: "https://site.test/watch/1", hostname: "site.test" },
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: class {
      observe() {}
    },
    Date,
    Object,
    setTimeout,
    console
  };
  sandbox.window.fetch = async () => ({
    headers: { get: () => "video/mp2t" },
    url: "https://cdn.test/seg1.ts",
    clone() {
      return { arrayBuffer: async () => new ArrayBuffer(4096) };
    }
  });
  Object.assign(sandbox, {
    Response: class {},
    self: window
  });
  window.MediaSource = MediaSource;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/injected.js"), "utf8"),
    sandbox
  );
  return { sandbox, posted, appended, MediaSource: sandbox.MediaSource };
}

function ask(page, type) {
  const requestId = `${type}_${Math.random()}`;
  const before = page.posted.length;
  page.sandbox.window.postMessage({ source: "uvd-content", type, requestId }, "*");
  const reply = page.posted
    .slice(before)
    .find((m) => m.source === "universal-video-downloader" && m.requestId === requestId);
  // Objects come from the vm realm; normalize so deepEqual compares structure.
  return reply ? JSON.parse(JSON.stringify(reply)) : reply;
}

async function main() {
  const page = makePage();
  const ms = new page.MediaSource();
  const sb = ms.addSourceBuffer("video/mp4");

  // Unarmed: playback passes through and nothing is retained.
  sb.appendBuffer(new Uint8Array(100_000));
  sb.appendBuffer(new Uint8Array(100_000));
  assert.deepEqual(page.appended, [100_000, 100_000], "player still receives data");
  let status = ask(page, "CAPTURE_STATUS");
  assert.equal(status.armed, false);
  assert.deepEqual(status.mse, [{ total: 0, mime: "video/mp4" }]);
  assert.equal(status.budgetBytes, 200 * 1024 * 1024, "budget lowered from 800MB/store");

  // fetch hook: no clone()/buffering when unarmed
  await page.sandbox.window.fetch("https://cdn.test/seg1.ts");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ask(page, "CAPTURE_STATUS").netTotal, 0);

  // First export on an unarmed page arms capture and asks for a replay.
  const first = ask(page, "EXPORT_CAPTURE");
  assert.equal(first.ok, false);
  assert.equal(first.needsReplay, true);
  assert.equal(first.armed, true);

  // Armed: bytes are retained (MSE and network) within the shared budget.
  sb.appendBuffer(new Uint8Array(60_000));
  await page.sandbox.window.fetch("https://cdn.test/seg2.ts");
  await new Promise((resolve) => setImmediate(resolve));
  status = ask(page, "CAPTURE_STATUS");
  assert.equal(status.armed, true);
  assert.equal(status.mse[0].total, 60_000);
  assert.equal(status.netTotal, 4096);
  const exported = ask(page, "EXPORT_CAPTURE");
  assert.equal(exported.ok, true);
  assert.equal(exported.method, "mse");
  assert.equal(exported.size, 60_000);

  // Budget is enforced across stores.
  sb.appendBuffer(new Uint8Array(200 * 1024 * 1024));
  assert.equal(ask(page, "CAPTURE_STATUS").mse[0].total, 60_000, "over-budget append is not retained");

  // Disarm clears everything.
  page.sandbox.window.postMessage({ source: "uvd-content", type: "DISARM_CAPTURE" }, "*");
  status = ask(page, "CAPTURE_STATUS");
  assert.equal(status.armed, false);
  assert.equal(status.netTotal, 0);
  assert.deepEqual(status.mse, []);

  // Explicit arm from the content script (captureAlways setting).
  const armed = ask(page, "ARM_CAPTURE");
  assert.equal(armed.armed, true);

  const settings = fs.readFileSync(path.join(__dirname, "../src/uvd-common.js"), "utf8");
  assert.match(settings, /captureAlways:\s*false/, "capture is opt-in by default");
  const content = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  assert.match(content, /captureAlways === true\) armPageCapture\(\)/);

  console.log("injected capture: opt-in retention, budget, export handshake passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
