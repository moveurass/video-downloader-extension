(function initBackgroundHlsRuntime(root, factory) {
  const api = factory();
  root.UVDBackgroundHlsRuntime = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundHlsRuntime() {
  "use strict";

  function createRunner(deps) {
    const {
      HLS,
      UVD,
      Naming,
      activeDownloads,
      getCurrentJobContext,
      jobAbortControllers,
      hlsProgress,
      resolvePageUrl,
      lockSaveName,
      applyQualityToLockedName,
      safeDownloadName,
      hlsPhasePercent,
      estimateSavePercent,
      emitDownloadProgress,
      broadcastJob,
      throwIfJobStopped,
      openBlobDb,
      idbPutPart,
      idbPartKey,
      idbListParts,
      idbDeleteParts,
      downloadPartsViaTab,
      downloadBlob
    } = deps;

    async function runHlsDownload(
      tabId,
      url,
      preferQuality,
      filenameHint,
      itemHint,
      pageUrlHint,
      jobId = null
    ) {
      if (!url) throw new Error("받을 주소가 없습니다");
      const jid = jobId || getCurrentJobContext();
      const key = jid || tabId || -1;
      const pageUrl =
        pageUrlHint ||
        itemHint?.pageUrl ||
        (await resolvePageUrl(tabId, "")) ||
        "";

      // ── Lock save name NOW (before long download). ──
      // Tab title / media map may change if the user navigates or starts another video.
      const jobSnap = jid ? activeDownloads.get(jid) : null;
      const progressAttempt = Number(jobSnap?.progressAttempt) || 1;
      const lockedName = lockSaveName({
        filenameHint:
          filenameHint ||
          jobSnap?.filename ||
          itemHint?.filename ||
          "",
        title:
          itemHint?.title ||
          jobSnap?.title ||
          itemHint?.pageTitle ||
          "",
        pageTitle: itemHint?.pageTitle || itemHint?.title || jobSnap?.title || "",
        quality: preferQuality || itemHint?.quality || jobSnap?.quality || "",
        mediaMode: "video",
        pageUrl: pageUrl || itemHint?.pageUrl || jobSnap?.pageUrl || "",
        seriesKey: jobSnap?.seriesKey || itemHint?.seriesKey || "",
        playlistTitle: jobSnap?.seriesTitle || itemHint?.playlistTitle || "",
        seriesIndex: jobSnap?.seriesIndex || itemHint?.seriesIndex || 0
      });
      if (jid && lockedName) {
        const job = activeDownloads.get(jid);
        if (job) {
          job.filename = lockedName;
          if (!job.title || job.title === "영상" || UVD.isGenericSaveName(job.title)) {
            job.title = lockedName.replace(/\.(mp4|webm|mkv)$/i, "");
          }
          job.updatedAt = Date.now();
          broadcastJob(job);
        }
      }

      // Honest progress only — never remap "remaining span" onto a rising floor
      // (that made the bar race to 99% while segments were still downloading).
      const setProg = (p, opts = {}) => {
        const percent = hlsPhasePercent(p);
        let message = p.message || "받는 중…";
        if (p.phase === "segments") {
          // Prefer size-based message from HLS downloader; never show raw segment counts
          if (p.message && /MB|KB|GB|B\s*\/|받는 중/.test(p.message)) {
            message = p.message;
          } else if (p.bytesReceived > 0 || p.bytesTotal > 0) {
            const fmt = (n) => {
              const b = Number(n) || 0;
              if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
              const mb = b / (1024 * 1024);
              return mb < 10 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
            };
            message =
              p.bytesTotal > 0
                ? `받는 중… ${fmt(p.bytesReceived)} / 약 ${fmt(p.bytesTotal)}`
                : `받는 중… ${fmt(p.bytesReceived)}`;
          } else {
            message = p.message || "받는 중…";
          }
        } else if (p.phase === "merge") {
          message = p.message || "파일 만드는 중…";
        } else if (p.phase === "save") {
          message = p.message || "디스크에 저장 중… (대용량은 시간이 걸려요)";
        }
        const progress = {
          ...p,
          percent,
          message,
          jobId: jid || undefined,
          global: true
        };
        hlsProgress.set(key, progress);
        if (jid) hlsProgress.set(jid, progress);
        emitDownloadProgress(
          tabId,
          percent,
          message,
          p.phase || "download",
          jid,
          {
            progressReset: !!opts.progressReset,
            progressAttempt,
            segmentCurrent: p.current,
            segmentTotal: p.total
          }
        );
      };

      setProg(
        {
          phase: "start",
          message: lockedName
            ? `준비 중… · ${String(lockedName)
                .replace(/\.[a-z0-9]+$/i, "")
                .slice(0, 36)}`
            : "준비 중…",
          current: 0,
          total: 1
        },
        { progressReset: false }
      );

      const settingsForSpeed = await UVD.getSettings().catch(() => ({}));
      // Wire job AbortController so pause/cancel actually stops segment fetches
      const ac = jid ? jobAbortControllers.get(jid) : null;
      const stopCheck = () => {
        if (jid) throwIfJobStopped(jid);
        if (ac?.signal?.aborted) {
          const job = jid ? activeDownloads.get(jid) : null;
          if (job?.pauseRequested) {
            const e = new Error("PAUSED");
            e.code = "PAUSED";
            throw e;
          }
          const e = new Error("CANCELLED");
          e.code = "CANCELLED";
          throw e;
        }
      };
      // Stream segments straight into IndexedDB (disk-backed parts) as they
      // arrive — avoids holding the whole file in SW memory and removes the
      // single giant post-download write. Falls back to the in-memory blob
      // path when IDB is unavailable.
      const resumeJob = jid ? activeDownloads.get(jid) : null;
      const resumeQuality = preferQuality || "best";
      const previousResume = resumeJob?.resumeState;
      const canReusePrevious =
        previousResume?.kind === "hls" &&
        previousResume.url === url &&
        previousResume.quality === resumeQuality;
      if (previousResume?.partBase && !canReusePrevious) {
        await idbDeleteParts(previousResume.partBase);
      }
      const partBase =
        (canReusePrevious && previousResume.partBase) ||
        (jid
          ? `hls_${String(jid).replace(/[^a-z0-9_-]/gi, "_")}`
          : `hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      let partDb = null;
      let resumeParts = new Map();
      try {
        partDb = await openBlobDb();
        if (canReusePrevious) {
          const storedParts = await idbListParts(partBase);
          for (const stored of storedParts) {
            const metadata = previousResume.parts?.[stored.index];
            if (
              stored.size > 0 &&
              metadata?.sourceUrl &&
              Number(metadata.size) === stored.size
            ) {
              resumeParts.set(stored.index, {
                size: stored.size,
                sourceUrl: metadata.sourceUrl
              });
            }
          }
        }
        if (resumeJob) {
          resumeJob.resumeState = {
            kind: "hls",
            url,
            quality: resumeQuality,
            partBase,
            parts: canReusePrevious ? { ...(previousResume.parts || {}) } : {}
          };
        }
      } catch {
        partDb = null;
        resumeParts = new Map();
      }

      let result;
      try {
        result = await HLS.downloadAndMerge(url, {
          preferQuality: preferQuality || "best",
          pageUrl,
          referer: pageUrl,
          signal: ac?.signal || null,
          shouldStop: stopCheck,
          requestInit: {
            credentials: "include",
            cache: "no-store",
            headers: pageUrl ? { Referer: pageUrl } : {},
            signal: ac?.signal || undefined
          },
          allowPartial: true,
          speedProfile: settingsForSpeed?.downloadSpeed || "fast",
          resumeParts,
          onSegmentData: partDb
            ? async (idx, data, metadata = {}) => {
                await idbPutPart(partDb, idbPartKey(partBase, idx), data);
                if (resumeJob?.resumeState?.partBase === partBase) {
                  resumeJob.resumeState.parts[idx] = {
                    size: Number(data?.byteLength || data?.size || 0),
                    sourceUrl: metadata.sourceUrl || ""
                  };
                }
              }
            : undefined,
          onProgress: (p) => {
            stopCheck();
            // Absolute percent from phase + segment ratio (honest)
            setProg(p);
          }
        });
      } catch (e) {
        const paused =
          e?.code === "PAUSED" ||
          resumeJob?.pauseRequested ||
          resumeJob?.status === "paused";
        if (!paused) {
          await idbDeleteParts(partBase);
          if (resumeJob?.resumeState?.partBase === partBase) {
            delete resumeJob.resumeState;
          }
        }
        throw e;
      } finally {
        try {
          partDb?.close();
        } catch {
          /* ignore */
        }
      }

      if (!result.size || result.size < 100_000) {
        if (result.streamed) idbDeleteParts(partBase);
        throw new Error(`파일이 너무 작습니다 (${Math.round((result.size || 0) / 1024)}KB)`);
      }

      // Keep the name locked at start — only stamp real quality from the merge result.
      // Do NOT re-read tab title / media map (user may have navigated to another video).
      let name = lockedName;
      if (!name || UVD.isGenericSaveName(name.replace(/\.[a-z0-9]+$/i, ""))) {
        // Rare: no hint at start — rebuild only from itemHint / pageUrl of THIS job
        name = lockSaveName({
          filenameHint: filenameHint || itemHint?.filename || "",
          title: itemHint?.title || itemHint?.pageTitle || "",
          pageTitle: itemHint?.pageTitle || "",
          quality: result.quality || preferQuality || "",
          pageUrl: pageUrl || itemHint?.pageUrl || ""
        });
      } else {
        name = applyQualityToLockedName(
          name,
          result.quality || preferQuality || "",
          "video"
        );
      }
      if (!name) {
        name = safeDownloadName(
          Naming.buildFilename({
            title: "영상",
            quality: result.quality || preferQuality || "",
            type: "video"
          }),
          "video/mp4"
        );
      }

      const saveStartedAt = Date.now();
      const blobSize = result.size || result.blob?.size || 0;
      const sizeMb = blobSize > 0 ? Math.round(blobSize / (1024 * 1024)) : 0;
      setProg({
        phase: "save",
        message: sizeMb
          ? `디스크에 쓰는 중… 약 ${sizeMb}MB (네트워크 완료)`
          : "디스크에 쓰는 중… (네트워크 완료)",
        percent: 86
      });
      const saveProgress = (wp) => {
        const pct = estimateSavePercent(
          blobSize,
          saveStartedAt,
          wp?.bytesReceived,
          wp?.totalBytes
        );
        const rec = wp?.bytesReceived || 0;
        const tot = wp?.totalBytes > 0 ? wp.totalBytes : blobSize;
        let msg = "디스크에 쓰는 중…";
        if (tot > 0 && rec > 0) {
          const mb = Math.round(rec / (1024 * 1024));
          const tmb = Math.round(tot / (1024 * 1024));
          msg = `디스크에 쓰는 중… ${mb}/${tmb}MB`;
        } else if (sizeMb) {
          const elapsed = Math.round((Date.now() - saveStartedAt) / 1000);
          msg = `디스크에 쓰는 중… 약 ${sizeMb}MB · ${elapsed}초`;
        }
        setProg({
          phase: "save",
          percent: pct,
          message: msg,
          current: rec,
          total: tot
        });
      };
      // Streamed mode: parts are already on disk (IDB) — the save page assembles
      // a lazy Blob(parts) and hands it to chrome.downloads. Legacy mode keeps
      // the in-memory blob chain.
      const saved = result.streamed
        ? await downloadPartsViaTab(partBase, name, blobSize, {
            onProgress: saveProgress
          })
        : await downloadBlob(result.blob, name, { onProgress: saveProgress });
      if (resumeJob?.resumeState?.partBase === partBase) {
        delete resumeJob.resumeState;
      }
      setProg({ phase: "done", percent: 100, message: "저장 완료" });
      setTimeout(() => hlsProgress.delete(key), 3000);

      return {
        ok: true,
        downloadId: saved.downloadId,
        filename: saved.filename || name,
        path: saved.path,
        state: saved.state,
        size: result.size,
        quality: result.quality,
        segmentCount: result.segmentCount
      };
    }

    return { runHlsDownload };
  }

  return { createRunner };
});
