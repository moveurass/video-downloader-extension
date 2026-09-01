(function initPopupRuntimeEvents(root, factory) {
  const api = factory();
  root.UVDPopupRuntimeEvents = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupRuntimeEvents() {
    "use strict";

    function createHandler(deps) {
      const {
        $,
        pageKey,
        ensureSiteItems,
        render,
        refreshHelperStatus,
        applyJobProgress,
        updateQuickPageUi,
        loadRecentStrip,
        runningJobCount,
        renderHistory,
        updateRetryFailedButton,
        renderWatchlist,
        getCurrentTabId,
        getCurrentTabUrl,
        setAllItems,
        setHistoryItems,
        setWatchlistItems,
        getActiveTabName,
        getTrackedJobIds
      } = deps;

      return function handleRuntimeMessage(msg) {
        if (msg.type === "MEDIA_UPDATED" && msg.tabId === getCurrentTabId()) {
          // Do NOT wipe YT/TT card with empty network updates
          // Filter out items whose pageUrl identity doesn't match current tab
          const currentTabUrl = getCurrentTabUrl();
          const curKey = pageKey(currentTabUrl);
          const items = (msg.items || []).map((i) => {
            const k = pageKey(i.pageUrl || i.url || "");
            if (curKey && k && k !== curKey && i.isSiteDownload) {
              return { ...i, thumbnail: undefined, url: currentTabUrl, pageUrl: currentTabUrl };
            }
            if (curKey && k && k !== curKey) {
              return { ...i, thumbnail: undefined };
            }
            return i;
          });
          setAllItems(ensureSiteItems(items, {
            url: currentTabUrl,
            title: (items[0] && items[0].title) || ""
          }));
          render();
          refreshHelperStatus();
        }

        // Global download jobs — multi-queue (concurrent + page leave)
        if (msg.type === "DOWNLOAD_JOB" && msg.job) {
          const job = msg.job;
          if (job.id) getTrackedJobIds().add(job.id);
          applyJobProgress(job);
          // Always keep action buttons available for more concurrent downloads
          const btn = $("#btnLinkDl");
          const thisBtn = $("#btnThisPage");
          if (btn && btn.textContent !== "추가…") {
            btn.disabled = false;
            btn.textContent = "받기";
          }
          if (thisBtn) {
            thisBtn.disabled = false;
            updateQuickPageUi();
          }
          if (job.status === "done") loadRecentStrip();
          return;
        }

        // Progress from any tab / global job (page leave must not hide it)
        if (msg.type === "HLS_PROGRESS") {
          const p = msg.progress;
          if (!p) return;
          const isOurs =
            p.global ||
            p.jobId ||
            msg.tabId === getCurrentTabId() ||
            msg.tabId === -1 ||
            (p.jobId && getTrackedJobIds().has(p.jobId)) ||
            runningJobCount() > 0;
          if (!isOurs) return;
          if (p.jobId) getTrackedJobIds().add(p.jobId);
          applyJobProgress(p);
        }

        if (msg.type === "HISTORY_UPDATED" && Array.isArray(msg.history)) {
          setHistoryItems(msg.history);
          loadRecentStrip();
          if (getActiveTabName() === "history") {
            renderHistory();
            updateRetryFailedButton();
          } else {
            updateRetryFailedButton();
          }
        }
        if (msg.type === "WATCHLIST_UPDATED" && Array.isArray(msg.watchlist)) {
          setWatchlistItems(msg.watchlist);
          if (getActiveTabName() === "watch") renderWatchlist();
        }
      };
    }

    function bind(deps) {
      const handler = createHandler(deps);
      deps.chrome.runtime.onMessage.addListener(handler);
      return handler;
    }

    return { createHandler, bind };
  }
);
