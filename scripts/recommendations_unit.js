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
        session: {
          get: async () => ({}),
          set: async (value) => writes.push(value),
          setAccessLevel: async () => {}
        },
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
        session: { get: async () => ({}), set: async () => {}, setAccessLevel: async () => {} },
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

async function testPairingRecovery() {
  const pairedHealth = { ok: true, ytdlp: true, pairingMode: "paired" };

  // 1) Extension reinstalled: helper is paired, extension has no token →
  //    same-origin re-pair succeeds and the new token is stored.
  let requests = [];
  let writes = [];
  let ytdlp = loadYtDlp(
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) return { ok: true, json: async () => pairedHealth };
      if (String(url).endsWith("/pair")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    },
    {
      chrome: {
        storage: {
          session: { get: async () => ({}), set: async (v) => writes.push(v), setAccessLevel: async () => {} },
          local: { get: async () => ({}), set: async (v) => writes.push(v) },
          onChanged: { addListener() {} }
        }
      }
    }
  );
  let health = await ytdlp.health(true);
  assert.equal(health.pairingMode, "paired");
  assert.equal(health.pairedNow, true);
  assert.equal(health.authRequired, undefined);
  assert.equal(writes.length, 1);
  assert.match(writes[0].helperToken, /^[a-f0-9]{64}$/);

  // 2) Helper cache wiped ("available") while the extension still holds a
  //    stale token → pair again with a fresh token.
  requests = [];
  writes = [];
  ytdlp = loadYtDlp(
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) {
        return { ok: true, json: async () => ({ ok: true, ytdlp: true, pairingMode: "available" }) };
      }
      if (String(url).endsWith("/pair")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ ok: true }) };
    },
    {
      chrome: {
        storage: {
          session: { get: async () => ({}), set: async (v) => writes.push(v), setAccessLevel: async () => {} },
          local: { get: async () => ({ helperToken: "stale".repeat(8) }), set: async (v) => writes.push(v) },
          onChanged: { addListener() {} }
        }
      }
    }
  );
  health = await ytdlp.health(true);
  assert.equal(health.pairedNow, true);
  assert.equal(requests.some((r) => r.url.endsWith("/pair")), true, "stale token does not block re-pair");
  assert.notEqual(writes[0].helperToken, "stale".repeat(8));

  // 3) Paired helper rejects our token (403 on a protected route) → re-pair.
  requests = [];
  writes = [];
  ytdlp = loadYtDlp(
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) return { ok: true, json: async () => pairedHealth };
      if (String(url).includes("/job/__uvd_token_probe__")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "forbidden origin" }) };
      }
      if (String(url).endsWith("/pair")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ ok: true }) };
    },
    {
      chrome: {
        storage: {
          session: { get: async () => ({}), set: async (v) => writes.push(v), setAccessLevel: async () => {} },
          local: { get: async () => ({ helperToken: "old".repeat(12) }), set: async (v) => writes.push(v) },
          onChanged: { addListener() {} }
        }
      }
    }
  );
  health = await ytdlp.health(true);
  assert.equal(health.pairedNow, true);
  assert.equal(requests.filter((r) => r.url.endsWith("/pair")).length, 1);

  // 4) Genuinely paired to another extension → clear, actionable error.
  ytdlp = loadYtDlp(async (url) => {
    if (String(url).endsWith("/health")) return { ok: true, json: async () => pairedHealth };
    if (String(url).endsWith("/pair")) {
      return { ok: false, status: 409, json: async () => ({ ok: false, error: "helper already paired" }) };
    }
    return { ok: false, status: 403, json: async () => ({ ok: false }) };
  });
  health = await ytdlp.health(true);
  assert.equal(health.authRequired, true);
  assert.match(health.pairingError, /pairing\.json/);
  assert.equal(await ytdlp.available(), false);
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

  const pausedCalls = [];
  const paused = loadYtDlp(async (url, options = {}) => {
    pausedCalls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      return { ok: true, json: async () => ({ ok: true, jobId: "paused-job" }) };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        job: { status: "paused", pause: true, percent: 35 }
      })
    };
  });
  let firstProgress;
  await assert.rejects(
    () =>
      paused.downloadAndWait(
        { url: "https://x.test/v" },
        (progress) => {
          firstProgress ||= progress;
        },
        60_000
      ),
    (error) => error?.code === "PAUSED" && error.message === "PAUSED"
  );
  assert.equal(firstProgress.helperJobId, "paused-job");

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
  assert.deepEqual(JSON.parse(cancel.options.body), {});

  // Explicit user cancel asks the helper to purge partial files.
  const purgeCalls = [];
  const purging = loadYtDlp(async (url, options = {}) => {
    purgeCalls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await purging.cancelJob("j3", { purge: true });
  assert.deepEqual(JSON.parse(purgeCalls[0].options.body), { purge: true });

  await purging.cancelJob("j4", { pause: true });
  const pauseBody = JSON.parse(purgeCalls[1].options.body);
  assert.deepEqual(pauseBody, { pause: true });
  assert.equal("purge" in pauseBody, false);
}

async function testHelperRestartAutoResume() {
  // 1) Helper restarts mid-download (6×404), comes back healthy, and the
  //    same payload is re-posted. The new job runs to done.
  const calls = [];
  const progress = [];
  let firstDownloadBody = null;
  let secondDownloadBody = null;
  const resumed = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      if (calls.filter((c) => c.url.endsWith("/download")).length === 1) {
        firstDownloadBody = JSON.parse(options.body || "{}");
        return { ok: true, json: async () => ({ ok: true, jobId: "j1" }) };
      }
      secondDownloadBody = JSON.parse(options.body || "{}");
      return { ok: true, json: async () => ({ ok: true, jobId: "j2" }) };
    }
    if (String(url).endsWith("/health")) {
      // Unhealthy until the recovery loop has polled a few times.
      return calls.filter((c) => c.url.endsWith("/health")).length < 3
        ? { ok: false, status: 0, json: async () => ({ ok: false }) }
        : { ok: true, json: async () => ({ ok: true, ytdlp: true, pairingMode: "paired" }) };
    }
    if (String(url).includes("/job/j1")) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: "job not found" }) };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, job: { status: "done", percent: 100, path: "/out/v.mp4", size: 5 } })
    };
  });
  const result = await resumed.downloadAndWait(
    { url: "https://x.test/v", resumeKey: "rk-1", outputStem: "영상" },
    (p) => progress.push(p),
    60_000
  );
  assert.equal(result.jobId, "j2", "polling continues on the new helper job");
  assert.equal(result.path, "/out/v.mp4");
  assert.deepEqual(firstDownloadBody, secondDownloadBody, "the exact same payload is re-posted");
  assert.equal(
    progress.some((p) => /재시작 감지/.test(p.message)),
    true,
    "recovery is reported through onProgress"
  );
  assert.equal(
    progress.some((p) => p.helperJobId === "j2"),
    true,
    "new helper job id is surfaced so cancel/pause still reach it"
  );

  // 2) Without a resumeKey the old behavior stands: the restart is fatal.
  const noResume = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      return { ok: true, json: async () => ({ ok: true, jobId: "j1" }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: "job not found" }) };
  });
  await assert.rejects(
    () => noResume.downloadAndWait({ url: "https://x.test/v" }, () => {}, 60_000),
    /재시작/
  );

  // 3) Helper never comes back within the recovery window → honest error.
  const gone = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/download")) {
      return { ok: true, json: async () => ({ ok: true, jobId: "j1" }) };
    }
    if (String(url).endsWith("/health")) {
      return { ok: false, status: 0, json: async () => ({ ok: false }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: "job not found" }) };
  });
  await assert.rejects(
    () => gone.downloadAndWait({ url: "https://x.test/v", resumeKey: "rk-2" }, () => {}, 60_000),
    /재시작/
  );
}

