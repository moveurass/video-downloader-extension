(function initPopupSeriesWatchlistFlow(root, factory) {
  const api = factory();
  root.UVDPopupSeriesWatchlistFlow = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupSeriesWatchlistFlow() {
    "use strict";

    function createController(deps) {
      const {
        $,
        document,
        URL,
        sendMessage,
        UVD,
        UVDPopupWatchlistUI,
        isDownloadableSiteVideo,
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramHost,
        isInstagramPostUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isSitePage,
        resolveSeriesIdFromPayload,
        normalizePastedUrl,
        fnameBaseFromLink,
        cleanTitleText,
        pageKey,
        isHlsItem,
        looksLikeDirectMedia,
        formatTimeAgo,
        escapeHtml,
        escapeAttr,
        downloadByPastedLink,
        refreshHelperStatus,
        ensureQueuePoll,
        refreshJobsFromBackground,
        switchTab,
        hideSeriesBanner,
        updateSeriesGoButton,
        toast,
        userError,
        maxConcurrentStarts,
        getSeriesPending,
        setSeriesPending,
        getLastSeriesRun,
        setLastSeriesRun,
        getHistoryItems,
        setHistoryItems,
        getCurrentTabId,
        setCurrentTabId,
        getSelectedQuality,
        setSelectedQuality,
        getWatchlistItems,
        setWatchlistItems,
        getAllItems,
        setAllItems,
        getCurrentTabUrl,
        setCurrentTabUrl,
        getActiveTabName,
        setActiveTabName
      } = deps;

      const formatScheduleLabel = UVDPopupWatchlistUI.formatScheduleLabel;
      const computeSchedule = UVDPopupWatchlistUI.computeSchedule;
      const watchSeriesGroupKey = (item) =>
        UVDPopupWatchlistUI.groupKey(item, UVD);
      const watchSeriesGroupLabel = UVDPopupWatchlistUI.groupLabel;

      async function updateSeriesRetryButton() {
        const btn = $("#btnSeriesRetryFailed");
        if (!btn) return;
        const seriesPending = getSeriesPending();
        const lastSeriesRun = getLastSeriesRun();
        const sid = seriesPending?.seriesId || lastSeriesRun?.seriesId || "";
        if (!sid) {
          btn.classList.add("hidden");
          return;
        }
        let failed = [];
        try {
          failed = await UVD.getFailedRetryable({ seriesId: sid });
        } catch {
          failed = (getHistoryItems() || []).filter(
            (h) =>
              h?.status === "error" &&
              (h.seriesId === sid ||
                (Array.isArray(h.tags) && h.tags.includes(sid)))
          );
        }
        if (!failed.length) {
          btn.classList.add("hidden");
          btn.textContent = "실패 재시도";
          return;
        }
        btn.classList.remove("hidden");
        btn.textContent = `실패 재시도 · ${failed.length}`;
        btn.title = `이 시리즈 실패 ${failed.length}편 다시 받기`;
      }

      async function retrySeriesFailed() {
        const seriesPending = getSeriesPending();
        const lastSeriesRun = getLastSeriesRun();
        const sid = seriesPending?.seriesId || lastSeriesRun?.seriesId || "";
        if (!sid) {
          toast("재시도할 시리즈가 없습니다", "error");
          return;
        }
        let failed = [];
        try {
          failed = await UVD.getFailedRetryable({ seriesId: sid });
        } catch {
          failed = [];
        }
        if (!failed.length) {
          toast("이 시리즈 실패 항목이 없습니다", "ok");
          updateSeriesRetryButton();
          return;
        }
        const urls = failed
          .map((h) => h.pageUrl || h.url)
          .filter((u) => /^https?:/i.test(u));
        toast(`${urls.length}편 시리즈 실패 재시도…`, "ok");
        try {
          await refreshHelperStatus(true);
          const res = await sendMessage({
            type: "DOWNLOAD_BATCH",
            urls: urls.slice(0, 20),
            tabId: getCurrentTabId(),
            preferQuality: getSelectedQuality() || "best"
          });
          if (res?.ok) {
            toast(`${res.count || urls.length}편 재시도 시작`, "ok");
            ensureQueuePoll();
            await refreshJobsFromBackground();
          } else {
            toast(userError(res?.error) || "재시도 실패", "error");
          }
        } catch (e) {
          toast(userError(e?.message) || "재시도 실패", "error");
        }
        updateSeriesRetryButton();
      }

      async function runSeriesComplete() {
        const seriesPending = getSeriesPending();
        if (!seriesPending || seriesPending.loading) return;
        const selected = (seriesPending.items || []).filter(
          (x) => x.selected !== false
        );
        if (!selected.length) {
          toast("받을 항목을 체크해 주세요", "error");
          return;
        }
        const btn = $("#btnSeriesGo");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "…";
        }
        try {
          const isPl = seriesPending.mode === "playlist";
          const seriesId =
            seriesPending.seriesId ||
            resolveSeriesIdFromPayload(seriesPending);
          const lastSeriesRun = {
            seriesId,
            title:
              seriesPending.playlistTitle || seriesPending.title || "",
            mode: seriesPending.mode
          };
          setLastSeriesRun(lastSeriesRun);
          const res = await sendMessage({
            type: "SERIES_COMPLETE",
            title: seriesPending.title,
            pageUrl: seriesPending.pageUrl || seriesPending.listUrl,
            count: selected.length,
            preferQuality: getSelectedQuality() || "best",
            tabId: getCurrentTabId(),
            seriesId,
            seriesTitle:
              seriesPending.playlistTitle || seriesPending.title || "",
            entries: selected.map((x, i) => ({
              title: x.title,
              url: x.url,
              key: x.key || x.id,
              id: x.id || x.key,
              seriesIndex: x.seriesIndex || i + 1,
              thumbnail: x.thumbnail || ""
            })),
            mode: seriesPending.mode
          });
          if (!res?.ok) {
            toast(userError(res?.error) || "시리즈 완주 실패", "error");
            return;
          }
          if (res.seriesId) lastSeriesRun.seriesId = res.seriesId;
          if (res.mode === "playlist" || isPl) {
            const names = selected
              .slice(0, 3)
              .map((x) => x.title)
              .join(", ");
            const reDone = selected.filter((x) => x.downloaded).length;
            toast(
              `${res.queued || selected.length}편 받기 시작${
                reDone ? ` · 재받기 ${reDone}` : ""
              }${names ? ` · ${names}${selected.length > 3 ? " …" : ""}` : ""}`,
              "ok"
            );
            ensureQueuePoll();
            await refreshJobsFromBackground();
            updateSeriesRetryButton();
          } else {
            const names = selected
              .slice(0, 4)
              .map((x) => x.key || x.title)
              .join(", ");
            toast(
              `나중 받기에 ${res.queued || selected.length}편 추가 · ${names}${
                selected.length > 4 ? " …" : ""
              }`,
              "ok"
            );
            await loadWatchlistUi();
            switchTab("watch");
            hideSeriesBanner();
          }
        } catch (e) {
          toast(userError(e?.message) || "시리즈 완주 실패", "error");
        } finally {
          if (btn) {
            btn.disabled = false;
            updateSeriesGoButton();
          }
        }
      }

      async function loadWatchlistUi() {
        try {
          const res = await sendMessage({ type: "GET_WATCHLIST" });
          setWatchlistItems(res?.watchlist || []);
        } catch {
          setWatchlistItems(await UVD.getWatchlist().catch(() => []));
        }
        renderWatchlist();
      }

      function renderWatchlist() {
        const root = $("#watchList");
        if (!root) return;
        root.innerHTML = UVDPopupWatchlistUI.render(getWatchlistItems(), {
          UVD,
          formatTimeAgo,
          escapeHtml,
          escapeAttr
        });

        root.querySelectorAll("[data-act]").forEach((el) => {
          const act = el.getAttribute("data-act");
          if (act === "watch-sched") {
            el.addEventListener("change", async () => {
              const id = el.getAttribute("data-id") || "";
              const mode = el.value;
              const patch =
                mode === "none" || mode === "clear"
                  ? { scheduleAt: 0, scheduleLabel: "" }
                  : computeSchedule(mode);
              await sendMessage({
                type: "UPDATE_WATCHLIST_ITEM",
                id,
                patch
              }).catch(() => {});
              toast(
                patch.scheduleAt
                  ? `예약: ${patch.scheduleLabel || formatScheduleLabel(patch)}`
                  : "예약을 취소했습니다",
                "ok"
              );
              await loadWatchlistUi();
            });
            return;
          }
          el.addEventListener("click", async () => {
            const id = el.getAttribute("data-id") || "";
            const url = el.getAttribute("data-url") || "";
            const group = el.getAttribute("data-group") || "";
            if (act === "watch-series-dl" && group) {
              await downloadWatchSeriesGroup(group);
              return;
            }
            if (act === "watch-series-rm" && group) {
              await removeWatchSeriesGroup(group);
              return;
            }
            if (act === "watch-dl" && url) {
              await downloadByPastedLink(url, {
                skipDupCheck: false,
                mediaUrl: el.getAttribute("data-media-url") || "",
                pageUrl: el.getAttribute("data-page-url") || url,
                title: el.getAttribute("data-title") || "",
                quality:
                  el.getAttribute("data-quality") ||
                  getSelectedQuality() ||
                  "best"
              });
              await sendMessage({
                type: "REMOVE_WATCHLIST",
                id
              }).catch(() => {});
              await loadWatchlistUi();
              return;
            }
            if (act === "watch-rm" && id) {
              await sendMessage({
                type: "REMOVE_WATCHLIST",
                id
              }).catch(() => {});
              await loadWatchlistUi();
            }
          });
        });

        let dragId = null;
        root.querySelectorAll(".watch-item").forEach((row) => {
          row.addEventListener("dragstart", (e) => {
            dragId = row.getAttribute("data-watch-id");
            row.classList.add("dragging");
            try {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", dragId || "");
            } catch {
              /* ignore */
            }
          });
          row.addEventListener("dragend", () => {
            row.classList.remove("dragging");
            root
              .querySelectorAll(".watch-item")
              .forEach((r) => r.classList.remove("drag-over"));
            dragId = null;
          });
          row.addEventListener("dragover", (e) => {
            e.preventDefault();
            row.classList.add("drag-over");
          });
          row.addEventListener("dragleave", () =>
            row.classList.remove("drag-over")
          );
          row.addEventListener("drop", async (e) => {
            e.preventDefault();
            row.classList.remove("drag-over");
            const fromId =
              dragId || e.dataTransfer?.getData("text/plain");
            const toId = row.getAttribute("data-watch-id");
            if (!fromId || !toId || fromId === toId) return;
            const ids = getWatchlistItems().map((w) => w.id);
            const from = ids.indexOf(fromId);
            const to = ids.indexOf(toId);
            if (from < 0 || to < 0) return;
            ids.splice(from, 1);
            ids.splice(to, 0, fromId);
            const res = await sendMessage({
              type: "REORDER_WATCHLIST",
              ids
            }).catch(() => null);
            if (res?.watchlist) {
              setWatchlistItems(res.watchlist);
            } else {
              const map = new Map(
                getWatchlistItems().map((w) => [w.id, w])
              );
              setWatchlistItems(
                ids.map((id) => map.get(id)).filter(Boolean)
              );
            }
            renderWatchlist();
          });
        });
      }

      async function downloadWatchSeriesGroup(groupKey) {
        const items = getWatchlistItems().filter(
          (w) => watchSeriesGroupKey(w) === groupKey
        );
        if (!items.length) {
          toast("묶음에 항목이 없습니다", "error");
          return;
        }
        toast(`${items.length}편 묶음 받기 시작…`, "ok");
        switchTab("main");
        for (const w of items) {
          const url = w.url || w.pageUrl;
          if (!/^https?:/i.test(url)) continue;
          try {
            await downloadByPastedLink(url, {
              skipDupCheck: true,
              mediaUrl: w.mediaUrl || "",
              pageUrl: w.pageUrl || url,
              title: w.title || "",
              quality: w.quality || getSelectedQuality() || "best"
            });
            await sendMessage({
              type: "REMOVE_WATCHLIST",
              id: w.id
            }).catch(() => {});
          } catch {
            /* continue others */
          }
        }
        await loadWatchlistUi();
        ensureQueuePoll();
        toast("묶음 받기 요청을 넣었습니다", "ok");
      }

      async function removeWatchSeriesGroup(groupKey) {
        const items = getWatchlistItems().filter(
          (w) => watchSeriesGroupKey(w) === groupKey
        );
        if (!items.length) return;
        for (const w of items) {
          await sendMessage({
            type: "REMOVE_WATCHLIST",
            id: w.id
          }).catch(() => {});
        }
        toast(
          `시리즈 ${items.length}편을 나중 받기에서 삭제`,
          "ok"
        );
        await loadWatchlistUi();
      }

      function isWatchlistableUrl(url) {
        if (!url || typeof url !== "string") return false;
        let href = url.trim();
        if (!href) return false;
        if (
          !/^https?:\/\//i.test(href) &&
          /^(www\.)?(youtube|youtu\.be|tiktok|instagram|x\.com|twitter|facebook|fb\.watch|bilibili|b23\.tv)/i.test(
            href
          )
        ) {
          href = "https://" + href;
        }
        if (!/^https?:\/\//i.test(href)) return false;
        try {
          const u = new URL(href);
          if (!/^https?:$/i.test(u.protocol)) return false;
          const h = (u.hostname || "").toLowerCase();
          if (!h || h === "localhost") return false;
          if (
            /^(chrome|chrome-extension|edge|about|devtools|brave)/i.test(
              u.protocol
            )
          ) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      }

      function resolveWatchlistUrl(forcedUrl) {
        const fromInput = normalizePastedUrl(
          UVD.parseUrlsFromText($("#linkInput")?.value || "")[0] || ""
        );
        const item = getAllItems()[0];
        const candidates = [
          forcedUrl,
          fromInput,
          item?.pageUrl,
          item?.url,
          getCurrentTabUrl()
        ]
          .map((u) => String(u || "").trim())
          .filter(Boolean);

        for (const u of candidates) {
          if (
            isDownloadableSiteVideo(u) ||
            isYoutubeUrl(u) ||
            isTiktokUrl(u) ||
            isInstagramUrl(u) ||
            isXUrl(u) ||
            isFacebookUrl(u) ||
            isBilibiliUrl(u) ||
            UVD.isPlaylistUrl(u)
          ) {
            return u;
          }
        }
        for (const u of candidates) {
          if (isWatchlistableUrl(u)) return u;
        }
        return candidates[0] || "";
      }

      async function addCurrentToWatchlist(forcedUrl) {
        let url = resolveWatchlistUrl(forcedUrl);
        if (url && !/^https?:\/\//i.test(url)) {
          url = normalizePastedUrl(url) || url;
        }
        if (!url || !/^https?:/i.test(url)) {
          toast(
            "추가할 링크가 없습니다 · 영상 페이지를 열거나 링크를 붙여 넣으세요",
            "error"
          );
          return;
        }
        if (!isWatchlistableUrl(url)) {
          toast("http(s) 링크만 추가할 수 있습니다", "error");
          return;
        }

        if (isInstagramHost(url) && !isInstagramPostUrl(url)) {
          toast(
            "Instagram은 게시물·릴스 링크만 추가할 수 있습니다",
            "error"
          );
          return;
        }

        const item = getAllItems()[0];
        const currentTabUrl = getCurrentTabUrl();
        const sameCard =
          item &&
          (pageKey(item.pageUrl || item.url || "") === pageKey(url) ||
            pageKey(item.url || "") === pageKey(url));
        const title =
          (sameCard &&
            (item.title || item.pageTitle || item.displayName)) ||
          (item &&
            isSitePage(currentTabUrl) &&
            (item.title || item.pageTitle)) ||
          fnameBaseFromLink(url) ||
          cleanTitleText(document?.title) ||
          "나중에 받을 영상";
        let mediaUrl = "";
        if (sameCard && item?.url && item.url !== url) {
          if (
            isHlsItem(item) ||
            looksLikeDirectMedia(item.url) ||
            /\.m3u8|\/playlist/i.test(item.url)
          ) {
            mediaUrl = item.url;
          }
        } else if (
          item?.url &&
          (isHlsItem(item) || looksLikeDirectMedia(item.url))
        ) {
          try {
            const pageHost = new URL(url).hostname.replace(/^www\./, "");
            const curHost = currentTabUrl
              ? new URL(currentTabUrl).hostname.replace(/^www\./, "")
              : "";
            if (pageHost && (pageHost === curHost || !curHost)) {
              mediaUrl = item.url;
            }
          } catch {
            /* ignore */
          }
        }

        try {
          const res = await sendMessage({
            type: "ADD_WATCHLIST",
            item: {
              url,
              pageUrl: item?.pageUrl || url,
              mediaUrl: mediaUrl || "",
              title:
                cleanTitleText(title) ||
                title ||
                "나중에 받을 영상",
              thumbnail:
                (sameCard && item?.thumbnail) || item?.thumbnail || "",
              quality: getSelectedQuality() || "",
              site: UVD.siteFromUrl(url) || item?.site || ""
            }
          });
          setWatchlistItems(res?.watchlist || []);
          toast(
            mediaUrl
              ? "나중 받기에 추가했습니다 (스트림 포함)"
              : "나중 받기에 추가했습니다",
            "ok"
          );
          if (getActiveTabName() === "watch") renderWatchlist();
        } catch (e) {
          toast(userError(e?.message) || "추가 실패", "error");
        }
      }

      async function downloadAllWatchlist() {
        const watchlistItems = getWatchlistItems();
        if (!watchlistItems.length) {
          toast("나중 받기 목록이 비어 있습니다", "ok");
          return;
        }
        const urls = watchlistItems
          .map((w) => w.url || w.pageUrl)
          .filter((u) => /^https?:/i.test(u));
        if (!urls.length) return;
        switchTab("main");
        toast(`${urls.length}개 나중 받기 시작…`, "ok");
        try {
          await refreshHelperStatus(true);
          const res = await sendMessage({
            type: "DOWNLOAD_BATCH",
            urls: urls.slice(0, maxConcurrentStarts),
            tabId: getCurrentTabId(),
            preferQuality: getSelectedQuality() || "best"
          });
          if (res?.ok) {
            for (const u of urls.slice(0, res.count || urls.length)) {
              await sendMessage({
                type: "REMOVE_WATCHLIST",
                id: u
              }).catch(() => {});
            }
            toast(`${res.count || urls.length}개 다운로드 시작`, "ok");
            ensureQueuePoll();
            await refreshJobsFromBackground();
            await loadWatchlistUi();
          } else {
            toast(userError(res?.error) || "시작 실패", "error");
          }
        } catch (e) {
          toast(userError(e?.message) || "시작 실패", "error");
        }
      }

      return {
        updateSeriesRetryButton,
        retrySeriesFailed,
        runSeriesComplete,
        loadWatchlistUi,
        renderWatchlist,
        downloadWatchSeriesGroup,
        removeWatchSeriesGroup,
        isWatchlistableUrl,
        resolveWatchlistUrl,
        addCurrentToWatchlist,
        downloadAllWatchlist,
        formatScheduleLabel,
        computeSchedule,
        watchSeriesGroupKey,
        watchSeriesGroupLabel
      };
    }

    return { createController };
  }
);
