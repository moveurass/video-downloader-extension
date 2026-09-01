(function initPopupDomEvents(root, factory) {
  const api = factory();
  root.UVDPopupDomEvents = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupDomEvents() {
    "use strict";

    let libSearchTimer = null;

    function bind(deps) {
      const {
        $,
        document,
        sendMessage,
        loadMedia,
        render,
        downloadByPastedLink,
        downloadThisPage,
        updateLinkCount,
        switchTab,
        applyModeChips,
        updateFooterNote,
        toast,
        saveSettingsFromForm,
        updateSettingsPreview,
        renderHistory,
        updateRetryFailedButton,
        retryFailedDownloads,
        showHelperHelp,
        downloadHelperStarter,
        refreshHelperStatus,
        downloadPlaylistAll,
        selectPlaylistForDownload,
        loadPlaylistInfo,
        runSeriesComplete,
        hideSeriesBanner,
        retrySeriesFailed,
        setSeriesSelection,
        toggleSeriesMissingOnly,
        setSeriesRange,
        loadHistoryUi,
        addCurrentToWatchlist,
        downloadAllWatchlist,
        renderWatchlist,
        hideClipBanner,
        dismissClipboard,
        getUvdSettings,
        setUvdSettings,
        getAllItems,
        setAllItems,
        getHistoryItems,
        setHistoryItems,
        getWatchlistItems,
        setWatchlistItems,
        getHelperOk,
        setHelperOk,
        getPlaylistInfo,
        setPlaylistInfo,
        getCurrentTabUrl,
        setCurrentTabUrl,
        getLibFilter,
        setLibFilter,
        getCurrentTabId,
        setCurrentTabId
      } = deps;

      $("#btnScan").addEventListener("click", async () => {
        $("#btnScan").textContent = "…";
        await loadMedia();
        $("#btnScan").textContent = "↻";
      });

      $("#btnClear").addEventListener("click", async () => {
        const currentTabId = getCurrentTabId();
        if (currentTabId == null) return;
        await sendMessage({ type: "CLEAR_MEDIA", tabId: currentTabId });
        setAllItems([]);
        render();
      });

      $("#btnLinkDl")?.addEventListener("click", () =>
        downloadByPastedLink()
      );
      $("#btnThisPage")?.addEventListener("click", () => downloadThisPage());
      $("#linkInput")?.addEventListener("input", () => updateLinkCount());
      $("#linkInput")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          downloadByPastedLink();
        }
      });

      document.querySelectorAll(".tab").forEach((t) => {
        t.addEventListener("click", () =>
          switchTab(t.getAttribute("data-tab"))
        );
      });
      document.querySelectorAll(".mode-chip").forEach((c) => {
        c.addEventListener("click", async () => {
          const mode = c.getAttribute("data-mode") || "video";
          const settings = getUvdSettings();
          settings.mediaMode = mode;
          setUvdSettings(settings);
          applyModeChips();
          try {
            const res = await sendMessage({
              type: "SET_SETTINGS",
              settings: { mediaMode: mode }
            });
            if (res?.settings) setUvdSettings(res.settings);
          } catch {
            /* local only */
          }
          updateFooterNote();
          if (getAllItems()[0]) render();
          toast(
            mode === "audio"
              ? "오디오만 (MP3)으로 받습니다"
              : mode === "video_subs"
                ? "영상 + 자막으로 받습니다"
                : "영상(MP4)으로 받습니다",
            "ok"
          );
        });
      });
      $("#btnSaveSettings")?.addEventListener("click", () =>
        saveSettingsFromForm()
      );
      $("#setTemplate")?.addEventListener("input", updateSettingsPreview);
      $("#setSubfolder")?.addEventListener("input", () => {
        const settings = getUvdSettings();
        settings.subfolder = $("#setSubfolder").value;
        setUvdSettings(settings);
        updateSettingsPreview();
      });
      $("#setMediaMode")?.addEventListener("change", updateSettingsPreview);
      $("#btnClearHistory")?.addEventListener("click", async () => {
        await sendMessage({ type: "CLEAR_HISTORY" }).catch(() => {});
        setHistoryItems([]);
        renderHistory();
        updateRetryFailedButton();
        toast("기록을 비웠습니다", "ok");
      });
      $("#btnRetryFailed")?.addEventListener("click", () =>
        retryFailedDownloads()
      );
      $("#btnHelperFix")?.addEventListener("click", () => showHelperHelp());
      $("#btnHelperStart")?.addEventListener("click", () =>
        downloadHelperStarter()
      );
      $("#btnHelperRecheck")?.addEventListener("click", async () => {
        toast("도우미 상태 확인 중…", "ok");
        await refreshHelperStatus(true);
        const helperOk = getHelperOk();
        toast(
          helperOk
            ? "도우미 연결됨"
            : "아직 꺼져 있습니다 · 실행 파일을 더블클릭하세요",
          helperOk ? "ok" : "error"
        );
      });
      $("#btnPlDownload")?.addEventListener("click", () =>
        downloadPlaylistAll()
      );
      $("#btnPlSelect")?.addEventListener("click", () =>
        selectPlaylistForDownload()
      );
      $("#btnPlRefresh")?.addEventListener("click", () => {
        const url = getPlaylistInfo()?.url || getCurrentTabUrl();
        if (url) loadPlaylistInfo(url, true);
      });
      $("#btnSeriesGo")?.addEventListener("click", () =>
        runSeriesComplete()
      );
      $("#btnSeriesDismiss")?.addEventListener("click", () =>
        hideSeriesBanner()
      );
      $("#btnSeriesRetryFailed")?.addEventListener("click", () =>
        retrySeriesFailed()
      );
      $("#btnSeriesSelAll")?.addEventListener("click", () =>
        setSeriesSelection("all")
      );
      $("#btnSeriesSelPending")?.addEventListener("click", () =>
        setSeriesSelection("pending")
      );
      $("#btnSeriesSelNone")?.addEventListener("click", () =>
        setSeriesSelection("none")
      );
      $("#seriesRange")?.addEventListener("click", (e) => {
        const btn = e.target?.closest?.(".series-range-chip");
        if (!btn) return;
        if (btn.id === "btnSeriesMissingOnly") {
          toggleSeriesMissingOnly();
          return;
        }
        const range = btn.getAttribute("data-range");
        if (range) setSeriesRange(range);
      });

      $("#libSearch")?.addEventListener("input", () => {
        clearTimeout(libSearchTimer);
        libSearchTimer = setTimeout(() => {
          const filter = getLibFilter();
          filter.q = $("#libSearch")?.value || "";
          setLibFilter(filter);
          loadHistoryUi();
        }, 220);
      });
      $("#libStatus")?.addEventListener("change", () => {
        const filter = getLibFilter();
        filter.status = $("#libStatus")?.value || "done";
        setLibFilter(filter);
        loadHistoryUi();
      });
      $("#libSite")?.addEventListener("change", () => {
        const filter = getLibFilter();
        filter.site = $("#libSite")?.value || "";
        setLibFilter(filter);
        loadHistoryUi();
      });
      $("#libSeries")?.addEventListener("change", () => {
        const filter = getLibFilter();
        filter.series = $("#libSeries")?.value || "";
        setLibFilter(filter);
        loadHistoryUi();
      });
      $("#btnAddWatch")?.addEventListener("click", () =>
        addCurrentToWatchlist()
      );
      $("#btnWatchDlAll")?.addEventListener("click", () =>
        downloadAllWatchlist()
      );
      $("#btnClearWatch")?.addEventListener("click", async () => {
        await sendMessage({ type: "CLEAR_WATCHLIST" }).catch(() => {});
        setWatchlistItems([]);
        renderWatchlist();
        toast("나중 받기를 비웠습니다", "ok");
      });

      $("#btnClipApply")?.addEventListener("click", () => {
        const url =
          $("#clipBanner")?.dataset?.url ||
          $("#clipBannerUrl")?.textContent ||
          "";
        if (!url || url === "—") return;
        if ($("#linkInput")) {
          $("#linkInput").value = url;
          updateLinkCount();
        }
        hideClipBanner();
        toast("링크를 적용했습니다 · 받기를 누르세요", "ok");
        switchTab("main");
      });
      $("#btnClipDismiss")?.addEventListener("click", () => {
        dismissClipboard($("#clipBanner")?.dataset?.url || "");
      });

      // Keep the complete mutable-state contract explicit for later handlers.
      void getHistoryItems;
      void getWatchlistItems;
      void setHelperOk;
      void setPlaylistInfo;
      void setCurrentTabUrl;
      void setCurrentTabId;
    }

    return { bind };
  }
);
