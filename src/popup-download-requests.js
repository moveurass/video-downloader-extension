(function initPopupDownloadRequests(root, factory) {
  const api = factory();
  root.UVDPopupDownloadRequests = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupDownloadRequests() {
    "use strict";

    function createController(deps) {
      const {
        $,
        sendMessage,
        UVD,
        uiJobs,
        trackedJobIds,
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isHlsItem,
        isWatchlistableUrl,
        isSitePage,
        downloadFilename,
        cleanTitleText,
        displayName,
        pageKey,
        refreshHelperStatus,
        confirmNotDuplicate,
        upsertUiJob,
        renderDownloadQueue,
        runningJobCount,
        ensureQueuePoll,
        updateLinkCount,
        updateQuickPageUi,
        loadPlaylistInfo,
        applySiteDefaultQuality,
        refreshJobsFromBackground,
        toast,
        userError,
        MAX_CONCURRENT_STARTS,
        getAllItems,
        getCurrentTabId,
        getCurrentTabUrl,
        getSelectedQuality,
        getHelperOk,
        getUvdSettings
      } = deps;

      function canStartAnotherDownload() {
        return runningJobCount() < MAX_CONCURRENT_STARTS;
      }

      async function downloadItem(item, opts = {}) {
        if (!canStartAnotherDownload()) {
          toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`, "error");
          return;
        }

        const currentTabUrl = getCurrentTabUrl();
        const selectedQuality = getSelectedQuality();
        const pageUrl = currentTabUrl || item.pageUrl || item.url;
        if (!opts.skipDupCheck) {
          const ok = await confirmNotDuplicate(pageUrl);
          if (!ok) return;
        }
        const hasTiktokCdn =
          item.url &&
          /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(item.url) &&
          !/tiktok\.com\/@|tiktok\.com\/t\//i.test(item.url);
        const useHelper =
          item.isSiteDownload ||
          item.site === "youtube" ||
          item.site === "instagram" ||
          item.site === "x" ||
          item.site === "facebook" ||
          item.site === "bilibili" ||
          isYoutubeUrl(pageUrl) ||
          isYoutubeUrl(item.url) ||
          isInstagramUrl(pageUrl) ||
          isInstagramUrl(item.url) ||
          isXUrl(pageUrl) ||
          isXUrl(item.url) ||
          isFacebookUrl(pageUrl) ||
          isFacebookUrl(item.url) ||
          isBilibiliUrl(pageUrl) ||
          isBilibiliUrl(item.url) ||
          ((item.site === "tiktok" || isTiktokUrl(pageUrl) || isTiktokUrl(item.url)) &&
            !hasTiktokCdn);

        try {
          if (useHelper) {
            await refreshHelperStatus(true);
            if (!getHelperOk()) {
              toast(
                "소셜 사이트 받기에는 로컬 도우미가 필요합니다. helper/start.command 를 실행해 주세요",
                "error"
              );
              return;
            }
          }

          const saveName = downloadFilename({
            ...item,
            quality: selectedQuality === "best" ? item.quality : selectedQuality
          });
          item._saveAs = saveName;
          const title =
            cleanTitleText(item.title || item.pageTitle || item.displayName || "") ||
            cleanTitleText(saveName) ||
            displayName(item) ||
            "영상";

          const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          upsertUiJob(
            {
              id: tempId,
              title,
              filename: saveName || title,
              pageUrl,
              quality: selectedQuality || "",
              status: "running",
              percent: 3,
              message: "대기열에 추가됨…",
              phase: "start",
              startedAt: Date.now()
            },
            { toast: false }
          );

          const res = await sendMessage({
            type: useHelper
              ? "DOWNLOAD_PAGE"
              : isHlsItem(item)
                ? "DOWNLOAD_HLS"
                : "DOWNLOAD",
            url: useHelper ? pageUrl : item.url,
            pageUrl,
            filename: saveName,
            tabId: getCurrentTabId(),
            preferQuality: selectedQuality || "best",
            mediaType: item.type,
            preferYtDlp: useHelper,
            title,
            autoHls: !useHelper
          });

          if (res?.jobId) {
            uiJobs.delete(tempId);
            trackedJobIds.add(res.jobId);
            upsertUiJob(
              {
                id: res.jobId,
                title,
                filename: saveName || title,
                pageUrl,
                quality: selectedQuality || "",
                status: "running",
                percent: 4,
                message: "백그라운드에서 받는 중…",
                phase: "start",
                startedAt: Date.now()
              },
              { toast: false }
            );
            ensureQueuePoll();
            const n = runningJobCount();
            const short = title.length > 28 ? title.slice(0, 26) + "…" : title;
            toast(n > 1 ? `받는 중 ${n}개 · ${short}` : `받는 중 · ${short}`, "ok");
            return;
          }

          uiJobs.delete(tempId);
          renderDownloadQueue();

          if (res == null) {
            toast("백그라운드에서 받는 중입니다", "ok");
            return;
          }
          if (res?.ok === false) {
            toast(userError(res?.error) || "다운로드 실패", "error");
            return;
          }
          if (res?.ok) toast("저장 완료 · 다운로드/VideoDownloader", "ok");
        } catch (e) {
          const msg = String(e?.message || e || "");
          if (/Receiving end|message port|Extension context|The message port/i.test(msg)) {
            toast("백그라운드에서 계속 받는 중입니다", "ok");
            return;
          }
          toast(userError(e?.message) || "다운로드 실패", "error");
        }
      }

      function normalizePastedUrl(raw) {
        let s = String(raw || "").trim();
        if (!s) return "";
        if (
          !/^https?:\/\//i.test(s) &&
          /^(www\.)?(tiktok|youtube|youtu\.be|vm\.tiktok|vt\.tiktok|instagram|instagr\.am|x\.com|twitter\.com|t\.co|facebook\.com|fb\.watch|fb\.com|bilibili\.com|b23\.tv)/i.test(
            s
          )
        ) {
          s = "https://" + s;
        }
        try {
          const u = new URL(s);
          if (!/^https?:$/i.test(u.protocol)) return "";
          return u.href;
        } catch {
          return "";
        }
      }

      function fnameBaseFromLink(link) {
        try {
          if (isTiktokUrl(link)) {
            const m = link.match(/video\/(\d+)/);
            return m ? `TikTok_${m[1]}` : "TikTok";
          }
          if (isYoutubeUrl(link)) {
            const u = new URL(link);
            const id = u.searchParams.get("v") || u.pathname.split("/").pop();
            return id ? `YouTube_${id}` : "YouTube";
          }
          if (isInstagramUrl(link)) {
            const m = link.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
            return m ? `Instagram_${m[2]}` : "Instagram";
          }
          if (isXUrl(link)) {
            const m = link.match(/status\/(\d+)/i);
            return m ? `X_${m[1]}` : "X";
          }
          if (isFacebookUrl(link)) {
            try {
              const u = new URL(link);
              const v = u.searchParams.get("v");
              if (v) return `Facebook_${v}`;
              const m = u.pathname.match(/\/(videos|reel|reels|watch)\/([^/?#]+)/i);
              if (m) return `Facebook_${m[2]}`;
            } catch {
              /* ignore */
            }
            return "Facebook";
          }
          if (isBilibiliUrl(link)) {
            const m = link.match(/\/video\/(BV[\w]+|av\d+)/i);
            return m ? `Bilibili_${m[1]}` : "Bilibili";
          }
        } catch {
          /* ignore */
        }
        return UVD.siteFromUrl(link) || "영상";
      }

      function looksLikeDirectMedia(url) {
        return (
          /\.(mp4|webm|mov|m4v|mkv|m3u8|mpd)(\?|$|#)/i.test(url || "") ||
          /mime_type=video/i.test(url || "") ||
          /\/videoplayback/i.test(url || "")
        );
      }

      async function downloadByPastedLink(forcedUrl, opts = {}) {
        const input = $("#linkInput");
        const btn = $("#btnLinkDl");
        const thisBtn = $("#btnThisPage");
        const skipDup = !!opts.skipDupCheck;

        if (!forcedUrl) {
          const urls = updateLinkCount().filter(
            (u) => isWatchlistableUrl(u) || looksLikeDirectMedia(u)
          );
          if (urls.length > 1) {
            let toStart = urls;
            if (!skipDup && getUvdSettings().warnDuplicates !== false) {
              const kept = [];
              let skipped = 0;
              for (const u of urls) {
                const dup = await UVD.findDuplicateDone(u).catch(() => null);
                if (dup) skipped += 1;
                else kept.push(u);
              }
              if (!kept.length) {
                toast(
                  `모두 이미 받은 링크입니다 (${skipped}개). 기록에서 다시 받기를 쓰세요`,
                  "ok"
                );
                return;
              }
              if (skipped) {
                toast(`${skipped}개는 이미 받아 건너뛰고 ${kept.length}개만 시작합니다`, "ok");
              }
              toStart = kept;
            }
            if (runningJobCount() + toStart.length > MAX_CONCURRENT_STARTS) {
              toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 — 일부만 시작합니다`, "ok");
            }
            if (btn) {
              btn.disabled = true;
              btn.textContent = "일괄…";
            }
            try {
              await refreshHelperStatus(true);
              const batchQ = getSelectedQuality() || "best";
              const res = await sendMessage({
                type: "DOWNLOAD_BATCH",
                urls: toStart,
                tabId: getCurrentTabId(),
                preferQuality: batchQ
              });
              if (res?.ok) {
                toast(
                  res.truncated
                    ? `${res.count}개 시작 (전체 ${res.total}개 중)`
                    : `${res.count}개 일괄 다운로드 시작`,
                  "ok"
                );
                if (input) input.value = "";
                updateLinkCount();
                ensureQueuePoll();
                await refreshJobsFromBackground();
              } else {
                toast(userError(res?.error) || "일괄 다운로드 실패", "error");
              }
            } catch (e) {
              toast(userError(e?.message) || "일괄 다운로드 실패", "error");
            } finally {
              if (btn) {
                btn.disabled = false;
                btn.textContent = "받기";
              }
              if (thisBtn) {
                thisBtn.disabled = false;
                updateQuickPageUi();
              }
            }
            return;
          }
        }

        if (!canStartAnotherDownload()) {
          toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`, "error");
          return;
        }

        const raw = forcedUrl || input?.value || "";
        const parsed = UVD.parseUrlsFromText(raw);
        const link = normalizePastedUrl(parsed[0] || raw);
        if (!link) {
          toast("유효한 링크를 붙여 넣어 주세요 (YT/TT/IG/X/FB/B站)", "error");
          input?.focus();
          return;
        }

        if (!skipDup) {
          const ok = await confirmNotDuplicate(link);
          if (!ok) return;
        }

        applySiteDefaultQuality(link);
        if (!isWatchlistableUrl(link) && !looksLikeDirectMedia(link)) {
          toast("유효한 http(s) 링크가 필요합니다", "error");
          return;
        }

        if (UVD.isPlaylistOnlyUrl(link)) {
          await loadPlaylistInfo(link, true);
          toast("재생목록 불러옴 · 위 시리즈 패널에서 체크 후 받으세요", "ok");
          return;
        }

        if (btn) {
          btn.disabled = true;
          btn.textContent = "추가…";
        }

        try {
          const allItems = getAllItems();
          const currentTabId = getCurrentTabId();
          const selectedQuality = getSelectedQuality();
          const uvdSettings = getUvdSettings();
          const mediaUrl = opts.mediaUrl || "";
          const pageUrlHint = opts.pageUrl || link;
          const isSocial =
            isYoutubeUrl(link) ||
            isTiktokUrl(link) ||
            isInstagramUrl(link) ||
            isXUrl(link) ||
            isFacebookUrl(link) ||
            isBilibiliUrl(link) ||
            UVD.isPlaylistUrl(link);
          const isDirectMedia =
            looksLikeDirectMedia(link) ||
            /\.m3u8(\?|$|#)/i.test(link) ||
            looksLikeDirectMedia(mediaUrl) ||
            /\.m3u8(\?|$|#)/i.test(mediaUrl || "");
          const sameAsCard =
            allItems[0] &&
            pageKey(allItems[0].pageUrl || allItems[0].url || "") === pageKey(link);
          const realTitle =
            (opts.title && cleanTitleText(opts.title)) ||
            (sameAsCard
              ? allItems[0].title || allItems[0].pageTitle || allItems[0].displayName
              : "");
          const displayLabel =
            (realTitle && !UVD.isGenericSaveName(realTitle) && cleanTitleText(realTitle)) ||
            fnameBaseFromLink(link) ||
            "영상";
          const preferQ = opts.quality || selectedQuality || "best";
          const filename = downloadFilename({
            title: realTitle || "",
            pageTitle: realTitle || "",
            displayName: realTitle || "",
            pageUrl: pageUrlHint,
            type: uvdSettings.mediaMode === "audio" ? "audio" : "video"
          });

          const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          upsertUiJob(
            {
              id: tempId,
              title: displayLabel,
              filename: filename || displayLabel,
              pageUrl: pageUrlHint,
              quality: preferQ,
              status: "running",
              percent: 3,
              message: "대기열에 추가됨…",
              phase: "start",
              startedAt: Date.now()
            },
            { toast: false }
          );

          let res;
          if (isSocial) {
            await refreshHelperStatus(true);
            res = await sendMessage({
              type: "DOWNLOAD_CURRENT_PAGE",
              url: link,
              pageUrl: link,
              filename: filename || undefined,
              tabId: currentTabId,
              preferQuality: preferQ,
              title: realTitle && !UVD.isGenericSaveName(realTitle) ? realTitle : undefined
            });
          } else if (
            mediaUrl ||
            (isDirectMedia && /\.(m3u8|mpd|mp4|webm|mkv)/i.test(mediaUrl || link))
          ) {
            const stream = mediaUrl || link;
            const isHls = /\.m3u8(\?|$|#)/i.test(stream);
            const isDash = /\.mpd(\?|$|#)/i.test(stream);
            res = await sendMessage({
              type: isHls || isDash ? "DOWNLOAD_HLS" : "DOWNLOAD",
              url: stream,
              pageUrl: pageUrlHint,
              filename: filename || undefined,
              tabId: currentTabId,
              preferQuality: preferQ,
              mediaType: isHls || isDash ? "stream" : "video",
              preferYtDlp: false,
              openPageIfNeeded: true,
              title: realTitle || displayLabel
            });
          } else {
            res = await sendMessage({
              type: "DOWNLOAD_PAGE",
              url: link,
              pageUrl: link,
              filename: filename || undefined,
              tabId: currentTabId,
              preferQuality: preferQ,
              title: realTitle || displayLabel
            });
          }

          if (res?.jobId) {
            uiJobs.delete(tempId);
            trackedJobIds.add(res.jobId);
            upsertUiJob(
              {
                id: res.jobId,
                title: displayLabel,
                filename: filename || displayLabel,
                pageUrl: link,
                status: "running",
                percent: 4,
                message: "백그라운드에서 받는 중…",
                phase: "start",
                startedAt: Date.now()
              },
              { toast: false }
            );
            ensureQueuePoll();
            const n = runningJobCount();
            toast(
              n > 1 ? `다운로드 ${n}개 동시 진행 중` : "받기 시작 · 페이지를 이동해도 계속됩니다",
              "ok"
            );
            if (input && !forcedUrl) {
              input.value = "";
              updateLinkCount();
            }
            return;
          }

          uiJobs.delete(tempId);
          renderDownloadQueue();

          if (res == null) {
            toast("백그라운드에서 받는 중입니다", "ok");
            return;
          }
          if (res?.ok === false) {
            toast(userError(res?.error) || "다운로드 실패", "error");
            return;
          }
          if (res?.ok) {
            toast(`저장 완료 · 다운로드/${uvdSettings.subfolder || "VideoDownloader"}`, "ok");
          }
        } catch (e) {
          const msg = String(e?.message || e || "");
          if (/Receiving end|message port|Extension context|The message port/i.test(msg)) {
            toast("백그라운드에서 계속 받는 중입니다", "ok");
          } else {
            toast(userError(e?.message) || "다운로드 실패", "error");
          }
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "받기";
          }
          if (thisBtn) {
            thisBtn.disabled = false;
            updateQuickPageUi();
          }
        }
      }

      async function downloadThisPage() {
        const currentTabUrl = getCurrentTabUrl();
        if (!currentTabUrl || !isSitePage(currentTabUrl)) {
          toast("지원 사이트 페이지에서 열어 주세요", "error");
          return;
        }
        if ($("#linkInput")) $("#linkInput").value = currentTabUrl;
        await downloadByPastedLink(currentTabUrl);
      }

      return {
        downloadItem,
        normalizePastedUrl,
        fnameBaseFromLink,
        downloadByPastedLink,
        downloadThisPage,
        looksLikeDirectMedia
      };
    }

    return { createController };
  }
);
