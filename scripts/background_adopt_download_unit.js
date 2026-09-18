"use strict";

const assert = require("node:assert/strict");
const AdoptDownload = require("../src/background-adopt-download.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function makeHarness({
  settings = {},
  files = {},
  adoptResult = { ok: true, moved: true, path: "/picked/clip.mp4" }
} = {}) {
  const calls = [];
  let listener = null;
  const chrome = {
    downloads: {
      search: async ({ id }) => (files[id] ? [files[id]] : []),
      onChanged: {
        addListener: (fn) => {
          listener = fn;
        }
      }
    }
  };
  const manager = AdoptDownload.createManager({
    chrome,
    UVD: {
      getSettings: async () => settings
    },
    YtDlp: {
      adoptDownload: async (path, subfolder, downloadDir) => {
        calls.push(["adopt", path, subfolder, downloadDir]);
        return adoptResult;
      }
    }
  });
  return { manager, calls, fire: (delta) => listener(delta) };
}

async function main() {
  check(typeof AdoptDownload.createManager, "function");

  {
    // attach() must register a downloads.onChanged listener
    const chromeEvents = [];
    const m2 = AdoptDownload.createManager({
      chrome: {
        downloads: {
          search: async () => [],
          onChanged: {
            addListener: (fn) => chromeEvents.push(fn)
          }
        }
      },
      UVD: { getSettings: async () => ({}) },
      YtDlp: {}
    });
    m2.attach();
    check(chromeEvents.length, 1);
  }

  {
    const harness = makeHarness({
      settings: { downloadDir: "/picked", subfolder: "" },
      files: {
        7: {
          id: 7,
          state: "complete",
          filename: "/Users/show/Downloads/VideoDownloader/clip.mp4"
        }
      }
    });
    harness.manager.attach();
    harness.fire({ id: 7, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    check(harness.calls, [
      [
        "adopt",
        "/Users/show/Downloads/VideoDownloader/clip.mp4",
        "VideoDownloader",
        "/picked"
      ]
    ]);
  }

  {
    // A custom subfolder names the browser-save marker
    const harness = makeHarness({
      settings: { downloadDir: "/picked", subfolder: "클립" },
      files: {
        7: {
          id: 7,
          state: "complete",
          filename: "/Users/show/Downloads/클립/clip.mp4"
        },
        8: {
          id: 8,
          state: "complete",
          filename: "/Users/show/Downloads/Other/clip.mp4"
        }
      }
    });
    harness.manager.attach();
    harness.fire({ id: 7, state: { current: "complete" } });
    harness.fire({ id: 8, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    check(
      harness.calls.map((call) => call[1]),
      ["/Users/show/Downloads/클립/clip.mp4"]
    );
  }

  {
    // Without a picked folder the browser location stays final
    const harness = makeHarness({
      settings: { subfolder: "VideoDownloader" },
      files: {
        7: {
          id: 7,
          state: "complete",
          filename: "/Users/show/Downloads/VideoDownloader/clip.mp4"
        }
      }
    });
    harness.manager.attach();
    harness.fire({ id: 7, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    check(harness.calls, []);
  }

  {
    // Each download id is adopted at most once
    const harness = makeHarness({
      settings: { downloadDir: "/picked" },
      files: {
        7: {
          id: 7,
          state: "complete",
          filename: "/Users/show/Downloads/VideoDownloader/clip.mp4"
        }
      }
    });
    harness.manager.attach();
    harness.fire({ id: 7, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    harness.fire({ id: 7, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    check(harness.calls.length, 1);
  }

  {
    // Failures are swallowed (legacy location kept)
    const harness = makeHarness({
      settings: { downloadDir: "/picked" },
      files: {
        7: {
          id: 7,
          state: "complete",
          filename: "/Users/show/Downloads/VideoDownloader/clip.mp4"
        }
      },
      adoptResult: { ok: false, moved: false, error: "denied" }
    });
    harness.manager.attach();
    harness.fire({ id: 7, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    check(harness.calls.length, 1);
  }

  console.log(`background adopt download: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
