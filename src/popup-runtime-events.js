(function initPopupRuntimeEvents(root, factory) {
  const api = factory();
  root.UVDPopupRuntimeEvents = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupRuntimeEvents() {
    "use strict";

    function isYoutubePageUrl(rawUrl) {
      try {
        const host = new URL(rawUrl).hostname.replace(/^www\./i, "");
        return (
          host === "youtu.be" ||
          host.includes("youtube.com") ||
          host.includes("youtube-nocookie.com")
        );
      } catch {
        return false;
      }
    }

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
          const reportedKey = reportedUrl ? pageKey(reportedUrl) : "";
          if (
            reportedUrl &&
            reportedUrl !== previousTabUrl &&
            typeof setCurrentTabUrl === "function"
          ) {
            setCurrentTabUrl(reportedUrl);
          }
          const pageChanged = !!(
            previousKey &&
            reportedKey &&
            previousKey !== reportedKey
          );

          // Never carry identity-bound fields from another watch page.
          const currentTabUrl = reportedUrl || previousTabUrl;
          const curKey = pageKey(currentTabUrl);
          const identityReady =
            !isYoutubePageUrl(currentTabUrl) ||
            msg.identityConfirmed === true;
          const items = (msg.items || []).flatMap((i) => {
            // MEDIA_UPDATED is tab-scoped. Network captures may not carry a
            // pageUrl, so bind them to the broadcast page instead of treating
            // their CDN hostname/path as a competing page identity.
            const item =
              !i.pageUrl && currentTabUrl
                ? { ...i, pageUrl: currentTabUrl }
                : i;
            const k = pageKey(item.pageUrl || item.url || "");
            if (curKey && k && k !== curKey && item.isSiteDownload) {
              return [{
                ...item,
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
                ...item,
                thumbnail: undefined,
                title: undefined,
                pageTitle: undefined,
                displayName: undefined,
                filename: undefined
              }];
            }
            return [item];
          });
          setAllItems(ensureSiteItems(items, {
            url: currentTabUrl,
            title: (items[0] && items[0].title) || ""
          }));
          render();
          refreshHelperStatus();
          if (pageChanged && typeof loadMedia === "function") {
            // Paint the new MEDIA_UPDATED payload (or its site placeholder)
            // before refreshing metadata. A superseded async load can then
            // never strand a known helper page in the global empty state.
            Promise.resolve(loadMedia()).catch(() => {});
          }
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
