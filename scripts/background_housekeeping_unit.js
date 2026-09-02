"use strict";

const assert = require("node:assert/strict");
const { createController } = require("../src/background-housekeeping.js");

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

async function main() {
  const installed = event();
  const startup = event();
  const deletes = [];
  const keys = [
    "hls_keep:p:000001",
    "hls_stale:p:000001",
    "hls_keep:p:000002",
    "hls_interrupted:p:000001"
  ];
  let closed = 0;
  const range = { lower: "hls_", upper: "hls_\uffff" };
  const transaction = {
    error: null,
    objectStore(name) {
      assert.equal(name, "parts");
      return {
        openCursor(value) {
          assert.equal(value, range);
          let index = 0;
          const request = { result: null, error: null };
          const advance = () => {
            if (index >= keys.length) {
              request.result = null;
              request.onsuccess();
              queueMicrotask(() => transaction.oncomplete());
              return;
            }
            const key = keys[index];
            request.result = {
              key,
              delete() {
                deletes.push(key);
              },
              continue() {
                index += 1;
                queueMicrotask(advance);
              }
            };
            request.onsuccess();
          };
          queueMicrotask(advance);
          return request;
        }
      };
    }
  };
  const controller = createController({
    chrome: {
      runtime: { onInstalled: installed, onStartup: startup },
      storage: {
        local: {
          get: async () => ({
            uvdPausedDownloads: [
              {
                status: "paused",
                resumeState: { kind: "hls", partBase: "hls_keep" }
              },
              {
                status: "done",
                resumeState: { kind: "hls", partBase: "hls_stale" }
              }
            ],
            // A job that was still running when the worker died is restored as
            // a resumable row, so its parts must not be swept at startup.
            uvdRunningDownloads: [
              {
                status: "running",
                resumeState: { kind: "hls", partBase: "hls_interrupted" }
              }
            ]
          })
        }
      }
    },
    IDBKeyRange: {
      bound(lower, upper) {
        assert.equal(lower, "hls_");
        assert.equal(upper, "hls_\uffff");
        return range;
      }
    },
    storeName: "parts",
    openBlobDb: async () => ({
      transaction(name, mode) {
        assert.equal(name, "parts");
        assert.equal(mode, "readwrite");
        return transaction;
      },
      close() {
        closed += 1;
      }
    })
  });

  controller.bind();
  controller.bind();
  assert.equal(installed.listeners.length, 1);
  assert.equal(startup.listeners.length, 1);
  await installed.listeners[0]();
  assert.deepEqual(deletes, ["hls_stale:p:000001"]);
  assert.equal(closed, 1);

  const failed = createController({
    chrome: {
      runtime: { onInstalled: event(), onStartup: event() }
    },
    IDBKeyRange: { bound() {} },
    storeName: "parts",
    openBlobDb: async () => {
      throw new Error("unavailable");
    }
  });
  await assert.doesNotReject(failed.cleanupStaleHlsParts());

  console.log("background housekeeping: lifecycle binding and cleanup passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
