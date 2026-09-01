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
        const durable = await deps.chrome.storage?.local
          ?.get("uvdPausedDownloads")
          .catch(() => ({}));
        const preserved = new Set(
          (Array.isArray(durable?.uvdPausedDownloads)
            ? durable.uvdPausedDownloads
            : []
          )
            .filter(
              (job) =>
                job?.status === "paused" &&
                job.resumeState?.kind === "hls" &&
                job.resumeState.partBase
            )
            .map((job) => job.resumeState.partBase)
        );
        const database = await deps.openBlobDb();
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction(deps.storeName, "readwrite");
            const request = transaction
              .objectStore(deps.storeName)
              .openCursor(deps.IDBKeyRange.bound("hls_", "hls_\uffff"));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return;
              const key = String(cursor.key || "");
              const partBase = key.includes(":p:")
                ? key.slice(0, key.lastIndexOf(":p:"))
                : "";
              if (!partBase || !preserved.has(partBase)) cursor.delete();
              cursor.continue();
            };
            request.onerror = () =>
              reject(request.error || new Error("IndexedDB 정리 조회 실패"));
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
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
