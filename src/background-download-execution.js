(function initDownloadExecution(root, factory) {
  const api = factory();
  root.UVDDownloadExecution = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDownloadExecution() {
  "use strict";

  function sameVideoPage(a, b) {
    if (!a || !b) return false;
    try {
      const first = new URL(a);
      const second = new URL(b);
      const firstHost = first.hostname.replace(/^www\./i, "").toLowerCase();
      const secondHost = second.hostname.replace(/^www\./i, "").toLowerCase();
      const firstPath = (first.pathname || "/").replace(/\/+$/, "") || "/";
      const secondPath = (second.pathname || "/").replace(/\/+$/, "") || "/";
      return firstHost === secondHost && firstPath === secondPath;
    } catch {
      return a === b;
    }
  }

  function createExecutor(deps) {
    let keepAliveRefs = 0;
    let keepAliveTimer = null;

    function startKeepAlive() {
      keepAliveRefs += 1;
      if (!keepAliveTimer) {
        keepAliveTimer = setInterval(() => {
          try {
            deps.chrome.runtime.getPlatformInfo(() => {});
          } catch {
            // Service worker may be shutting down.
          }
        }, 2000);
      }
      try {
        deps.chrome.alarms.create("uvd-dl-keepalive", { periodInMinutes: 0.5 });
      } catch {
        // Alarm support is optional.
      }
      return true;
    }

    function stopKeepAlive() {
      keepAliveRefs = Math.max(0, keepAliveRefs - 1);
      if (keepAliveRefs !== 0) return;
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      try {
        deps.chrome.alarms.clear("uvd-dl-keepalive");
      } catch {
        // Alarm support is optional.
      }
    }

    function settleTrackedJob(jobId, result, error) {
      const job = deps.activeDownloads.get(jobId);
      const message = String(error?.message || error || "");
      if (job?.pauseRequested || /PAUSED/i.test(message)) {
        deps.finalizePausedJob(jobId);
      } else if (job?.cancelRequested || /CANCELLED|사용자가 취소/i.test(message)) {
        deps.finishCancelledJob(jobId);
      } else if (error) {
        deps.finishDownloadJob(jobId, null, error);
      } else {
        deps.finishDownloadJob(jobId, result, null);
      }
    }

    function runTrackedDownload(meta, asyncFn, sendResponse) {
      const jobId = deps.createDownloadJob(meta);
      const keepAlive = startKeepAlive();
      try {
        sendResponse({
          ok: true,
          started: true,
          jobId,
          background: true,
          concurrent: [...deps.activeDownloads.values()]
            .filter((job) => job.status === "running").length
        });
      } catch {
        // Popup may already be closed.
      }
      Promise.resolve()
        .then(() => deps.withJobContext(jobId, () => asyncFn(jobId)))
        .then((result) => {
          settleTrackedJob(jobId, result, null);
          stopKeepAlive(keepAlive);
        })
        .catch((error) => {
          settleTrackedJob(jobId, null, error);
          stopKeepAlive(keepAlive);
        });
      return true;
    }

    async function runTrackedDownloadAsync(meta, asyncFn) {
      const jobId = deps.createDownloadJob(meta);
      const keepAlive = startKeepAlive();
      try {
        const result = await deps.withJobContext(jobId, () => asyncFn(jobId));
        settleTrackedJob(jobId, result, null);
        return result;
      } catch (error) {
        settleTrackedJob(jobId, null, error);
        throw error;
      } finally {
        stopKeepAlive(keepAlive);
      }
    }

    async function waitTabComplete(tabId, timeoutMs = 45000) {
      try {
        if ((await deps.chrome.tabs.get(tabId))?.status === "complete") return;
      } catch {
        // Continue waiting for the update event.
      }
      await new Promise((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          try {
            deps.chrome.tabs.onUpdated.removeListener(onUpdated);
          } catch {
            // Listener may already be gone.
          }
        };
        const onUpdated = (id, info) => {
          if (id !== tabId || info.status !== "complete") return;
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);
        deps.chrome.tabs.onUpdated.addListener(onUpdated);
      });
    }

    async function findOrOpenTabForPage(pageUrl, preferredTabId) {
      if (preferredTabId != null && preferredTabId >= 0) {
        try {
          const tab = await deps.chrome.tabs.get(preferredTabId);
          if (tab?.url && sameVideoPage(tab.url, pageUrl)) {
            return { tabId: preferredTabId, opened: false };
          }
        } catch {
          // Search other tabs.
        }
      }
      try {
        for (const tab of await deps.chrome.tabs.query({})) {
          if (tab?.id != null && tab.url && sameVideoPage(tab.url, pageUrl)) {
            return { tabId: tab.id, opened: false };
          }
        }
      } catch {
        // Open a new background tab.
      }
      const tab = await deps.chrome.tabs.create({ url: pageUrl, active: false });
      if (tab?.id == null) throw new Error("페이지 탭을 열 수 없습니다");
      deps.emitDownloadProgress(
        tab.id,
        4,
        "영상 페이지 여는 중…",
        "start",
        deps.getCurrentJobContext()
      );
      await waitTabComplete(tab.id, 50000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { tabId: tab.id, opened: true };
    }

    async function downloadPageFromUi(
      tabId,
      pageUrl,
      preferQuality = "best",
      jobId = null,
      forceOpts = {}
    ) {
      const jid = jobId || deps.getCurrentJobContext();
      if (!pageUrl || !/^https?:/i.test(pageUrl)) {
        throw new Error("받을 페이지 주소가 없습니다");
      }
      const kind = deps.siteKind(pageUrl, pageUrl);
      const settings = await deps.UVD.getSettings();
      const mediaMode = forceOpts.mediaMode || settings.mediaMode || "video";
      const quality = forceOpts.preferQuality || preferQuality || "best";
      const jobSnapshot = jid ? deps.activeDownloads.get(jid) : null;
      let filename = "";
      try {
        filename = deps.lockSaveName({
          filenameHint: jobSnapshot?.filename || forceOpts.filename || "",
          title: forceOpts.title || jobSnapshot?.title || "",
          pageTitle: forceOpts.title || jobSnapshot?.title || "",
          quality,
          mediaMode,
          pageUrl,
          seriesKey: jobSnapshot?.seriesKey || "",
          playlistTitle: jobSnapshot?.seriesTitle || "",
          seriesIndex: jobSnapshot?.seriesIndex || 0
        });
        if (!filename && tabId != null && tabId >= 0) {
          try {
            const tab = await deps.chrome.tabs.get(tabId);
            if (tab?.url && sameVideoPage(tab.url, pageUrl)) {
              const title = deps.Naming.cleanPageTitle(tab.title || "") || "";
              filename = deps.lockSaveName({ title, quality, mediaMode, pageUrl });
            }
          } catch {
            // Keep the request-bound name.
          }
        }
      } catch {
        filename = "";
      }
      if (jid && filename) {
        const job = deps.activeDownloads.get(jid);
        if (job && (!job.filename || deps.UVD.isGenericSaveName(job.filename))) {
          job.filename = filename;
        }
      }
      if (kind) {
        return deps.downloadViaYtDlp(
          tabId,
          pageUrl,
          pageUrl,
          filename || undefined,
          quality,
          jid,
          { mediaMode }
        );
      }

      let workTabId = tabId;
      let openedTab = false;
      let best =
        forceOpts.resume &&
        forceOpts.mediaUrl &&
        /^https?:/i.test(forceOpts.mediaUrl)
          ? {
              url: forceOpts.mediaUrl,
              type: /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(forceOpts.mediaUrl)
                ? "stream"
                : "video",
              isHls: /\.m3u8(?:[?#]|$)/i.test(forceOpts.mediaUrl),
              pageUrl,
              title: forceOpts.title || "",
              filename
            }
          : null;
      const scan = async (targetTabId) => {
        if (targetTabId == null || targetTabId < 0) return null;
        try {
          await deps.ensureContentScripts(targetTabId);
        } catch {
          // A scan may still work.
        }
        try {
          await deps.chrome.tabs.sendMessage(targetTabId, { type: "SCAN_NOW" }).catch(() => {});
        } catch {
          // Read any media already captured.
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        return (await deps.getMediaForTabAsync(targetTabId, { pageUrl }))?.[0] || null;
      };

      if (!best?.url && tabId != null && tabId >= 0) {
        try {
          const tab = await deps.chrome.tabs.get(tabId);
          if (tab?.url && sameVideoPage(tab.url, pageUrl)) {
            best = await scan(tabId);
            workTabId = tabId;
          }
        } catch {
          // Open or find the correct page below.
        }
      }
      if (!best?.url) {
        deps.emitDownloadProgress(
          tabId ?? -1,
          5,
          "영상 페이지에서 스트림 찾는 중…",
          "start",
          jid
        );
        const found = await findOrOpenTabForPage(pageUrl, tabId);
        workTabId = found.tabId;
        openedTab = found.opened;
        for (let attempt = 0; attempt < 4 && !best?.url; attempt++) {
          best = await scan(workTabId);
          if (!best?.url) await new Promise((resolve) => setTimeout(resolve, 900));
        }
      }
      if (!best?.url && forceOpts.mediaUrl && /^https?:/i.test(forceOpts.mediaUrl)) {
        best = {
          url: forceOpts.mediaUrl,
          type: /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(forceOpts.mediaUrl)
            ? "stream"
            : "video",
          isHls: /\.m3u8/i.test(forceOpts.mediaUrl),
          pageUrl,
          title: forceOpts.title || "",
          filename
        };
      }
      if (!best?.url) {
        if (openedTab && workTabId != null) {
          try {
            await deps.chrome.tabs.remove(workTabId);
          } catch {
            // Best-effort cleanup.
          }
        }
        throw new Error(
          "감지된 영상이 없습니다. 해당 페이지를 연 뒤 재생을 한 번 시작하고 다시 「나중」에 추가하거나 받아 주세요"
        );
      }
      if (
        !filename ||
        deps.UVD.isGenericSaveName(String(filename).replace(/\.[a-z0-9]+$/i, ""))
      ) {
        let pageTitle = best.title || best.pageTitle || forceOpts.title || "";
        if ((!pageTitle || deps.Naming.isUglyBase?.(pageTitle)) && workTabId != null) {
          try {
            const tab = await deps.chrome.tabs.get(workTabId);
            if (tab?.url && sameVideoPage(tab.url, pageUrl)) {
              pageTitle = deps.Naming.cleanPageTitle(tab.title || "") || pageTitle;
            }
          } catch {
            // Keep scanned title.
          }
        }
        filename = deps.lockSaveName({
          filenameHint: best.filename || "",
          title: pageTitle,
          pageTitle,
          quality,
          mediaMode,
          pageUrl
        }) || filename;
      }
      if (jid && filename) {
        const job = deps.activeDownloads.get(jid);
        if (job) {
          job.filename = filename;
          if (!job.title || job.title === "영상" || deps.UVD.isGenericSaveName(job.title)) {
            job.title = String(filename).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
          }
          job.updatedAt = Date.now();
          deps.broadcastJob(job);
        }
      }
      const boundItem = {
        ...best,
        pageUrl,
        title: forceOpts.title || best.title || jobSnapshot?.title || "",
        pageTitle: forceOpts.title || best.pageTitle || best.title || "",
        filename: filename || best.filename
      };
      try {
        return await deps.downloadSmart(
          workTabId,
          best.url,
          filename || best.filename,
          quality,
          mediaMode === "audio" ? "audio" : best.type || "video",
          boundItem,
          { pageUrl, jobId: jid, forceMediaMode: mediaMode }
        );
      } finally {
        if (openedTab && workTabId != null) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await deps.chrome.tabs.remove(workTabId);
          } catch {
            // Best-effort cleanup.
          }
        }
      }
    }

    return {
      sameVideoPage,
      waitTabComplete,
      findOrOpenTabForPage,
      downloadPageFromUi,
      startKeepAlive,
      stopKeepAlive,
      settleTrackedJob,
      runTrackedDownload,
      runTrackedDownloadAsync
    };
  }

  return { sameVideoPage, createExecutor };
});
