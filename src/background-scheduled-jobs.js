(function initBackgroundScheduledJobs(root, factory) {
  const api = factory();
  root.UVDBackgroundScheduledJobs = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeScheduledJobs() {
  "use strict";

  function createScheduler(deps) {
    const alarms = deps.chrome.alarms;

    /** Deferred watchlist downloads: alarm name `uvd-watch-{id}` */
    async function runScheduledWatchItem(watchId) {
      const list = await deps.UVD.getWatchlist();
      const item = list.find((x) => x.id === watchId);
      if (!item) return;
      const pageUrl = item.pageUrl || item.url || "";
      if (!/^https?:/i.test(pageUrl)) {
        await deps.UVD.removeWatchlist(watchId);
        return;
      }
      const keep = deps.startKeepAlive();
      try {
        await deps.runTrackedDownloadAsync(
          {
            tabId: -1,
            title: item.title || "예약 다운로드",
            pageUrl,
            mediaUrl: item.mediaUrl || "",
            filename: "",
            quality: item.quality || "best"
          },
          (jobId, runGeneration) =>
            deps.downloadPageFromUi(-1, pageUrl, item.quality || "best", jobId, {
              mediaUrl: item.mediaUrl || "",
              title: item.title || "",
              runGeneration
            })
        );
      } catch (e) {
        deps.console.warn("[UVD] scheduled watch download", watchId, e);
      } finally {
        deps.stopKeepAlive(keep);
        try {
          await deps.UVD.removeWatchlist(watchId);
        } catch {
          /* ignore */
        }
        try {
          await alarms.clear(`uvd-watch-${watchId}`);
        } catch {
          /* ignore */
        }
      }
    }

    function onAlarm(alarm) {
      if (!alarm?.name) return;
      if (alarm.name === "keepalive" || alarm.name === "uvd-dl-keepalive") return;
      if (alarm.name.startsWith("uvd-watch-")) {
        const id = alarm.name.slice("uvd-watch-".length);
        runScheduledWatchItem(id).catch(() => {});
      }
    }

    function bind() {
      alarms.create("keepalive", { periodInMinutes: 4.5 });
      alarms.onAlarm.addListener(onAlarm);
    }

    return { runScheduledWatchItem, bind };
  }

  return { createScheduler };
});
