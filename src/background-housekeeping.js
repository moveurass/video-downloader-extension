(function initBackgroundHousekeeping(root, factory) {
  const api = factory();
  root.UVDBackgroundHousekeeping = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeHousekeeping() {
  "use strict";

  function createController(deps) {
    let bound = false;

    async function cleanupStaleHlsParts() {
      try {
        const database = await deps.openBlobDb();
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction(deps.storeName, "readwrite");
            transaction.objectStore(deps.storeName).delete(
              deps.IDBKeyRange.bound("hls_", "hls_\uffff")
            );
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
        } finally {
          try {
            database.close();
          } catch {
            // Closing a stale database is best-effort.
          }
        }
      } catch {
        // Cleanup must never block service-worker startup.
      }
    }

    function bind() {
      if (bound) return;
      bound = true;
      deps.chrome.runtime.onInstalled.addListener(cleanupStaleHlsParts);
      deps.chrome.runtime.onStartup.addListener(cleanupStaleHlsParts);
    }

    return { cleanupStaleHlsParts, bind };
  }

  return { createController };
});
