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
        setCurrentTabUrl,
        setAllItems,
        setHistoryItems,
        setWatchlistItems,
        getActiveTabName,
        getTrackedJobIds,
        loadMedia
      } = deps;

      return function handleRuntimeMessage(msg) {
        if (msg.type === "MEDIA_UPDATED" && msg.tabId === getCurrentTabId()) {
          const previousTabUrl = getCurrentTabUrl();
          const previousKey = pageKey(previousTabUrl);
          const reportedUrl = msg.pageUrl || "";
          const reportedKey = pageKey(reportedUrl);
          if (
            reportedUrl &&
            reportedUrl !== previousTabUrl &&
            typeof setCurrentTabUrl === "function"
          ) {
            setCurrentTabUrl(reportedUrl);
          }
          if (
            previousKey &&
            reportedKey &&
            previousKey !== reportedKey
          ) {
            // Clear the old card before any async metadata request can paint.
            setAllItems([]);
            render();
            if (typeof loadMedia === "function") {
              Promise.resolve(loadMedia()).catch(() => {});
            }
            return;
          }

          // Never carry identity-bound fields from another watch page.
          const currentTabUrl = reportedUrl || previousTabUrl;
          const curKey = pageKey(currentTabUrl);
          const identityReady =
            !String(curKey || "").startsWith("yt:") ||
            msg.identityConfirmed === true;
          const items = (msg.items || []).flatMap((i) => {
            const k = pageKey(i.pageUrl || i.url || "");
            if (curKey && k && k !== curKey && i.isSiteDownload) {
              return [{
                ...i,
                url: currentTabUrl,
                pageUrl: currentTabUrl,
                thumbnail: undefined,
                title: undefined,
                pageTitle: undefined,
                displayName: undefined,
                filename: undefined
              }];
            }
            if (curKey && k && k !== curKey) {
              return [];
            }
            if (!identityReady) {
              return [{
                ...i,
                thumbnail: undefined,
                title: undefined,
                pageTitle: undefined,
                displayName: undefined,
                filename: undefined
              }];
            }
            return [i];
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
