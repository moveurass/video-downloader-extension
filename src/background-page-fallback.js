(function initBackgroundPageFallback(root, factory) {
  const api = factory();
  root.UVDBackgroundPageFallback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundPageFallback() {
  "use strict";

  function createFallback(deps) {
    const {
      chrome,
      withTimeout,
      activeDownloads,
      getCurrentJobContext,
      console
    } = deps;

    async function ensureContentScripts(tabId) {
      try {
        const ping = await withTimeout(
          chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" }),
          2500,
          "ping"
        );
        if (ping?.hasDownload) return;
      } catch {
        /* inject */
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["src/hls-downloader.js", "src/page-download.js", "src/content.js"]
        });
      } catch (e) {
        console.warn("[UVD] inject", e);
      }
    }

    async function pageDownloadAllFrames(tabId, payload) {
      if (tabId == null || tabId < 0) return { ok: false, error: "탭 없음" };
      await ensureContentScripts(tabId);
      try {
        const jobId = payload.jobId || getCurrentJobContext() || null;
        const progressAttempt = jobId
          ? Number(activeDownloads.get(jobId)?.progressAttempt) || 1
          : 0;
        const r = await withTimeout(
          chrome.tabs.sendMessage(tabId, {
            type: "SMART_DOWNLOAD",
            ...payload,
            // So page-side HLS progress binds to the right queue row
            jobId,
            progressAttempt,
            tabId
          }),
          25 * 60 * 1000,
          "다운로드 시간 초과"
        );
        if (r?.ok) return r;
        return { ok: false, error: r?.error || "페이지 다운로드 실패" };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    return {
      ensureContentScripts,
      pageDownloadAllFrames
    };
  }

  return { createFallback };
});
