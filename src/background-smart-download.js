(function initBackgroundSmartDownload(root, factory) {
  const api = factory();
  root.UVDBackgroundSmartDownload = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundSmartDownload() {
  "use strict";

  /** Direct files at or above this size go through helper aria2c multi-connection */
  const DIRECT_HELPER_MIN_BYTES = 50 * 1024 * 1024;

  function createRouter(deps) {
    const {
      UVD,
      YtDlp,
      UVDDownloadRouting,
      activeDownloads,
      getCurrentJobContext,
      resolvePageUrl,
      emitDownloadProgress,
      downloadViaYtDlp,
      needsYtDlpHelper,
      isRealHls,
      isRealDash,
      bestNonBlobAlternative,
      pageDownloadAllFrames,
      withTimeout,
      withTabReferer,
      runHlsDownload,
      friendlyFetchError,
      probeContentLength,
      downloadDirectViaHelper,
      downloadDashViaHelper,
      downloadMedia
    } = deps;

    async function downloadSmart(tabId, url, filename, preferQuality, mediaType, itemHint, options = {}) {
      if (!url) throw new Error("받을 주소가 없습니다");
      const errors = [];
      const jid = options.jobId || getCurrentJobContext();
      const runGeneration = options.runGeneration ?? null;
      const pageUrl =
        options.pageUrl || itemHint?.pageUrl || (await resolvePageUrl(tabId, ""));

      emitDownloadProgress(tabId, 3, "시작…", "start", jid);

      // Manifests detected only by Content-Type (token-less URLs such as
      // /api/manifest?id=…) must route like their URL-detectable siblings.
      const mimeHint = String(itemHint?.mime || "").toLowerCase();
      const dashByMime = itemHint?.isDash === true || mimeHint.includes("dash+xml");
      const hlsByMime = mimeHint.includes("mpegurl");

      if (isRealDash(url, mediaType) || dashByMime) {
        emitDownloadProgress(tabId, 4, "DASH 트랙 준비 중…", "playlist", jid);
        const result = await downloadDashViaHelper(
          tabId,
          url,
          pageUrl,
          filename,
          preferQuality,
          jid,
          {
            mediaMode: options.forceMediaMode,
            runGeneration,
            audioTrackId: options.audioTrackId || "",
            subtitleLanguages: Array.isArray(options.subtitleLanguages)
              ? options.subtitleLanguages
              : []
          }
        );
        emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return result;
      }

      // YouTube / TikTok → local yt-dlp helper (primary)
      const forceHelper = UVDDownloadRouting.shouldUseHelper({
        url,
        pageUrl,
        item: itemHint,
        preferHelper: options.preferYtDlp === true
      });

      if (forceHelper) {
        try {
          return await downloadViaYtDlp(
            tabId,
            url,
            pageUrl || url,
            filename,
            preferQuality,
            jid,
            {
              mediaMode: options.forceMediaMode,
              runGeneration,
              audioTrackId: options.audioTrackId || "",
              subtitleLanguages: Array.isArray(options.subtitleLanguages)
                ? options.subtitleLanguages
                : []
            }
          );
        } catch (e) {
          // For YT/TT do not fall through to broken browser paths unless helper said optional
          const msg = String(e?.message || e);
          if (needsYtDlpHelper(url, pageUrl) || itemHint?.isSiteDownload) {
            throw e instanceof Error ? e : new Error(msg);
          }
          errors.push(msg);
        }
      }

      let workUrl = url;
      let workType = mediaType;
      let workItem = itemHint;

      // Upgrade blob / weak URL to best HLS on tab
      // Keep the original filename/title — alt media must not rename to another video.
      if (url.startsWith("blob:") || (!isRealHls(url, mediaType) && tabId != null)) {
        const alt = bestNonBlobAlternative(tabId, url);
        if (alt?.url && (alt.isHls || isRealHls(alt.url, alt.type))) {
          workUrl = alt.url;
          workType = "stream";
          workItem = {
            ...alt,
            title: workItem?.title || alt.title,
            pageTitle: workItem?.pageTitle || alt.pageTitle,
            pageUrl: workItem?.pageUrl || alt.pageUrl || pageUrl,
            filename: filename || workItem?.filename || alt.filename
          };
          // only fill empty filename from alt if still empty
          if (!filename) filename = alt.filename || filename;
          emitDownloadProgress(tabId, 5, "스트림으로 전환…", "download", jid);
        }
      }

      // Prefer job-locked filename over anything re-derived mid-download
      if (jid) {
        const jobF = activeDownloads.get(jid)?.filename;
        if (jobF && !UVD.isGenericSaveName(jobF)) {
          filename = jobF;
        }
      }

      if (workUrl.startsWith("blob:")) {
        emitDownloadProgress(tabId, 10, "버퍼 추출 중…", "download", jid);
        const pageResult = await pageDownloadAllFrames(tabId, {
          url: workUrl,
          filename,
          preferQuality,
          mediaType: "video",
          tabId
        });
        if (
          pageResult?.ok &&
          pageResult.downloadId != null &&
          (pageResult.size || 0) >= 100_000
        ) {
          emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
          return pageResult;
        }
        throw new Error(
          pageResult?.error || "이 영상은 받을 수 없습니다. 재생 후 다시 시도해 주세요"
        );
      }

      const hls =
        isRealHls(workUrl, workType) ||
        (hlsByMime && workUrl === url) ||
        (workItem?.isHls === true && workItem?.isDash !== true && workType === "stream");

      if (hls) {
        emitDownloadProgress(tabId, 6, "스트림 받는 중…", "playlist", jid);
        // Prefer page-context first on sites that often 403 extension SW fetches
        // (page has real cookies + referer of the player).
        // Site pack + legacy host heuristics for 403-prone CDNs
        let packTryPage = false;
        try {
          const pack = await UVD.getSitePackForUrl(pageUrl || workUrl);
          packTryPage = !!(
            pack?.rules?.tryPageFirst || pack?.rules?.preferPageHls
          );
        } catch {
          /* ignore */
        }
        const tryPageFirst =
          packTryPage ||
          /surrit|javplayer|missav|njav|jable|avgle|hanime|hls|cdn|123av|thisav|netflav|supjav|spankbang/i.test(
            workUrl + (pageUrl || "")
          );

        const runSwHls = async (isRetry = false) => {
          // After page-HLS fails mid-way, reset bar so we don't sit at a fake 90%+
          if (isRetry && jid) {
            emitDownloadProgress(
              tabId,
              4,
              "다시 받는 중… (확장 경로)",
              "playlist",
              jid,
              { progressReset: true }
            );
          }
          const result = await withTimeout(
            withTabReferer(
              tabId,
              (resolvedPage) =>
                runHlsDownload(
                  tabId,
                  workUrl,
                  preferQuality,
                  filename,
                  workItem,
                  resolvedPage || pageUrl,
                  jid,
                  { audioTrackId: options.audioTrackId || "" }
                ),
              pageUrl
            ),
            40 * 60 * 1000,
            "다운로드 시간 초과"
          );
          if ((result.size || 0) < 100_000) throw new Error("파일이 너무 작습니다");
          if (result.downloadId == null) {
            throw new Error("파일이 저장되지 않았습니다");
          }
          return result;
        };

        const runPageHls = async () => {
          emitDownloadProgress(
            tabId,
            4,
            "페이지에서 조각 받는 중…",
            "playlist",
            jid
          );
          const pageResult = await pageDownloadAllFrames(tabId, {
            url: workUrl,
            filename,
            preferQuality,
            mediaType: "stream",
            tabId,
            pageUrl,
            jobId: jid,
            audioTrackId: options.audioTrackId || ""
          });
          if (
            pageResult?.ok &&
            pageResult.downloadId != null &&
            (pageResult.size || 0) >= 100_000
          ) {
            return pageResult;
          }
          throw new Error(pageResult?.error || "페이지 병합 실패");
        };

        // A resumed job with stored segments must go straight to the worker
        // path — the page path has no checkpoint support and would restart
        // from zero.
        const resumeJob = jid ? activeDownloads.get(jid) : null;
        const hasCheckpoint = !!(
          options.resume &&
          resumeJob?.resumeState?.kind === "hls" &&
          resumeJob.resumeState.partBase
        );
        const order = UVDDownloadRouting.hlsAttemptOrder(tryPageFirst, {
          hasCheckpoint
        });
        // Each attempt reports its own honest segment progress (with reset on retry)
        const attemptRunners = {
          page: () => runPageHls(),
          worker: () => runSwHls(order[0] !== "worker")
        };
        const attempts = order.map((name) => ({
          name,
          run: attemptRunners[name]
        }));

        for (let i = 0; i < attempts.length; i++) {
          try {
            const result = await attempts[i].run();
            emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
            return result;
          } catch (e) {
            const msg = friendlyFetchError(e);
            errors.push(msg);
            if (i + 1 < attempts.length) {
              emitDownloadProgress(
                tabId,
                4,
                /403|401|접근 거부|Segment HTTP/i.test(msg)
                  ? "접근 제한 — 다른 방법으로 다시 받는 중…"
                  : "다른 방법으로 다시 받는 중…",
                "playlist",
                jid,
                { progressReset: true }
              );
              continue;
            }
          }
        }

        const joined = errors.filter(Boolean).join(" / ");
        if (/403|401|접근 거부|Segment HTTP/i.test(joined)) {
          throw new Error(
            "조각 접근이 거부되었습니다(403). 영상 페이지에서 재생을 시작한 직후 다시 받아 주세요"
          );
        }
        throw new Error(errors[0] || "다운로드 실패");
      }

      // Direct file
      emitDownloadProgress(tabId, 15, "다운로드 시작…", "download", jid);

      // Large direct files: helper(yt-dlp + aria2c)의 다중 연결이 chrome.downloads
      // 단일 연결보다 훨씬 빠름 — 크기를 먼저 확인하고 큰 파일만 위임.
      try {
        if (await YtDlp.available()) {
          const probedSize = await withTabReferer(
            tabId,
            () => probeContentLength(workUrl),
            pageUrl
          );
          if (probedSize >= DIRECT_HELPER_MIN_BYTES) {
            emitDownloadProgress(
              tabId,
              16,
              `대용량 파일(약 ${Math.round(probedSize / (1024 * 1024))}MB) — 도우미 다중 연결로 받는 중…`,
              "download",
              jid
            );
            const saved = await downloadDirectViaHelper(
              tabId,
              workUrl,
              pageUrl,
              filename,
              jid,
              { runGeneration }
            );
            emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
            return saved;
          }
        }
      } catch (e) {
        const m = String(e?.message || e);
        if (/PAUSED|CANCELLED|STALE_RUN/.test(m)) throw e;
        errors.push(m);
        emitDownloadProgress(tabId, 15, "브라우저 방식으로 다시 받는 중…", "download", jid, {
          progressReset: true
        });
      }

      try {
        const saved = await withTimeout(
          withTabReferer(tabId, () => downloadMedia(workUrl, filename, jid)),
          40 * 60 * 1000,
          "다운로드 시간 초과"
        );
        emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return { ok: true, ...saved, method: "chrome-downloads" };
      } catch (e) {
        errors.push(e?.message || String(e));
      }

      const pageResult = await pageDownloadAllFrames(tabId, {
        url: workUrl,
        filename,
        preferQuality,
        mediaType: "video",
        tabId
      });
      if (pageResult?.ok && pageResult.downloadId != null) {
        emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return pageResult;
      }
      throw new Error(errors[0] || pageResult?.error || "다운로드 실패");
    }

    return { downloadSmart };
  }

  return { createRouter };
});
