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

    function youtubeVideoId(rawUrl) {
      try {
        const url = new URL(rawUrl);
        const host = url.hostname.replace(/^www\./i, "").toLowerCase();
        if (host === "youtu.be") {
          return url.pathname.replace(/^\/+/, "").split("/")[0] || "";
        }
        if (!host.includes("youtube")) return "";
        return (
          url.searchParams.get("v") ||
          url.pathname.match(/\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1] ||
          ""
        );
      } catch {
        return "";
      }
    }

    function youtubeThumbnailForPage(pageUrl) {
      const videoId = youtubeVideoId(pageUrl);
      return videoId
        ? `https://i.ytimg.com/vi/${encodeURIComponent(
            videoId
          )}/hqdefault.jpg`
        : "";
    }

    function youtubeThumbnailMatches(thumbnail, videoId) {
      if (!thumbnail || !videoId) return false;
      const actual = String(thumbnail).match(
        /(?:i\d*\.ytimg\.com|img\.youtube\.com)\/(?:vi|vi_webp)\/([^/?#]+)/i
      )?.[1];
      return actual === videoId;
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
        getAllItems,
        getAvailableQualities,
        loadMedia,
        patchMedia,
        loadAvailableQualities
      } = deps;
      const setTimeoutFn = deps.setTimeout || setTimeout;
      const clearTimeoutFn = deps.clearTimeout || clearTimeout;
      let mediaRenderTimer = null;
      let pendingMediaSignature = "";
      let lastPaintedMediaSignature = "";

      function mediaSignature() {
        const item = getAllItems?.()?.[0] || null;
        const qualities =
          typeof getAvailableQualities === "function"
            ? getAvailableQualities()
            : [];
        return JSON.stringify({
          pageKey: pageKey(item?.pageUrl || getCurrentTabUrl() || ""),
          url: item?.url || "",
          title: item?.title || item?.pageTitle || item?.displayName || "",
          thumbnail: item?.thumbnail || "",
          quality: item?.quality || "",
          width: item?.width || 0,
          height: item?.height || 0,
          duration: item?.duration || 0,
          estimatedSize: item?.estimatedSize || item?.size || 0,
          placeholder: item?.isPagePlaceholder === true,
          qualities: (qualities || []).map((quality) => [
            quality.id || "",
            quality.label || "",
            quality.height || 0
          ])
        });
      }

      function scheduleMediaRender(pageChanged, signature) {
        if (
          !pageChanged &&
          signature &&
          (signature === lastPaintedMediaSignature ||
            (mediaRenderTimer && signature === pendingMediaSignature))
        ) {
          return;
        }
        if (mediaRenderTimer) {
          clearTimeoutFn(mediaRenderTimer);
          mediaRenderTimer = null;
        }
        pendingMediaSignature = signature;
        const paint = () => {
          mediaRenderTimer = null;
          if (
            !pageChanged &&
            typeof patchMedia === "function" &&
            patchMedia()
          ) {
            lastPaintedMediaSignature = pendingMediaSignature;
            pendingMediaSignature = "";
            return;
          }
          render();
          lastPaintedMediaSignature = pendingMediaSignature;
          pendingMediaSignature = "";
        };
        if (pageChanged) {
          paint();
        } else {
          mediaRenderTimer = setTimeoutFn(paint, 120);
        }
      }

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
              const currentYoutubeId = youtubeVideoId(currentTabUrl);
              const provisionalSafe =
                item.provisionalIdentitySafe === true &&
                !!currentYoutubeId;
              const safeThumbnail = youtubeThumbnailMatches(
                item.thumbnail,
                currentYoutubeId
              )
                ? item.thumbnail
                : youtubeThumbnailForPage(currentTabUrl);
              return [{
                ...item,
                thumbnail: safeThumbnail || undefined,
                title: provisionalSafe ? item.title : undefined,
                pageTitle: provisionalSafe ? item.pageTitle : undefined,
                displayName: provisionalSafe ? item.displayName : undefined,
                filename: provisionalSafe ? item.filename : undefined
              }];
            }
            return [item];
          });
          const knownCodeHost = (() => {
            try {
              const host = new URL(currentTabUrl).hostname;
              if (typeof deps.isKnownCodeSite === "function") {
                return !!deps.isKnownCodeSite(host);
              }
              return /123av|missav|jable|avgle|netflav|supjav|njav|javdb|javlibrary|thisav|hanime/i.test(
                host
              );
            } catch {
              return /:code:/.test(curKey);
            }
          })();
          const painted = pageChanged && knownCodeHost
            ? items.map((item) => ({
                ...item,
                thumbnail: undefined,
                title: undefined,
                pageTitle: undefined,
                displayName: undefined,
                filename: undefined
              }))
            : items;
          const previousPrimaryUrl = getAllItems?.()?.[0]?.url || "";
          setAllItems(ensureSiteItems(painted, {
            url: currentTabUrl,
            title: ""
          }));
          const nextPrimary = getAllItems?.()?.[0] || null;
          const primaryUrlChanged = !!(
            !pageChanged &&
            previousPrimaryUrl &&
            nextPrimary?.url &&
            nextPrimary.url !== previousPrimaryUrl
          );
          const qualityReload =
            primaryUrlChanged && typeof loadAvailableQualities === "function"
              ? Promise.resolve(loadAvailableQualities(nextPrimary)).catch(
                  () => {}
                )
              : null;
          scheduleMediaRender(pageChanged, mediaSignature());
          if (qualityReload) {
            qualityReload.then(() => {
              if (typeof render === "function") render();
            });
          }
          if (pageChanged) refreshHelperStatus(true);
          if (pageChanged && typeof loadMedia === "function") {
            // Paint the new MEDIA_UPDATED payload (or its site placeholder)
            // before refreshing metadata. A superseded async load can then
            // never strand a known helper page in the global empty state.
            Promise.resolve(loadMedia({ navigation: true })).catch(() => {});
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
