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
  let closed = 0;
  const range = { lower: "hls_", upper: "hls_\uffff" };
  const transaction = {
    error: null,
    objectStore(name) {
      assert.equal(name, "parts");
      return {
        delete(value) {
          deletes.push(value);
          queueMicrotask(() => transaction.oncomplete());
        }
      };
    }
  };
  const controller = createController({
    chrome: {
      runtime: { onInstalled: installed, onStartup: startup }
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
  assert.deepEqual(deletes, [range]);
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
