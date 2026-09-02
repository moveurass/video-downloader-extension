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

    /**
     * Runs inside each frame's content-script world. Reports whether this
     * frame can run the page download and how likely it is to be the player
     * frame for `url` (it captured the URL, hosts a media element, is top).
     */
    function probeFrame(url) {
      const reported = globalThis.__UVD_REPORTED__;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url, location.href).origin === location.origin;
      } catch {
        sameOrigin = false;
      }
      return {
        hasDownload: !!globalThis.__UVD_PAGE_DOWNLOAD__?.smartDownload,
        reported: !!(reported && typeof reported.has === "function" && reported.has(url)),
        hasMedia: !!document.querySelector("video, audio"),
        isTop: window === window.top,
        sameOrigin
      };
    }

    function frameScore(result) {
      if (!result?.hasDownload) return -1;
      return (
        (result.reported ? 8 : 0) +
        (result.hasMedia ? 4 : 0) +
        (result.sameOrigin ? 2 : 0) +
        (result.isTop ? 1 : 0)
      );
    }

    /**
     * SMART_DOWNLOAD without a frameId is delivered to every frame in the tab
     * (ad iframes included) and each one would download the whole stream.
     * Pick the single most plausible frame; fall back to the top frame.
     */
    async function pickTargetFrame(tabId, url) {
      if (!chrome.scripting?.executeScript) return undefined;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: probeFrame,
          args: [String(url || "")]
        });
        let best = null;
        for (const entry of results || []) {
          const score = frameScore(entry?.result);
          if (score < 0) continue;
          if (!best || score > best.score) best = { frameId: entry.frameId, score };
        }
        return best ? best.frameId : 0;
      } catch (e) {
        console.warn("[UVD] frame probe", e);
        return 0;
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
        const frameId = await pickTargetFrame(tabId, payload.url);
        const message = {
          type: "SMART_DOWNLOAD",
          ...payload,
          // So page-side HLS progress binds to the right queue row
          jobId,
          progressAttempt,
          tabId
        };
        const r = await withTimeout(
          frameId == null
            ? chrome.tabs.sendMessage(tabId, message)
            : chrome.tabs.sendMessage(tabId, message, { frameId }),
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
      pickTargetFrame,
      frameScore,
      pageDownloadAllFrames
    };
  }

  return { createFallback };
});
