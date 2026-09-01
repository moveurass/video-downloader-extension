(function initBackgroundDownloadJobs(root, factory) {
  const api = factory();
  root.UVDBackgroundDownloadJobs = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundDownloadJobs() {
  "use strict";

  function createManager(deps) {
    const {
      chrome,
      UVD,
      UVDProgress,
      Naming,
      YtDlp,
      parseSpeedFromMessage,
      getTabMeta,
      saveCompanionThumbnail,
      downloadPageFromUi,
      startKeepAlive,
      stopKeepAlive,
      cleanupResumeState,
      waitForChromeDownload
    } = deps;
    const now = deps.now || Date.now;
    const schedule = deps.setTimeout || setTimeout;
    const AbortControllerImpl = deps.AbortController || AbortController;

    const activeDownloads = new Map();
    const tabJobMap = new Map();
    const jobAbortControllers = new Map();
    const hlsProgress = new Map();
    const notifActions = new Map();
    let jobSeq = 0;
    let currentJobContext = null;
    let notificationListenerBound = false;
    let durableWrite = Promise.resolve();
    const DURABLE_PAUSED_KEY = "uvdPausedDownloads";

    function publicJob(job) {
      if (!job) return null;
      const errMeta = job.error ? UVD.classifyError(job.error) : null;
      return {
        id: job.id,
        tabId: job.tabId,
        title: job.title,
        pageUrl: job.pageUrl,
        mediaUrl: job.mediaUrl || "",
        filename: job.filename,
        status: job.status,
        percent: job.percent,
        progressVersion: job.progressVersion || UVDProgress.VERSION,
        progressAttempt: job.progressAttempt || 1,
        progressSeq: job.progressSeq || 0,
        message: job.message,
        phase: job.phase,
        error: job.error,
        errorCode: job.errorCode || errMeta?.code || null,
        errorLabel: errMeta?.label || null,
        errorHint: errMeta?.hint || null,
        errorActions: errMeta?.actions || [],
        mediaMode: job.mediaMode || "video",
        quality: job.quality || "",
        helperJobId: job.helperJobId || null,
        speedBps: job.speedBps || 0,
        speedLabel: job.speedBps ? UVD.formatSpeed(job.speedBps) : "",
        estimatedSize: job.estimatedSize || 0,
        resumeState: job.resumeState
          ? {
              kind: job.resumeState.kind,
              downloadId: job.resumeState.downloadId ?? null,
              url: job.resumeState.url || "",
              quality: job.resumeState.quality || "",
              partBase: job.resumeState.partBase || "",
              parts: job.resumeState.parts || {},
              bytesReceived: job.resumeState.bytesReceived || 0,
              totalBytes: job.resumeState.totalBytes || 0
            }
          : null,
        result: job.result
          ? {
              ok: job.result.ok,
              downloadId: job.result.downloadId ?? null,
              path: job.result.path || job.result.outDir || "",
              filename: job.result.filename || job.filename,
              size: job.result.size || 0,
              method: job.result.method || null,
              ytdlp: !!job.result.ytdlp
            }
          : null,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt
      };
    }

    async function restorePausedJobs() {
      try {
        const [localData, sessionData] = await Promise.all([
          chrome.storage?.local?.get
            ? chrome.storage.local.get(DURABLE_PAUSED_KEY)
            : Promise.resolve({}),
          chrome.storage?.session?.get
            ? chrome.storage.session.get("uvdActiveDownloads")
            : Promise.resolve({})
        ]);
        const durable = Array.isArray(localData?.[DURABLE_PAUSED_KEY])
          ? localData[DURABLE_PAUSED_KEY]
          : [];
        const session = Array.isArray(sessionData?.uvdActiveDownloads)
          ? sessionData.uvdActiveDownloads
          : [];
        const savedById = new Map();
        for (const item of session) {
          if (item?.id && item.status === "paused") savedById.set(item.id, item);
        }
        // Durable rows win because they survive a full browser restart and are
        // written only after a pause has completed.
        for (const item of durable) {
          if (item?.id && item.status === "paused") savedById.set(item.id, item);
        }
        for (const item of savedById.values()) {
          if (!item?.id || item.status !== "paused") continue;
          if (
            item.resumeState?.kind === "direct" &&
            item.resumeState.downloadId != null &&
            chrome.downloads?.search
          ) {
            const [download] = await chrome.downloads
              .search({ id: item.resumeState.downloadId })
              .catch(() => []);
            if (
              !download ||
              (download.state !== "in_progress" && !download.canResume)
            ) {
              continue;
            }
          }
          activeDownloads.set(item.id, {
            ...item,
            status: "paused",
            phase: "paused",
            pauseRequested: true,
            cancelRequested: false,
            resumeState: item.resumeState || null,
            _restoredFromStorage: true
          });
        }
        await syncDurablePausedJobs();
      } catch {
        // Session recovery is best-effort.
      }
    }

    const ready = restorePausedJobs();

    function syncDurablePausedJobs() {
      if (!chrome.storage?.local?.set) return Promise.resolve();
      durableWrite = durableWrite
        .catch(() => {})
        .then(() => {
          const paused = [...activeDownloads.values()]
            .filter((job) => job.status === "paused")
            .map(publicJob);
          return chrome.storage.local.set({ [DURABLE_PAUSED_KEY]: paused });
        });
      return durableWrite;
    }

    function throwIfJobStopped(jobId) {
      if (!jobId) return;
      const job = activeDownloads.get(jobId);
      if (!job) return;
      if (job.pauseRequested || job.status === "paused") {
        const error = new Error("PAUSED");
        error.code = "PAUSED";
        throw error;
      }
      if (job.cancelRequested || job.status === "cancelled") {
        const error = new Error("CANCELLED");
        error.code = "CANCELLED";
        throw error;
      }
    }

    function finalizePausedJob(jobId) {
      const job = activeDownloads.get(jobId);
      if (!job) return;
      if (job.status === "cancelled" || job.status === "done") return;
      job.status = "paused";
      job.phase = "paused";
      job.message = "일시정지됨 · 이어받기 가능";
      job.pauseRequested = true;
      job.cancelRequested = false;
      job.error = null;
      job.updatedAt = now();
      try {
        jobAbortControllers.get(jobId)?.abort();
      } catch {
        // Best-effort abort.
      }
      jobAbortControllers.delete(jobId);
      persistJobs();
      syncDurablePausedJobs().catch(() => {});
      broadcastJob(job);
      updateDownloadBadge();
    }

    function finishCancelledJob(jobId) {
      const job = activeDownloads.get(jobId);
      if (!job) return;
      if (job.status === "done") return;
      job.status = "cancelled";
      job.phase = "cancelled";
      job.message = "취소됨";
      job.error = "사용자가 취소했습니다";
      job.cancelRequested = true;
      job.pauseRequested = false;
      job.updatedAt = now();
      try {
        jobAbortControllers.get(jobId)?.abort();
      } catch {
        // Best-effort abort.
      }
      jobAbortControllers.delete(jobId);
      if (job.tabId != null && tabJobMap.get(job.tabId) === jobId) {
        tabJobMap.delete(job.tabId);
      }
      delete job.resumeState;
      persistJobs();
      syncDurablePausedJobs().catch(() => {});
      broadcastJob(job);
      updateDownloadBadge();
      try {
        if (job.tabId != null && job.tabId >= 0) {
          chrome.tabs
            .sendMessage(job.tabId, { type: "STOP_DOWNLOAD", jobId })
            .catch(() => {});
        }
      } catch {
        // Tab may already be gone.
      }
      schedule(() => {
        const current = activeDownloads.get(jobId);
        if (current && current.status === "cancelled") {
          activeDownloads.delete(jobId);
          persistJobs();
          updateDownloadBadge();
        }
      }, 30_000);
    }

    function jobIsStopping(job) {
      if (!job) return false;
      return (
        job.pauseRequested ||
        job.cancelRequested ||
        job.status === "paused" ||
        job.status === "cancelled" ||
        job.status === "done" ||
        job.status === "error"
      );
    }

    async function cancelDownloadJob(jobId) {
      await ready;
      const job = activeDownloads.get(jobId);
      if (!job) return { ok: false, error: "작업 없음" };
      if (job.status === "done" || job.status === "cancelled") {
        return { ok: true, status: job.status };
      }
      job.cancelRequested = true;
      job.pauseRequested = false;
      job.message = "취소 중…";
      job.updatedAt = now();
      try {
        jobAbortControllers.get(jobId)?.abort();
      } catch {
        // Best-effort abort.
      }
      if (job.helperJobId) {
        try {
          await YtDlp.cancelJob(job.helperJobId);
        } catch {
          // Helper may already have stopped.
        }
      }
      const chromeDownloadId =
        job.resumeState?.kind === "direct"
          ? job.resumeState.downloadId
          : job.result?.downloadId;
      if (chromeDownloadId != null) {
        try {
          await chrome.downloads.cancel(chromeDownloadId);
        } catch {
          // Chrome download may already be terminal.
        }
      }
      if (job.resumeState?.kind === "hls") {
        await Promise.resolve(cleanupResumeState?.(job.resumeState)).catch(
          () => {}
        );
      }
      delete job.resumeState;
      finishCancelledJob(jobId);
      await syncDurablePausedJobs();
      return { ok: true, status: "cancelled" };
    }

    async function pauseDownloadJob(jobId) {
      await ready;
      const job = activeDownloads.get(jobId);
      if (!job) return { ok: false, error: "작업 없음" };
      if (job.status !== "running") {
        return { ok: false, error: "받는 중인 항목만 일시정지할 수 있습니다" };
      }
      job.pauseRequested = true;
      job.cancelRequested = false;
      job.message = "일시정지 중…";
      job.updatedAt = now();
      const directDownloadId =
        job.resumeState?.kind === "direct"
          ? job.resumeState.downloadId
          : null;
      if (directDownloadId != null) {
        try {
          await chrome.downloads.pause(directDownloadId);
        } catch (error) {
          job.pauseRequested = false;
          job.message = String(
            error?.message || "이 서버는 직접 다운로드 일시정지를 지원하지 않습니다"
          );
          job.updatedAt = now();
          persistJobs();
          broadcastJob(job);
          return { ok: false, error: job.message };
        }
        finalizePausedJob(jobId);
        await syncDurablePausedJobs();
        return {
          ok: true,
          status: "paused",
          resumeKind: "http-range",
          bytesReceived: job.resumeState?.bytesReceived || 0
        };
      }
      try {
        jobAbortControllers.get(jobId)?.abort();
      } catch {
        // Best-effort abort.
      }
      if (job.helperJobId) {
        try {
          await YtDlp.cancelJob(job.helperJobId);
        } catch {
          // Helper may already have stopped.
        }
      }
      try {
        if (job.tabId != null && job.tabId >= 0) {
          chrome.tabs
            .sendMessage(job.tabId, { type: "STOP_DOWNLOAD", jobId })
            .catch(() => {});
        }
      } catch {
        // Tab may already be gone.
      }
      finalizePausedJob(jobId);
      await syncDurablePausedJobs();
      return { ok: true, status: "paused" };
    }

    async function resumeDownloadJob(jobId) {
      await ready;
      const job = activeDownloads.get(jobId);
      if (!job) return { ok: false, error: "작업 없음" };
      if (job.status !== "paused") {
        return { ok: false, error: "일시정지된 항목만 다시 시작할 수 있습니다" };
      }
      const directDownloadId =
        job.resumeState?.kind === "direct"
          ? job.resumeState.downloadId
          : null;
      if (directDownloadId != null) {
        try {
          await chrome.downloads.resume(directDownloadId);
        } catch (error) {
          return {
            ok: false,
            error: String(
              error?.message ||
                "서버가 HTTP Range 이어받기를 지원하지 않아 다시 시작할 수 없습니다"
            )
          };
        }
        job.status = "running";
        job.phase = "download";
        job.message = "이어받는 중…";
        job.pauseRequested = false;
        job.cancelRequested = false;
        job.error = null;
        job._nextProgressAttempt = true;
        job.updatedAt = now();
        persistJobs();
        broadcastJob(job);
        updateDownloadBadge();
        await syncDurablePausedJobs();
        if (job._restoredFromStorage && waitForChromeDownload) {
          delete job._restoredFromStorage;
          const keep = startKeepAlive();
          Promise.resolve(waitForChromeDownload(directDownloadId))
            .then((result) => {
              const current = activeDownloads.get(jobId);
              if (current?.pauseRequested) {
                finalizePausedJob(jobId);
                return;
              }
              finishDownloadJob(
                jobId,
                {
                  ok: true,
                  downloadId: directDownloadId,
                  filename: job.filename,
                  path: result?.path || "",
                  size: result?.bytesReceived || job.resumeState?.totalBytes || 0,
                  method: "chrome-downloads"
                },
                null
              );
            })
            .catch((error) => {
              const current = activeDownloads.get(jobId);
              if (current?.pauseRequested) finalizePausedJob(jobId);
              else finishDownloadJob(jobId, null, error);
            })
            .finally(() => stopKeepAlive(keep));
        }
        return {
          ok: true,
          status: "running",
          resumeKind: "http-range",
          bytesReceived: job.resumeState?.bytesReceived || 0
        };
      }
      const pageUrl = job.pageUrl || "";
      if (!pageUrl || !/^https?:/i.test(pageUrl)) {
        return { ok: false, error: "다시 시작할 주소가 없습니다" };
      }
      job.status = "running";
      job.phase = "start";
      job.message =
        job.resumeState?.kind === "hls"
          ? "저장된 조각부터 이어받는 중…"
          : "부분 파일부터 이어받는 중…";
      job.pauseRequested = false;
      job.cancelRequested = false;
      job.error = null;
      job.helperJobId = null;
      job._nextProgressAttempt = true;
      job.updatedAt = now();
      jobAbortControllers.set(jobId, new AbortControllerImpl());
      persistJobs();
      broadcastJob(job);
      updateDownloadBadge();
      await syncDurablePausedJobs();
      const keep = startKeepAlive();
      withJobContext(jobId, () =>
        downloadPageFromUi(job.tabId, pageUrl, job.quality || "best", jobId, {
          mediaMode: job.mediaMode,
          mediaUrl: job.mediaUrl || "",
          title: job.title || "",
          resume: true
        })
      )
        .then((result) => {
          const current = activeDownloads.get(jobId);
          if (current?.pauseRequested) finalizePausedJob(jobId);
          else if (current?.cancelRequested) finishCancelledJob(jobId);
          else finishDownloadJob(jobId, result, null);
          stopKeepAlive(keep);
        })
        .catch((error) => {
          const current = activeDownloads.get(jobId);
          const message = String(error?.message || error || "");
          if (current?.pauseRequested || /PAUSED/i.test(message)) {
            finalizePausedJob(jobId);
          } else if (current?.cancelRequested || /CANCELLED|취소/i.test(message)) {
            finishCancelledJob(jobId);
          } else {
            finishDownloadJob(jobId, null, error);
          }
          stopKeepAlive(keep);
        });
      return { ok: true, status: "running" };
    }

    function persistJobs() {
      try {
        const list = [...activeDownloads.values()].map(publicJob);
        if (chrome.storage?.session?.set) {
          chrome.storage.session.set({ uvdActiveDownloads: list }).catch(() => {});
        } else {
          chrome.storage?.local?.set?.({ uvdActiveDownloads: list });
        }
      } catch {
        // Storage is best-effort.
      }
    }

    function advanceJobEvent(job) {
      if (!job) return;
      job.progressVersion = UVDProgress.VERSION;
      job.progressAttempt = Math.max(1, Number(job.progressAttempt) || 1);
      if (job._nextProgressAttempt) {
        job.progressAttempt += 1;
        delete job._nextProgressAttempt;
      }
      job.progressSeq = Math.max(0, Number(job.progressSeq) || 0) + 1;
      job.updatedAt = now();
    }

    function broadcastJob(job) {
      if (!job) return;
      advanceJobEvent(job);
      const pub = publicJob(job);
      const progress = {
        percent: job.percent,
        message: job.message,
        phase: job.phase,
        jobId: job.id,
        progressVersion: job.progressVersion,
        progressAttempt: job.progressAttempt,
        progressSeq: job.progressSeq,
        title: job.title,
        status: job.status,
        global: true
      };
      persistJobs();
      hlsProgress.set(job.tabId ?? -1, progress);
      hlsProgress.set(-1, progress);
      chrome.runtime
        .sendMessage({ type: "DOWNLOAD_JOB", job: pub })
        .catch(() => {});
    }

    function createDownloadJob({
      tabId,
      title,
      pageUrl,
      mediaUrl,
      filename,
      mediaMode,
      quality,
      thumbnail,
      seriesId,
      seriesKey,
      seriesIndex,
      seriesTitle,
      tags
    } = {}) {
      const id = `dl_${now()}_${++jobSeq}`;
      let thumb = thumbnail || "";
      if (!thumb && tabId != null && tabId >= 0) {
        thumb = getTabMeta(tabId)?.thumbnail || "";
      }
      let niceTitle = String(title || "").trim();
      if (niceTitle && typeof Naming !== "undefined" && Naming.cleanPageTitle) {
        niceTitle = Naming.cleanPageTitle(niceTitle) || niceTitle;
      }
      if (!niceTitle || UVD.isGenericSaveName(niceTitle)) {
        const fromFile = String(filename || "")
          .replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "")
          .trim();
        if (fromFile && !UVD.isGenericSaveName(fromFile)) niceTitle = fromFile;
      }
      if (!niceTitle) niceTitle = "영상";
      const jobTags = [
        ...new Set(
          [
            ...(Array.isArray(tags) ? tags : []),
            seriesId || "",
            seriesKey || "",
            seriesId ? "series" : ""
          ].filter(Boolean)
        )
      ];
      const job = {
        id,
        tabId: tabId != null ? tabId : -1,
        title: niceTitle,
        pageUrl: pageUrl || "",
        mediaUrl: mediaUrl || "",
        filename: filename || "",
        mediaMode: mediaMode || "video",
        quality: quality || "",
        thumbnail: thumb || "",
        seriesId: seriesId || "",
        seriesKey: seriesKey || "",
        seriesIndex: seriesIndex || 0,
        seriesTitle: seriesTitle || "",
        tags: jobTags,
        status: "running",
        percent: 2,
        progressVersion: UVDProgress.VERSION,
        progressAttempt: 1,
        progressSeq: 0,
        message:
          niceTitle !== "영상"
            ? `받는 중 · ${niceTitle.slice(0, 40)}`
            : "백그라운드에서 받는 중…",
        phase: "start",
        error: null,
        errorCode: null,
        result: null,
        helperJobId: null,
        cancelRequested: false,
        pauseRequested: false,
        startedAt: now(),
        updatedAt: now()
      };
      activeDownloads.set(id, job);
      jobAbortControllers.set(id, new AbortControllerImpl());
      if (tabId != null && tabId >= 0) tabJobMap.set(tabId, id);
      persistJobs();
      broadcastJob(job);
      updateDownloadBadge();
      return id;
    }

    function countRunningJobs() {
      let count = 0;
      for (const job of activeDownloads.values()) {
        if (job.status === "running") count += 1;
      }
      return count;
    }

    function findRunningJob(tabId, explicitJobId = null) {
      if (explicitJobId) {
        const job = activeDownloads.get(explicitJobId);
        if (job) return job;
      }
      const running = countRunningJobs();
      if (running <= 1 && currentJobContext) {
        const contextJob = activeDownloads.get(currentJobContext);
        if (contextJob?.status === "running") return contextJob;
      }
      if (running === 1) {
        for (const job of activeDownloads.values()) {
          if (job.status === "running") return job;
        }
      }
      if (running > 1) return null;
      if (tabId != null && tabId >= 0) {
        const mapped = tabJobMap.get(tabId);
        if (mapped) {
          const job = activeDownloads.get(mapped);
          if (job?.status === "running") return job;
        }
      }
      return null;
    }

    async function withJobContext(jobId, fn) {
      const previous = currentJobContext;
      currentJobContext = jobId;
      try {
        return await fn();
      } finally {
        currentJobContext = previous;
      }
    }

    function getCurrentJobContext() {
      return currentJobContext;
    }

    function updateDownloadJob(jobId, patch) {
      const job = activeDownloads.get(jobId);
      if (!job) return null;
      if (jobIsStopping(job) && job.status !== "running") return job;
      if (job.pauseRequested || job.cancelRequested) {
        if (patch.status === "running" || patch.percent != null || patch.message) {
          return job;
        }
      }
      if (job.status !== "running" && patch.status === "running") return job;
      const next = { ...patch };
      if (job.status === "running" && typeof next.percent === "number") {
        const previousPercent = typeof job.percent === "number" ? job.percent : 0;
        if (next.progressReset) {
          next.percent = Math.max(0, Math.min(100, next.percent));
          delete next.progressReset;
          job._nextProgressAttempt = true;
        } else {
          next.percent = Math.max(previousPercent, Math.min(100, next.percent));
        }
      }
      if (job.status === "running") {
        const fromMessage = parseSpeedFromMessage(next.message || job.message || "");
        if (fromMessage > 0) {
          next.speedBps = fromMessage;
        } else if (
          typeof next.percent === "number" &&
          (job.estimatedSize > 0 || next.estimatedSize > 0)
        ) {
          const estimated = next.estimatedSize || job.estimatedSize || 0;
          const at = now();
          const bytesNow = (next.percent / 100) * estimated;
          const previousBytes = job._speedBytes;
          const previousAt = job._speedAt;
          if (
            previousBytes != null &&
            previousAt &&
            at - previousAt >= 400 &&
            bytesNow > previousBytes
          ) {
            const instant = ((bytesNow - previousBytes) / (at - previousAt)) * 1000;
            const previousSpeed = job.speedBps || instant;
            next.speedBps = previousSpeed * 0.55 + instant * 0.45;
          }
          next._speedBytes = bytesNow;
          next._speedAt = at;
        }
      }
      Object.assign(job, next, { updatedAt: now() });
      broadcastJob(job);
      updateDownloadBadge();
      return job;
    }

    function finishDownloadJob(jobId, result, error) {
      const job = activeDownloads.get(jobId);
      if (!job) return;
      if (!error && result) {
        const size = Number(result.size) || 0;
        const method = String(result.method || result.source || "");
        const isBlobish =
          /hls|blob|page|fetch|merge|offscreen|tab/i.test(method) ||
          (!method && result.blob);
        if (size > 0 && size < 100_000) {
          error = new Error(
            `파일이 너무 작습니다 (${Math.round(size / 1024)}KB) — 불완전한 다운로드`
          );
          result = null;
        } else if (isBlobish && size <= 0) {
          error = new Error("빈 파일은 저장할 수 없습니다");
          result = null;
        }
      }
      if (error) {
        job.status = "error";
        job.phase = "error";
        job.error = String(error?.message || error);
        job.message = job.error;
        job.percent = job.percent || 0;
        const meta = UVD.classifyError(job.error);
        job.errorCode = meta.code;
        job.errorLabel = meta.label || "";
        job.errorHint = meta.hint || "";
      } else {
        job.status = "done";
        job.phase = "done";
        job.percent = 100;
        job.result = result || null;
        job.error = null;
        job.errorCode = null;
        job.errorLabel = null;
        job.errorHint = null;
        const savedName =
          result?.filename ||
          (result?.path ? String(result.path).split(/[/\\]/).pop() : "") ||
          job.filename ||
          "";
        if (savedName) {
          job.filename = savedName;
          const base = String(savedName).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
          if (
            base &&
            (!job.title || job.title === "영상" || UVD.isGenericSaveName(job.title))
          ) {
            job.title = base;
          }
          job.message = `저장 완료 · ${savedName}`;
        } else {
          job.message = "저장 완료";
        }
      }
      job.updatedAt = now();
      if (job.tabId != null && tabJobMap.get(job.tabId) === jobId) {
        tabJobMap.delete(job.tabId);
      }
      delete job.resumeState;
      persistJobs();
      syncDurablePausedJobs().catch(() => {});
      broadcastJob(job);
      updateDownloadBadge();
      try {
        UVD.appendHistory({
          id: `h_${job.id}`,
          title: job.title,
          filename: result?.filename || job.filename,
          url: job.pageUrl,
          pageUrl: job.pageUrl,
          path: result?.path || result?.outDir || "",
          downloadId: result?.downloadId ?? null,
          status: job.status,
          error: job.error,
          errorCode: job.errorCode,
          size: result?.size || 0,
          method: result?.method || "",
          quality: job.quality || "",
          mediaMode: job.mediaMode || "video",
          site: UVD.siteFromUrl(job.pageUrl || ""),
          thumbnail: job.thumbnail || "",
          tags: job.tags || [],
          seriesId: job.seriesId || "",
          seriesKey: job.seriesKey || "",
          seriesIndex: job.seriesIndex || 0,
          at: now()
        }).catch(() => {});
      } catch {
        // History is best-effort.
      }
      if (!error && job.status === "done") {
        saveCompanionThumbnail(job, result).catch(() => {});
      }
      notifyDownloadFinished(job, result, error).catch(() => {});
      schedule(() => {
        const current = activeDownloads.get(jobId);
        if (current && current.status !== "running") {
          activeDownloads.delete(jobId);
          persistJobs();
          if (hlsProgress.get(-1)?.jobId === jobId) hlsProgress.delete(-1);
          updateDownloadBadge();
        }
      }, 120_000);
    }

    async function notifyDownloadFinished(job, result, error) {
      try {
        const settings = await UVD.getSettings();
        if (settings.notifyOnComplete === false) return;
        if (!chrome.notifications?.create) return;
        const title = (job?.title || job?.filename || "영상").slice(0, 60);
        const ok = !error && job?.status === "done";
        const notifId = `uvd_${job?.id || now()}`;
        const path = result?.path || result?.outDir || "";
        const downloadId = result?.downloadId ?? null;
        const size = result?.size || 0;
        const sizeText =
          size >= 1024 * 1024
            ? `${(size / 1024 / 1024).toFixed(1)}MB`
            : size > 0
              ? `${Math.round(size / 1024)}KB`
              : "";
        notifActions.set(notifId, {
          downloadId,
          path,
          pageUrl: job?.pageUrl || ""
        });
        if (notifActions.size > 40) {
          const first = notifActions.keys().next().value;
          notifActions.delete(first);
        }
        let failMessage = String(error?.message || job?.error || "실패");
        try {
          const meta = UVD.classifyError(failMessage);
          if (meta?.code && meta.code !== "other") {
            failMessage = meta.hint
              ? `${meta.label} — ${meta.hint}`
              : meta.label || failMessage;
          }
        } catch {
          // Keep raw message.
        }
        await chrome.notifications.create(notifId, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: ok ? "저장 완료" : "다운로드 실패",
          message: ok
            ? `${title}${sizeText ? ` · ${sizeText}` : ""}\n클릭하면 폴더를 엽니다`
            : `${title}\n${failMessage.slice(0, 120)}`,
          priority: ok ? 1 : 2,
          requireInteraction: !ok
        });
      } catch (notificationError) {
        (deps.console || console).warn("[UVD] notify", notificationError);
      }
    }

    function bindNotificationListener() {
      if (notificationListenerBound || !chrome.notifications?.onClicked) return;
      notificationListenerBound = true;
      chrome.notifications.onClicked.addListener(async (notifId) => {
        const info = notifActions.get(notifId);
        try {
          chrome.notifications.clear(notifId).catch(() => {});
          if (info?.downloadId != null) {
            chrome.downloads.show(info.downloadId);
            return;
          }
          if (info?.path) {
            const name = String(info.path).split(/[/\\]/).pop();
            if (name) {
              const items = await chrome.downloads.search({
                filenameRegex: name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                limit: 3,
                orderBy: ["-startTime"]
              });
              if (items?.[0]?.id != null) {
                chrome.downloads.show(items[0].id);
                return;
              }
            }
          }
          chrome.downloads.showDefaultFolder?.();
        } catch {
          // Click actions are best-effort.
        }
      });
    }

    function listActiveDownloads() {
      return [...activeDownloads.values()]
        .sort((first, second) => second.startedAt - first.startedAt)
        .map(publicJob);
    }

    async function updateDownloadBadge() {
      try {
        const settings = await UVD.getSettings();
        if (settings.showBadge === false) {
          chrome.action.setBadgeText({ text: "" });
          chrome.action.setTitle({ title: "Video Downloader" });
          return;
        }
        const running = [...activeDownloads.values()].filter(
          (job) => job.status === "running"
        ).length;
        const paused = [...activeDownloads.values()].filter(
          (job) => job.status === "paused"
        ).length;
        if (running > 0) {
          chrome.action.setBadgeText({ text: String(running) });
          chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
          chrome.action.setTitle({
            title: `받는 중 ${running}개${paused ? ` · 정지 ${paused}` : ""} · 페이지 이동 OK`
          });
        } else if (paused > 0) {
          chrome.action.setBadgeText({ text: "❚" });
          chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
          chrome.action.setTitle({ title: `일시정지 ${paused}개` });
        } else {
          chrome.action.setBadgeText({ text: "" });
          chrome.action.setTitle({ title: "Video Downloader" });
        }
      } catch {
        // Badge is best-effort.
      }
    }

    function detachJobsFromTab(tabId) {
      if (tabId == null) return;
      const mapped = tabJobMap.get(tabId);
      if (mapped) {
        const job = activeDownloads.get(mapped);
        if (job?.status === "running") {
          job.tabId = -1;
          job.updatedAt = now();
          if (!/백그라운드|이동/i.test(job.message || "")) {
            job.message = (job.message || "받는 중…") + " · 백그라운드";
          }
          persistJobs();
          broadcastJob(job);
        } else {
          tabJobMap.delete(tabId);
        }
      }
      for (const job of activeDownloads.values()) {
        if (job.tabId === tabId && job.status === "running") {
          job.tabId = -1;
          job.updatedAt = now();
          persistJobs();
          broadcastJob(job);
        }
      }
    }

    function emitDownloadProgress(
      tabId,
      percent,
      message,
      phase = "download",
      jobId = null,
      extra = {}
    ) {
      const explicit = jobId ? activeDownloads.get(jobId) : null;
      if (explicit && jobIsStopping(explicit)) {
        throwIfJobStopped(jobId);
        return;
      }
      throwIfJobStopped(jobId);
      const job = findRunningJob(tabId, jobId);
      if (!job) {
        if (countRunningJobs() > 1 && !jobId) return;
        const progress = {
          percent,
          message,
          phase,
          global: true,
          jobId: jobId || null
        };
        if (jobId) hlsProgress.set(jobId, progress);
        hlsProgress.set(tabId ?? -1, progress);
        chrome.runtime
          .sendMessage({ type: "HLS_PROGRESS", tabId: tabId ?? -1, progress })
          .catch(() => {});
        return;
      }
      if (jobIsStopping(job)) {
        throwIfJobStopped(job.id);
        return;
      }
      const sourceAttempt = Number(extra.progressAttempt) || 0;
      const activeAttempt = Number(job.progressAttempt) || 1;
      if (sourceAttempt > 0 && sourceAttempt !== activeAttempt) return;
      const status =
        phase === "done" ? "done" : phase === "error" ? "error" : "running";
      if (status === "running") {
        const reset = !!extra.progressReset;
        const floor = typeof job.percent === "number" ? job.percent : 0;
        let nextPercent =
          typeof percent === "number"
            ? Math.min(100, Math.max(0, percent))
            : floor;
        if (!reset) nextPercent = Math.max(floor, nextPercent);
        updateDownloadJob(job.id, {
          percent: nextPercent,
          message,
          phase,
          ...(reset ? { progressReset: true } : {}),
          ...(extra.bytesReceived != null
            ? { bytesReceived: extra.bytesReceived }
            : {}),
          ...(extra.totalBytes != null ? { totalBytes: extra.totalBytes } : {}),
          ...(extra.segmentCurrent != null
            ? { segmentCurrent: extra.segmentCurrent }
            : {}),
          ...(extra.segmentTotal != null
            ? { segmentTotal: extra.segmentTotal }
            : {})
        });
      } else {
        const progress = {
          percent,
          message,
          phase,
          jobId: job.id,
          title: job.title,
          global: true
        };
        hlsProgress.set(job.id, progress);
        hlsProgress.set(job.tabId ?? -1, progress);
        chrome.runtime
          .sendMessage({
            type: "HLS_PROGRESS",
            tabId: job.tabId ?? -1,
            progress
          })
          .catch(() => {});
      }
    }

    bindNotificationListener();

    return {
      ready,
      activeDownloads,
      tabJobMap,
      jobAbortControllers,
      hlsProgress,
      notifActions,
      getCurrentJobContext,
      publicJob,
      throwIfJobStopped,
      finalizePausedJob,
      finishCancelledJob,
      jobIsStopping,
      cancelDownloadJob,
      pauseDownloadJob,
      resumeDownloadJob,
      persistJobs,
      advanceJobEvent,
      broadcastJob,
      createDownloadJob,
      countRunningJobs,
      findRunningJob,
      withJobContext,
      updateDownloadJob,
      finishDownloadJob,
      notifyDownloadFinished,
      bindNotificationListener,
      listActiveDownloads,
      updateDownloadBadge,
      detachJobsFromTab,
      emitDownloadProgress
    };
  }

  return { createManager };
});