async function testYtdlpUpdateSelf() {
  const calls = [];
  const ytdlp = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        updated: true,
        version: "2026.09.07",
        message: "yt-dlp를 최신 버전으로 업데이트했습니다",
        hint: null
      })
    };
  });
  const result = await ytdlp.updateSelf();
  assert.equal(result.updated, true);
  assert.equal(result.version, "2026.09.07");
  const updateCall = calls.find((c) => c.url.endsWith("/update"));
  assert.ok(updateCall, "POSTs the helper /update endpoint");
  assert.equal(updateCall.options.method, "POST");
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

async function testYtdlpRevealPath() {
  const calls = [];
  const ytdlp = loadYtDlp(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/reveal") && options.body) {
      return {
        ok: true,
        json: async () => ({ ok: true, revealed: true })
      };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  });
  const good = await ytdlp.revealPath("/Users/show/Downloads/VideoDownloader/a.mp4");
  assert.equal(good.ok, true);
  assert.equal(good.revealed, true);
  const call = calls.find((c) => c.url.endsWith("/reveal"));
  assert.ok(call, "POSTs the helper /reveal endpoint");
  assert.equal(call.options.method, "POST");
  assert.equal(
    JSON.parse(call.options.body).path,
    "/Users/show/Downloads/VideoDownloader/a.mp4"
  );

  // 404 / network failure resolve (never throw) so callers can fall back.
  const refused = loadYtDlp(async () => {
    throw new Error("offline");
  });
  const offline = await refused.revealPath("/x.mp4");
  assert.equal(offline.ok, false);
  assert.equal(offline.revealed, false);
}

async function testBulkSetters() {
  const stored = {};
  global.chrome = {
    storage: {
      local: {
        get: async (key) => stored,
        set: async (value) => Object.assign(stored, value)
      }
    },
    runtime: { sendMessage: async () => {} }
  };
  const modulePath = require.resolve("../src/uvd-common.js");
  delete require.cache[modulePath];
  const UVD = require(modulePath);
  const history = await UVD.setHistoryBulk(
    Array.from({ length: 130 }, (_, i) => ({ id: `h${i}`, at: i }))
  );
  assert.equal(history.length, 100, "history bulk caps at 100");
  assert.equal(stored.uvdHistory.length, 100);
  const watchlist = await UVD.setWatchlistBulk(
    Array.from({ length: 120 }, (_, i) => ({
      id: `w${i}`,
      url: `https://x.test/${i}`
    }))
  );
  assert.equal(watchlist.length, 100, "watchlist bulk caps at 100");
  assert.equal(stored.uvdWatchlist.length, 100);
  delete global.chrome;
}

async function main() {
  await testHelperAutoPairing();
  await testHelperPollingFailsFast();
  await testHelperRestartAutoResume();
  await testYtdlpUpdateSelf();
  await testYtdlpRevealPath();
  await testBulkSetters();
  await testPairingRecovery();
  await testHistoryCap();
  testPermissionReductionAndTrackPlumbing();
  console.log("remaining recommendations: tracks, permissions, pairing, and history cap passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
