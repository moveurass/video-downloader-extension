(function initPopupClipboardHistory(root, factory) {
  const api = factory();
  root.UVDPopupClipboardHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupClipboardHistory() {
    "use strict";

    function createController(deps) {
      const {
        $,
        navigator,
        setInterval,
        clearInterval,
        sendMessage,
        UVD,
        UVDPopupLibraryUI,
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isSitePage,
        pageKey,
        normalizePastedUrl,
        updateLinkCount,
        escapeHtml,
        escapeAttr,
        formatTimeAgo,
        bindRecoveryButtons,
        updateSeriesRetryButton,
        retrySeriesFailed,
        switchTab,
        offerSeriesComplete,
        toast,
        refreshHelperStatus,
        ensureQueuePoll,
        refreshJobsFromBackground,
        downloadByPastedLink,
        userError,
        maxConcurrentStarts,
        getUvdSettings,
        setUvdSettings,
        getCurrentTabUrl,
        setCurrentTabUrl,
        getHistoryItems,
        setHistoryItems,
        getLibFilter,
        setLibFilter,
        getLastSeriesRun,
        setLastSeriesRun,
        getCurrentTabId,
        setCurrentTabId,
        getSelectedQuality,
        setSelectedQuality,
        getSeriesPending,
        setSeriesPending
      } = deps;

      let clipWatchTimer = null;
      let lastClipSeen = "";
      let dismissedClip = "";
      let recentItems = [];

      function showClipBanner(url) {
        const ban = $("#clipBanner");
        const urlEl = $("#clipBannerUrl");
        if (!ban || !urlEl) return;
        urlEl.textContent = url;
        urlEl.title = url;
        ban.dataset.url = url;
        ban.classList.remove("hidden");
      }

      function hideClipBanner() {
        $("#clipBanner")?.classList.add("hidden");
      }

      async function pollClipboardOnce() {
        if (!getUvdSettings().clipboardWatch) return;
        try {
          const text = await navigator.clipboard.readText();
          const urls = UVD.parseUrlsFromText(text);
          const link = urls.find(
            (u) =>
              isYoutubeUrl(u) ||
              isTiktokUrl(u) ||
              isInstagramUrl(u) ||
              isXUrl(u) ||
              isFacebookUrl(u) ||
              isBilibiliUrl(u) ||
              UVD.isPlaylistUrl(u)
          );
          if (!link) return;
          if (link === lastClipSeen || link === dismissedClip) return;
          if (($("#linkInput")?.value || "").includes(link)) return;
          const currentTabUrl = getCurrentTabUrl();
          if (currentTabUrl && pageKey(currentTabUrl) === pageKey(link)) return;
          lastClipSeen = link;
          showClipBanner(link);
        } catch {
          /* permission denied — ignore silently */
        }
      }

      function setupClipboardWatch() {
        if (clipWatchTimer) {
          clearInterval(clipWatchTimer);
          clipWatchTimer = null;
        }
        if (!getUvdSettings().clipboardWatch) {
          hideClipBanner();
          return;
        }
        pollClipboardOnce();
        clipWatchTimer = setInterval(pollClipboardOnce, 2500);
      }

      async function autofillOnce() {
        try {
          if (getUvdSettings().clipboardWatch) return;
          if ($("#linkInput")?.value) return;
          const currentTabUrl = getCurrentTabUrl();
          if (currentTabUrl && isSitePage(currentTabUrl)) return;
          const text = await navigator.clipboard.readText();
          const urls = UVD.parseUrlsFromText(text);
          if (urls.length > 1) {
            $("#linkInput").value = urls.join("\n");
            updateLinkCount();
            return;
          }
          const link = normalizePastedUrl(urls[0] || text);
          if (
            link &&
            (isYoutubeUrl(link) ||
              isTiktokUrl(link) ||
              isInstagramUrl(link) ||
              isXUrl(link) ||
              isFacebookUrl(link) ||
              isBilibiliUrl(link))
          ) {
            $("#linkInput").value = link;
            updateLinkCount();
          }
        } catch {
          /* clipboard permission may be denied */
        }
      }

      async function loadHistoryUi() {
        const libFilter = getLibFilter();
        try {
          const res = await sendMessage({
            type: "QUERY_LIBRARY",
            query: {
              q: libFilter.q,
              status: libFilter.status || "done",
              site: libFilter.site || "",
              series: libFilter.series || ""
            }
          });
          if (res?.ok && Array.isArray(res.items)) {
            setHistoryItems(res.items);
          } else {
            const all = await sendMessage({ type: "GET_HISTORY" });
            setHistoryItems(all?.history || []);
          }
        } catch {
          try {
            setHistoryItems(await UVD.queryLibrary(libFilter));
          } catch {
            setHistoryItems(await UVD.getHistory().catch(() => []));
          }
        }
        fillLibraryFilterOptions();
        renderHistory();
        updateRetryFailedButton();
      }

      async function fillLibraryFilterOptions() {
        const siteSel = $("#libSite");
        const seriesSel = $("#libSeries");
        let all = [];
        try {
          const res = await sendMessage({ type: "GET_HISTORY" });
          all = res?.history || [];
        } catch {
          all = await UVD.getHistory().catch(() => []);
        }
        const values = UVDPopupLibraryUI.filterValues(all);
        const libFilter = getLibFilter();
        if (siteSel) {
          const cur = libFilter.site || siteSel.value || "";
          siteSel.innerHTML = UVDPopupLibraryUI.filterOptions(
            values.sites,
            cur,
            "모든 사이트",
            escapeAttr
          );
        }
        if (seriesSel) {
          const cur = libFilter.series || seriesSel.value || "";
          seriesSel.innerHTML = UVDPopupLibraryUI.filterOptions(
            values.series,
            cur,
            "모든 시리즈",
            escapeAttr
          );
        }
      }

      function updateRetryFailedButton() {
        const btn = $("#btnRetryFailed");
        if (!btn) return;
        const historyItems = getHistoryItems();
        const sid = getLastSeriesRun()?.seriesId || "";
        let seriesFailed = 0;
        if (sid) {
          seriesFailed = historyItems.filter(
            (h) =>
              h?.status === "error" &&
              (h.seriesId === sid ||
                (Array.isArray(h.tags) && h.tags.includes(sid)))
          ).length;
        }
        const n = historyItems.filter(
          (h) =>
            h?.status === "error" &&
            /^https?:/i.test(h.pageUrl || h.url || "")
        ).length;
        btn.disabled = n === 0;
        if (seriesFailed > 0) {
          btn.textContent = `시리즈 실패 · ${seriesFailed}`;
          btn.title = `마지막 시리즈 실패 ${seriesFailed}편 다시 받기 (전체 실패 ${n})`;
          btn.dataset.seriesRetry = "1";
        } else {
          btn.textContent = n > 0 ? `실패 재시도 · ${n}` : "실패 재시도";
          btn.title =
            n > 0
              ? `실패한 ${n}개 다시 받기`
              : "재시도할 실패 항목이 없습니다";
          delete btn.dataset.seriesRetry;
        }
        updateSeriesRetryButton().catch(() => {});
      }

      async function loadRecentStrip() {
        try {
          const res = await sendMessage({ type: "GET_RECENT_DONE", limit: 3 });
          recentItems = res?.items || [];
        } catch {
          recentItems = await UVD.getRecentDone(3).catch(() => []);
        }
        renderRecentStrip();
      }

      function renderRecentStrip() {
        const strip = $("#recentStrip");
        const list = $("#recentList");
        if (!strip || !list) return;
        if (!recentItems.length) {
          strip.classList.add("hidden");
          list.innerHTML = "";
          return;
        }
        strip.classList.remove("hidden");
        list.innerHTML = recentItems
          .map((h) => {
            const title = (h.title || h.filename || "영상").slice(0, 48);
            return `
        <div class="recent-item">
          <span class="recent-item-title" title="${escapeAttr(h.title || "")}">${escapeHtml(
              title
            )}</span>
          <button type="button" class="btn" data-act="show" data-path="${escapeAttr(
            h.path || ""
          )}" data-did="${escapeAttr(h.downloadId ?? "")}">폴더</button>
        </div>`;
          })
          .join("");
        bindRecoveryButtons(list);
      }

      async function retryFailedDownloads() {
        const btn = $("#btnRetryFailed");
        if (
          btn?.dataset?.seriesRetry === "1" &&
          getLastSeriesRun()?.seriesId
        ) {
          await retrySeriesFailed();
          return;
        }
        let failed = [];
        try {
          failed = await UVD.getFailedRetryable();
        } catch {
          failed = getHistoryItems().filter(
            (h) =>
              h?.status === "error" &&
              /^https?:/i.test(h.pageUrl || h.url || "")
          );
        }
        if (!failed.length) {
          toast("재시도할 실패 항목이 없습니다", "ok");
          return;
        }
        const urls = failed
          .map((h) => h.pageUrl || h.url)
          .filter((u) => /^https?:/i.test(u));
        if (!urls.length) {
          toast("재시도할 링크가 없습니다", "error");
          return;
        }
        switchTab("main");
        toast(`${urls.length}개 실패 항목 재시도 중…`, "ok");
        try {
          await refreshHelperStatus(true);
          const res = await sendMessage({
            type: "DOWNLOAD_BATCH",
            urls: urls.slice(0, maxConcurrentStarts),
            tabId: getCurrentTabId(),
            preferQuality: getSelectedQuality() || "best"
          });
          if (res?.ok) {
            toast(
              res.truncated
                ? `${res.count}개 재시작 (전체 ${res.total}개 중)`
                : `${res.count}개 재시도 시작`,
              "ok"
            );
            ensureQueuePoll();
            await refreshJobsFromBackground();
          } else {
            for (const u of urls.slice(0, maxConcurrentStarts)) {
              await downloadByPastedLink(u, { skipDupCheck: true });
            }
          }
        } catch (e) {
          toast(userError(e?.message) || "재시도 실패", "error");
        }
      }

      function renderHistory() {
        const root = $("#historyList");
        if (!root) return;
        root.innerHTML = UVDPopupLibraryUI.renderHistory(getHistoryItems(), {
          UVD,
          formatTimeAgo,
          escapeHtml,
          escapeAttr
        });
        bindRecoveryButtons(root);
        root.querySelectorAll('[data-act="series"]').forEach((btn) => {
          btn.addEventListener("click", async () => {
            const title = btn.getAttribute("data-title") || "";
            const url = btn.getAttribute("data-url") || "";
            switchTab("main");
            await offerSeriesComplete(title, url);
            const seriesPending = getSeriesPending();
            if (!seriesPending?.items?.length && !seriesPending?.loading) {
              toast(
                "시리즈 목록을 만들지 못했습니다. 제목에 품번이 있거나 재생목록이어야 합니다",
                "error"
              );
            }
          });
        });
      }

      function dismissClipboard(url) {
        dismissedClip = url || lastClipSeen || "";
        hideClipBanner();
      }

      // Keep the complete shared-state contract explicit and lazy.
      void setUvdSettings;
      void setCurrentTabUrl;
      void setLibFilter;
      void setLastSeriesRun;
      void setCurrentTabId;
      void setSelectedQuality;
      void setSeriesPending;

      return {
        showClipBanner,
        hideClipBanner,
        pollClipboardOnce,
        setupClipboardWatch,
        autofillOnce,
        loadHistoryUi,
        fillLibraryFilterOptions,
        updateRetryFailedButton,
        loadRecentStrip,
        renderRecentStrip,
        retryFailedDownloads,
        renderHistory,
        dismissClipboard,
        getClipWatchTimer: () => clipWatchTimer,
        setClipWatchTimer: (value) => {
          clipWatchTimer = value;
        },
        getLastClipSeen: () => lastClipSeen,
        setLastClipSeen: (value) => {
          lastClipSeen = value;
        },
        getDismissedClip: () => dismissedClip,
        setDismissedClip: (value) => {
          dismissedClip = value;
        }
      };
    }

    return { createController };
  }
);
