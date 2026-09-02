"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

async function testHelperAutoPairing() {
  const source =
    fs.readFileSync(path.join(__dirname, "../src/ytdlp.js"), "utf8") +
    "\nglobalThis.__YtDlp = YtDlp;";
  const requests = [];
  const writes = [];
  const responses = [
    {
      ok: true,
      json: async () => ({
        ok: true,
        ytdlp: true,
        pairingMode: "available"
      })
    },
    {
      ok: true,
      json: async () => ({ ok: true, pairingMode: "paired" })
    }
  ];
  const context = {
    console,
    Uint8Array,
    AbortController,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return responses.shift();
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async (value) => writes.push(value)
        },
        onChanged: { addListener() {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const health = await context.__YtDlp.health(true);
  assert.equal(health.pairingMode, "paired");
  assert.equal(health.pairedNow, true);
  assert.equal(requests[1].url, "http://127.0.0.1:8787/pair");
  const token = JSON.parse(requests[1].options.body).token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(writes[0].helperToken, token);
}

function loadYtDlp(fetchImpl, extraContext = {}) {
  const source =
    fs.readFileSync(path.join(__dirname, "../src/ytdlp.js"), "utf8") +
    "\nglobalThis.__YtDlp = YtDlp;";
  const context = {
    console,
    Uint8Array,
    AbortController,
    crypto: webcrypto,
    // Fast-forward the 500 ms poll sleep.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms >= 500 ? 0 : ms, ...args),
    clearTimeout,
    Date,
    JSON,
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} }
      }
    },
    ...extraContext
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.__YtDlp;
}

async function testHelperPollingFailsFast() {
  // Helper restarted: /job/<id> 404s forever. Must not spin to the timeout.
  const calls = [];
  const restarted = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      return { ok: true, json: async () => ({ ok: true, jobId: "j1" }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: "job not found" }) };
  });
  await assert.rejects(
    () => restarted.downloadAndWait({ url: "https://x.test/v" }, () => {}, 60_000),
    /재시작/
  );
  assert.equal(
    calls.filter((c) => c.url.includes("/job/j1")).length,
    6,
    "six consecutive 404s are terminal"
  );

  // UI timeout: the helper job is cancelled instead of running untracked.
  const timeoutCalls = [];
  const slow = loadYtDlp(async (url, options = {}) => {
    timeoutCalls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      return { ok: true, json: async () => ({ ok: true, jobId: "j2" }) };
    }
    if (String(url).endsWith("/cancel")) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, job: { status: "running", percent: 10 } })
    };
  });
  await assert.rejects(
    () => slow.downloadAndWait({ url: "https://x.test/v" }, () => {}, 1),
    /시간 초과/
  );
  const cancel = timeoutCalls.find((c) => c.url.endsWith("/job/j2/cancel"));
  assert.ok(cancel, "timeout cancels the helper job");
  assert.deepEqual(JSON.parse(cancel.options.body), { purge: false });

  // Explicit user cancel asks the helper to purge partial files.
  const purgeCalls = [];
  const purging = loadYtDlp(async (url, options = {}) => {
    purgeCalls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await purging.cancelJob("j3", { purge: true });
  assert.deepEqual(JSON.parse(purgeCalls[0].options.body), { purge: true });
}

async function testHistoryCap() {
  const history = Array.from({ length: 40 }, (_, index) => ({
    id: `old-${index}`,
    title: `Old ${index}`,
    pageUrl: `https://example.test/${index}`,
    status: "done",
    at: 1000 - index
  }));
  let storedHistory;
  global.chrome = {
    storage: {
      local: {
        get: async (key) => {
          if (key === "uvdSettings") {
            return {
              uvdSettings: {
                maxHistory: 25,
                filenameTemplate: "legacy",
                _qualityDefaultVer: 3
              }
            };
          }
          if (key === "uvdHistory") return { uvdHistory: history };
          return {};
        },
        set: async (value) => {
          if (value.uvdHistory) storedHistory = value.uvdHistory;
        }
      }
    },
    runtime: { sendMessage: async () => {} }
  };
  const modulePath = require.resolve("../src/uvd-common.js");
  delete require.cache[modulePath];
  const UVD = require(modulePath);
  await UVD.appendHistory({
    id: "new",
    title: "New",
    pageUrl: "https://example.test/new",
    status: "done"
  });
  assert.equal(storedHistory.length, 25);
  assert.equal(storedHistory[0].id, "new");
  delete global.chrome;
}

function testPermissionReductionAndTrackPlumbing() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")
  );
  assert.equal(manifest.permissions.includes("activeTab"), false);
  assert.equal(
    manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
    false
  );
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), true);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    [
      "alarms",
      "contextMenus",
      "cookies",
      "declarativeNetRequest",
      "downloads",
      "notifications",
      "scripting",
      "storage",
      "tabs",
      "webRequest"
    ],
    "manifest keeps only permissions with active product paths"
  );
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);

  const helper = fs.readFileSync(
    path.join(__dirname, "../helper/yt_dlp_server.py"),
    "utf8"
  );
  assert.equal(helper.includes('payload.get("audioTrackId")'), true);
  assert.equal(helper.includes('payload.get("subtitleLanguages")'), true);
}

async function main() {
  await testHelperAutoPairing();
  await testHelperPollingFailsFast();
  await testHistoryCap();
  testPermissionReductionAndTrackPlumbing();
  console.log("remaining recommendations: tracks, permissions, pairing, and history cap passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
