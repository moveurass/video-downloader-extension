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
  await testHistoryCap();
  testPermissionReductionAndTrackPlumbing();
  console.log("remaining recommendations: tracks, permissions, pairing, and history cap passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
