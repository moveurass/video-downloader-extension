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
  const BRIDGE_NONCE = "0123456789abcdef0123456789abcdef";
  const sandbox = {
    window,
    document: {
      currentScript: {
        src: `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/injected.js#${BRIDGE_NONCE}`
      }
    },
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
  return { sandbox, posted, appended, MediaSource: sandbox.MediaSource, nonce: BRIDGE_NONCE };
}

function ask(page, type) {
  const requestId = `${type}_${Math.random()}`;
  const before = page.posted.length;
  page.sandbox.window.postMessage(
    { source: "uvd-content", nonce: page.nonce, type, requestId },
    "*"
  );
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
  page.sandbox.window.postMessage(
    { source: "uvd-content", nonce: page.nonce, type: "DISARM_CAPTURE" },
    "*"
  );

  // A page-forged ARM_CAPTURE without the nonce must not arm capture.
  page.sandbox.window.postMessage({ source: "uvd-content", type: "ARM_CAPTURE" }, "*");
  assert.equal(ask(page, "CAPTURE_STATUS").armed, false, "forged ARM_CAPTURE is ignored");
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
  assert.match(content, /data\.nonce !== BRIDGE_NONCE/, "content ignores page messages without the nonce");
  assert.match(content, /\.player-wrap/, "known-code cover reads player-wrap background");
  // Known-code SPA navigation must be detected and its stale DOM gated.
  // Content scripts run in an isolated world: patching history.pushState
  // there never sees the page's own calls, so navigation must come from the
  // Navigation API and from each scan re-checking identity.
  assert.doesNotMatch(
    content,
    /history\[method\] = function/,
    "no isolated-world history patches (they never fire)"
  );
  assert.match(
    content,
    /navigation\?\.addEventListener\?\.\("currententrychange"/,
    "SPA navigation is heard through the Navigation API"
  );
  assert.match(
    content,
    /function scanPage\(\) \{[\s\S]{0,300}refreshAfterSpaNavigation\(false\);/,
    "every scan re-checks page identity before reading the DOM"
  );
  assert.match(
    content,
    /if \(probeCode\) return probeCode === code;\s*\}[\s\S]{0,300}KNOWN_CODE_DOM_SETTLE_MS;\s*\}/,
    "an h1/title naming another code outranks the settle window"
  );
  assert.match(
    content,
    /const knownCode = knownCodePageIdentity\(\);\s*\n\s*if \(knownCode\) return `code:\$\{knownCode\}`;/,
    "navigation identity is code-based on known-code pages"
  );
  assert.match(
    content,
    /knownCodeSourceIsCurrent\(t\)/,
    "page titles pass the code-identity gate"
  );
  assert.match(
    content,
    /knownCodePageCode && !knownCodeCoverIsCurrent\(u\)/,
    "page cover candidates pass the code-identity gate"
  );
  assert.match(
    content,
    /if \(p && knownCodeCoverIsCurrent\(p\)\) return p;/,
    "video posters pass the code-identity gate"
  );
  // A cover once seen as code A's is never code B's, whatever the settle
  // heuristics say (a head updated before the player area passed them all).
  assert.match(
    content,
    /const owner = knownCodeCoverOwners\.get\(absUrl\(url\) \|\| ""\);\s*if \(owner && owner !== code\) return false;/,
    "covers owned by another code are refused before any heuristic"
  );
  assert.match(
    content,
    /claimKnownCodeCovers\(u\);\s*return u;/,
    "the chosen known-code cover claims its page's cover sources"
  );
  assert.match(
    content,
    /lastNavigationChangeAt = Date\.now\(\)/,
    "identity changes start the stale-DOM settle window"
  );
  assert.match(
    content,
    /knownCodeTransitionSettled/,
    "codeless sources wait on a settlement check, not just a timer"
  );
  assert.match(
    content,
    /"loadstart"/,
    "media loadstart latches the transition as settled"
  );
  assert.match(
    content,
    /KNOWN_CODE_DOM_SETTLE_MS \+ 200/,
    "a rescan lands just past the settle window for codeless covers"
  );

  console.log("injected capture: opt-in retention, budget, export handshake passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
