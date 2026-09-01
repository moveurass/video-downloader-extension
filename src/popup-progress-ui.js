(function initPopupProgressUi(root, factory) {
  const api = factory();
  root.UVDPopupProgressUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makePopupProgressUi() {
  "use strict";

  function createController(deps) {
    const {
      $, UVD, UVDQueueState, UVDPopupQueueUI, uiJobs, trackedJobIds,
      toastedJobIds, cleanTitleText, isUglyName, siteLabel, escapeHtml,
      escapeAttr, toast, userError
    } = deps;
    const setTimeoutFn = deps.setTimeout || setTimeout;
    const setIntervalFn = deps.setInterval || setInterval;
    const clearIntervalFn = deps.clearInterval || clearInterval;
    const now = deps.now || Date.now;
    const dlQueueEl = $("#dlQueue");
    const dlQueueList = $("#dlQueueList");
    const dlQueueTitle = $("#dlQueueTitle");
    const dlQueueSub = $("#dlQueueSub");
    const dlQueueBadge = $("#dlQueueBadge");
    const progressEl = $("#progress");
    const progressFill = $("#progressFill");
    const progressText = $("#progressText");
    let downloading = false;
    let restoredBackgroundJob = false;
    let queuePollTimer = null;
    let dlQueueFilter = "all";
    let queueOrderSeq = 0;
    let queuePatchTimer = null;
    let queuePatchDirty = false;
    let queueFullTimer = null;

    const {
      jobDisplayInfo,
      shortJobTitle,
      jobEtaLabel,
      jobPhaseLabel,
      cleanJobMessage
    } = UVDPopupQueueUI.createPresenter({
      UVD, cleanTitleText, isUglyName, siteLabel, now
    });

    function runningJobCount() {
      let n = 0;
      for (const job of uiJobs.values()) {
        if (job.status === "running") n += 1;
      }
      return n;
    }

    function canStartAnotherDownload() {
      return runningJobCount() < deps.maxConcurrentStarts;
    }

    function syncDownloadingFlag() {
      downloading = runningJobCount() > 0;
    }

    function ensureQueuePoll() {
      if (queuePollTimer) return;
      queuePollTimer = setIntervalFn(() => {
        if (runningJobCount() === 0) {
          clearIntervalFn(queuePollTimer);
          queuePollTimer = null;
          return;
        }
        refreshJobsFromBackground();
      }, 900);
    }

    async function refreshJobsFromBackground() {
      try {
        const res = await deps.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
        const jobs = res?.jobs || [];
        let structureChanged = false;
        let progressOnly = false;
        for (const job of jobs) {
          if (!job?.id) continue;
          trackedJobIds.add(job.id);
          const prev = uiJobs.get(job.id);
          if (prev && !UVDQueueState.shouldAccept(prev, job)) continue;
          if (
            prev &&
            (prev.status === "paused" || prev.status === "cancelled") &&
            job.status === "running"
          ) {
            continue;
          }
          const prevPct = Math.round(prev?.percent || 0);
          const nextPct = Math.round(
            typeof job.percent === "number" ? job.percent : prevPct
          );
          const statusChanged = !prev || prev.status !== job.status;
          const progressChanged =
            prev &&
            (prevPct !== nextPct ||
              (prev.message || "") !== (job.message || "") ||
              (prev.phase || "") !== (job.phase || ""));
          if (statusChanged || !prev) {
            upsertUiJob(job, { toast: false, forceStructure: true });
            structureChanged = true;
          } else if (progressChanged) {
            upsertUiJob(job, { toast: false, progressOnly: true });
            progressOnly = true;
          } else {
            uiJobs.set(job.id, {
              ...prev,
              ...job,
              percent: Math.max(prevPct, nextPct),
              queueOrder: prev.queueOrder
            });
          }
        }
        const currentTime = now();
        for (const [id, job] of uiJobs) {
          if (job.status === "running" || job.status === "paused") continue;
          if (job.status === "error" || job.status === "cancelled") continue;
          if (job.pinned) continue;
          if (
            !jobs.some((candidate) => candidate.id === id) &&
            currentTime - (job.updatedAt || 0) > 60_000
          ) {
            uiJobs.delete(id);
            structureChanged = true;
          }
        }
        if (structureChanged) renderDownloadQueue(true);
        else if (progressOnly) patchQueueProgress();
      } catch {
        /* ignore */
      }
    }

    function scheduleQueuePatch() {
      queuePatchDirty = true;
      if (queuePatchTimer) return;
      queuePatchTimer = setTimeoutFn(() => {
        queuePatchTimer = null;
        if (!queuePatchDirty) return;
        queuePatchDirty = false;
        patchQueueProgress();
      }, 350);
    }

    function scheduleQueueFullRender() {
      if (queueFullTimer) return;
      queueFullTimer = setTimeoutFn(() => {
        queueFullTimer = null;
        renderDownloadQueue(true);
      }, 80);
    }

    function upsertUiJob(job, opts = {}) {
      if (!job?.id && !job?.jobId) return;
      const id = job.id || job.jobId;
      const prev = uiJobs.get(id) || {};
      if (prev.id && !UVDQueueState.shouldAccept(prev, job, opts)) return;
      const status = UVDQueueState.statusOf(job, prev);
      const percent = UVDQueueState.percentFor(prev.id ? prev : null, job, status);
      const rawMsg = job.message || prev.message || "";
      const phase = job.phase || prev.phase || "";
      const stableMsg =
        status === "running" || status === "paused"
          ? cleanJobMessage(rawMsg, phase)
          : status === "error" || status === "cancelled"
            ? cleanJobMessage(job.error || rawMsg || "실패", "error")
            : rawMsg;
      const pickTitle = (...candidates) => {
        for (const candidate of candidates) {
          const title = String(candidate || "").trim();
          if (!title) continue;
          if (UVD?.isGenericSaveName?.(title)) continue;
          if (/^(영상|동영상|video)$/i.test(title)) continue;
          return title;
        }
        return candidates.find((candidate) => String(candidate || "").trim()) || "영상";
      };
      const resultName =
        job.result?.filename ||
        (job.result?.path ? String(job.result.path).split(/[/\\]/).pop() : "") ||
        "";
      const queueOrder =
        prev.queueOrder != null ? prev.queueOrder : ++queueOrderSeq;
      const next = {
        ...prev,
        ...job,
        id,
        status,
        percent,
        message: stableMsg,
        phase,
        title: pickTitle(job.title, prev.title, job.filename, prev.filename, resultName),
        filename: job.filename || prev.filename || resultName || "",
        quality: job.quality || prev.quality || "",
        pageUrl: job.pageUrl || prev.pageUrl || "",
        speedBps:
          typeof job.speedBps === "number" && job.speedBps > 0
            ? job.speedBps
            : prev.speedBps || 0,
        speedLabel: job.speedLabel || prev.speedLabel || "",
        error: job.error || (status === "error" ? job.message : prev.error) || null,
        result: job.result || prev.result || null,
        updatedAt: job.updatedAt || now(),
        startedAt: job.startedAt || prev.startedAt || now(),
        queueOrder,
        _optimistic: !!opts.local,
        pinned: status === "error" || status === "cancelled" ? true : !!prev.pinned
      };
      if (next.speedBps && !next.speedLabel) {
        next.speedLabel = UVD.formatSpeed(next.speedBps);
      }
      if (status === "done" && resultName) {
        next.filename = resultName;
        if (!next.title || next.title === "영상" || UVD?.isGenericSaveName?.(next.title)) {
          next.title = resultName.replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
        }
      }
      const prevPctR = Math.round(prev.percent || 0);
      const nextPctR = Math.round(next.percent || 0);
      const statusChanged = prev.status !== next.status;
      const structureNeeded =
        opts.forceStructure ||
        statusChanged ||
        !prev.id ||
        prev.title !== next.title ||
        prev.filename !== next.filename;
      if (
        !structureNeeded &&
        prev.status === next.status &&
        prevPctR === nextPctR &&
        prev.message === next.message &&
        (prev.phase || "") === (next.phase || "") &&
        status === "running"
      ) {
        uiJobs.set(id, next);
        return;
      }
      uiJobs.set(id, next);
      trackedJobIds.add(id);
      syncDownloadingFlag();
      if (structureNeeded) scheduleQueueFullRender();
      else if (opts.progressOnly || status === "running" || status === "paused") {
        scheduleQueuePatch();
      } else scheduleQueueFullRender();
      if (opts.toast !== false) {
        if (status === "done" && !toastedJobIds.has(id) && !job._silentDone) {
          toastedJobIds.add(id);
          const info = jobDisplayInfo(next);
          const name =
            info.title.length > 24 ? info.title.slice(0, 22) + "…" : info.title;
          toast(`저장 완료 · ${name}`, "ok");
        } else if (status === "error" && !toastedJobIds.has(id)) {
          toastedJobIds.add(id);
          const name = shortJobTitle(next);
          toast(
            userError(next.error || next.message || "다운로드 실패") +
              (name && name !== "영상" ? ` · ${name}` : ""),
            "error"
          );
        }
      }
      if (status === "running") ensureQueuePoll();
      if (status === "done" && !next.pinned) {
        const keepMs = uiJobs.size >= 2 ? 50_000 : 25_000;
        setTimeoutFn(() => {
          const current = uiJobs.get(id);
          if (current && current.status === "done" && !current.pinned) {
            uiJobs.delete(id);
            renderDownloadQueue(true);
          }
        }, keepMs);
      }
    }

    function sortedUiJobs() {
      return [...uiJobs.values()].sort((a, b) => {
        const aOrder = a.queueOrder ?? a.startedAt ?? 0;
        const bOrder = b.queueOrder ?? b.startedAt ?? 0;
        return aOrder - bOrder;
      });
    }

    function updateQueueHeader(jobs) {
      const running = jobs.filter((job) => job.status === "running");
      const paused = jobs.filter((job) => job.status === "paused");
      const done = jobs.filter((job) => job.status === "done");
      const errored = jobs.filter(
        (job) => job.status === "error" || job.status === "cancelled"
      );
      if (dlQueueTitle) {
        if (running.length) {
          dlQueueTitle.textContent =
            jobs.length > 1
              ? `받는 중 ${running.length}/${jobs.length}`
              : `받는 중 ${running.length}개`;
        } else if (paused.length) {
          dlQueueTitle.textContent = `일시정지 ${paused.length}개`;
        } else if (errored.length && !running.length) {
          dlQueueTitle.textContent = `실패 ${errored.length}개 · 조치 필요`;
        } else if (done.length && !errored.length) {
          dlQueueTitle.textContent = `완료 ${done.length}개`;
        } else {
          dlQueueTitle.textContent = `다운로드 ${jobs.length}개`;
        }
      }
      if (dlQueueBadge) {
        const count = running.length || errored.length || done.length;
        dlQueueBadge.textContent = String(count);
        dlQueueBadge.classList.remove("hidden", "done", "error");
        if (!running.length && done.length && !errored.length) {
          dlQueueBadge.classList.add("done");
        }
        if (!running.length && errored.length) dlQueueBadge.classList.add("error");
      }
      const filters = $("#dlQueueFilters");
      if (filters) {
        if (jobs.length >= 2) {
          filters.classList.remove("hidden");
          filters.querySelectorAll(".dl-qf").forEach((button) => {
            const filter = button.getAttribute("data-qf") || "all";
            button.classList.toggle("active", filter === dlQueueFilter);
            let count = jobs.length;
            if (filter === "running") count = running.length + paused.length;
            else if (filter === "done") count = done.length;
            else if (filter === "error") count = errored.length;
            const base =
              filter === "all"
                ? "전체"
                : filter === "running"
                  ? "받는 중"
                  : filter === "done"
                    ? "완료"
                    : "실패";
            button.textContent = count ? `${base} ${count}` : base;
          });
        } else {
          filters.classList.add("hidden");
        }
      }
      if (dlQueueSub) {
        if (errored.length && !running.length) {
          dlQueueSub.textContent = `실패 ${errored.length}개 · 아래에서 다시 받기 / 닫기`;
          dlQueueSub.title = errored.map((job) => shortJobTitle(job)).join("\n");
        } else if (running.length > 1) {
          dlQueueSub.textContent = `${running.length}개 동시 받는 중 · 각 파일 진행률은 아래 참고`;
          dlQueueSub.title = running.map((job) => shortJobTitle(job)).join("\n");
        } else if (running.length === 1) {
          const info = jobDisplayInfo(running[0]);
          dlQueueSub.textContent = info.title;
          dlQueueSub.title = info.fileLabel || info.title;
        } else if (done.length) {
          dlQueueSub.textContent = "저장 위치: 다운로드/VideoDownloader";
          dlQueueSub.title = "";
        } else {
          dlQueueSub.textContent = "다시 시도해 주세요";
          dlQueueSub.title = "";
        }
      }
    }

    function patchQueueProgress() {
      if (!dlQueueEl || !dlQueueList) return;
      const jobs = sortedUiJobs();
      if (!jobs.length) {
        renderDownloadQueue(true);
        return;
      }
      updateQueueHeader(jobs);
      for (const job of jobs) {
        const safeId = String(job.id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const row = dlQueueList.querySelector(`.dl-job[data-job-id="${safeId}"]`);
        if (!row) continue;
        const status = job.status || "running";
        if (
          (status === "running" && !row.classList.contains("is-running")) ||
          (status === "paused" && !row.classList.contains("is-paused")) ||
          (status === "done" && !row.classList.contains("is-done")) ||
          ((status === "error" || status === "cancelled") &&
            !row.classList.contains("is-error"))
        ) {
          renderDownloadQueue(true);
          return;
        }
        if (status !== "running" && status !== "paused") continue;
        const percent = Math.min(100, Math.max(0, Math.round(job.percent || 0)));
        const phase = jobPhaseLabel(job);
        const message = cleanJobMessage(job.message, job.phase);
        const eta = jobEtaLabel(job);
        const speed =
          status === "running" && (job.speedLabel || job.speedBps)
            ? job.speedLabel || UVD.formatSpeed(job.speedBps)
            : "";
        const percentEl = row.querySelector(".dl-job-pct");
        if (percentEl && status === "running") percentEl.textContent = `${percent}%`;
        if (percentEl && status === "paused") percentEl.textContent = "정지";
        const phaseEl = row.querySelector(".dl-job-phase");
        if (phaseEl) phaseEl.textContent = phase;
        const messageEl = row.querySelector(".dl-job-msg");
        if (messageEl && messageEl.textContent !== message) {
          messageEl.textContent = message;
        }
        const fill = row.querySelector(".dl-job-fill");
        if (fill) fill.style.width = `${percent}%`;
        const metaLine = row.querySelector(".dl-job-meta-line");
        if (metaLine) {
          const info = jobDisplayInfo(job);
          const bits = [info.site, info.quality, phase, speed, eta].filter(Boolean);
          const key = bits.join("|");
          if (metaLine.dataset.bits !== key) {
            metaLine.dataset.bits = key;
            metaLine.innerHTML = bits
              .map((text) => `<span class="dl-job-chip">${escapeHtml(text)}</span>`)
              .join("");
          }
        }
      }
      syncDownloadingFlag();
      if (deps.getPlaylistDl().jobIds.size) deps.updatePlaylistProgressUi();
    }

    function renderDownloadQueue(_force = false) {
      if (!dlQueueEl || !dlQueueList) return;
      const jobs = sortedUiJobs();
      const running = jobs.filter((job) => job.status === "running");
      const paused = jobs.filter((job) => job.status === "paused");
      const done = jobs.filter((job) => job.status === "done");
      const errored = jobs.filter(
        (job) => job.status === "error" || job.status === "cancelled"
      );
      if (!jobs.length) {
        dlQueueEl.classList.add("hidden");
        if (progressEl) progressEl.classList.add("hidden");
        syncDownloadingFlag();
        return;
      }
      dlQueueEl.classList.remove("hidden");
      dlQueueEl.classList.toggle("is-multi", jobs.length >= 2);
      if (progressEl) progressEl.classList.add("hidden");
      updateQueueHeader(jobs);
      let visible = jobs;
      if (dlQueueFilter === "running") {
        visible = jobs.filter(
          (job) => job.status === "running" || job.status === "paused"
        );
      } else if (dlQueueFilter === "done") {
        visible = jobs.filter((job) => job.status === "done");
      } else if (dlQueueFilter === "error") {
        visible = jobs.filter(
          (job) => job.status === "error" || job.status === "cancelled"
        );
      }
      const indexOf = new Map(jobs.map((job, index) => [job.id, index + 1]));
      const prevScroll = dlQueueList.scrollTop;
      dlQueueList.innerHTML = visible.length
        ? visible.map((job) => {
          const status = job.status || "running";
          const percent = Math.min(100, Math.max(0, Math.round(job.percent || 0)));
          const number = indexOf.get(job.id) || 1;
          const icon =
            status === "done" ? "✓" :
              status === "error" || status === "cancelled" ? "!" :
                status === "paused" ? "❚❚" : "↓";
          const phase = jobPhaseLabel(job);
          const percentLabel =
            status === "done" ? "완료" :
              status === "error" ? "실패" :
                status === "cancelled" ? "취소" :
                  status === "paused" ? "정지" : `${percent}%`;
          const info = jobDisplayInfo(job);
          const message =
            status === "error" || status === "cancelled"
              ? cleanJobMessage(job.error || job.message || "실패", "error")
              : status === "paused" ? "일시정지됨" :
                cleanJobMessage(job.message, job.phase);
          const errorMeta =
            status === "error" ? UVD.classifyError(job.error || job.message || "") : null;
          let actionsHtml = "";
          if (status === "running") {
            actionsHtml = `<div class="dl-job-actions">
          <button type="button" class="btn" data-act="pause" data-job="${escapeAttr(job.id)}">일시정지</button>
          <button type="button" class="btn danger" data-act="cancel" data-job="${escapeAttr(job.id)}">취소</button>
        </div>`;
          } else if (status === "paused") {
            actionsHtml = `<div class="dl-job-actions">
          <button type="button" class="btn" data-act="resume" data-job="${escapeAttr(job.id)}">이어받기</button>
          <button type="button" class="btn danger" data-act="cancel" data-job="${escapeAttr(job.id)}">취소</button>
        </div>`;
          } else if (status === "error") {
            actionsHtml =
              deps.recoveryActionsHtml(errorMeta, job.pageUrl, job) +
              `<div class="dl-job-actions">
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(job.id)}">닫기</button>
              </div>`;
          } else if (status === "cancelled") {
            actionsHtml = `<div class="dl-job-actions">
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(job.id)}">닫기</button>
              </div>`;
          } else if (status === "done") {
            actionsHtml = `<div class="dl-job-actions">
                <button type="button" class="btn" data-act="show" data-path="${escapeAttr(job.result?.path || "")}" data-did="${escapeAttr(job.result?.downloadId ?? "")}">폴더</button>
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(job.id)}">닫기</button>
              </div>`;
          }
          const errorLine =
            status === "error" && errorMeta
              ? `<div class="dl-job-err-box"><div class="dl-job-err"><strong>${escapeHtml(errorMeta.label)}</strong> — ${escapeHtml(errorMeta.hint)}</div></div>`
              : "";
          const eta = jobEtaLabel(job);
          const speed =
            status === "running" && (job.speedLabel || job.speedBps)
              ? job.speedLabel || UVD.formatSpeed(job.speedBps) : "";
          const metaBits = [info.site, info.quality, phase, speed, eta].filter(Boolean);
          const metaLine = metaBits.length
            ? `<div class="dl-job-meta-line" data-bits="${escapeAttr(metaBits.join("|"))}">${metaBits.map((text) => `<span class="dl-job-chip">${escapeHtml(text)}</span>`).join("")}</div>`
            : "";
          const fileHtml = info.fileLabel
            ? `<div class="dl-job-file" title="${escapeAttr(info.fileLabel)}">📄 ${escapeHtml(info.fileLabel)}</div>`
            : "";
          const tip = [info.title, info.fileLabel, job.pageUrl].filter(Boolean).join("\n");
          const titleShort =
            info.title.length > 52 ? info.title.slice(0, 50) + "…" : info.title;
          return `
        <div class="dl-job ${status === "done" ? "is-done" : ""} ${
            status === "error" || status === "cancelled" ? "is-error is-sticky" : ""
          } ${status === "running" ? "is-running" : ""} ${
            status === "paused" ? "is-paused" : ""
          }" data-job-id="${escapeAttr(job.id)}" data-status="${escapeAttr(status)}">
          <div class="dl-job-top">
            <span class="dl-job-num" title="큐 순서">#${number}</span>
            <span class="dl-job-status ${escapeAttr(status)}" aria-hidden="true">${icon}</span>
            <div class="dl-job-meta">
              <div class="dl-job-title" title="${escapeAttr(tip)}">${escapeHtml(titleShort)}</div>
              ${fileHtml}
              ${metaLine}
              <div class="dl-job-msg">${escapeHtml(message)}</div>
              ${errorLine}
            </div>
            <div class="dl-job-right">
              <span class="dl-job-pct">${escapeHtml(percentLabel)}</span>
              ${status === "running" ? `<span class="dl-job-phase">${escapeHtml(phase)}</span>` : ""}
            </div>
          </div>
          <div class="dl-job-bar">
            <div class="dl-job-fill" style="width:${
              status === "error" || status === "cancelled" ? 100 : percent
            }%"></div>
          </div>
          ${actionsHtml}
        </div>`;
        }).join("")
        : `<div class="dl-queue-empty">이 필터에 항목이 없습니다</div>`;
      dlQueueList.scrollTop = prevScroll;
      $("#dlQueueFilters")?.querySelectorAll(".dl-qf").forEach((button) => {
        button.onclick = () => {
          dlQueueFilter = button.getAttribute("data-qf") || "all";
          renderDownloadQueue(true);
        };
      });
      deps.bindRecoveryButtons(dlQueueList);
      syncDownloadingFlag();
      if (deps.getPlaylistDl().jobIds.size) deps.updatePlaylistProgressUi();
    }

    function showProgress(show, percent = 0, text = "") {
      if (dlQueueEl && uiJobs.size > 0) {
        if (progressEl) progressEl.classList.add("hidden");
        return;
      }
      if (!progressEl) return;
      if (!show) {
        progressEl.classList.add("hidden");
        return;
      }
      progressEl.classList.remove("hidden");
      if (progressFill) {
        progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      }
      if (progressText) progressText.textContent = text || `받는 중… ${percent}%`;
    }

    function applyJobProgress(jobOrProgress, opts = {}) {
      if (!jobOrProgress) return;
      const progress = jobOrProgress;
      const jobId = progress.id || progress.jobId;
      if (!jobId) {
        const running = [...uiJobs.values()].filter((job) => job.status === "running");
        if (running.length > 1) return;
        if (running.length === 1) {
          const prev = running[0];
          if (prev.status === "paused" || prev.status === "cancelled") return;
          const raw =
            typeof progress.percent === "number" ? progress.percent : prev.percent || 0;
          const percent =
            prev.status === "running" ? Math.max(prev.percent || 0, raw) : raw;
          upsertUiJob({
            ...prev,
            percent,
            message: progress.message || prev.message,
            phase: progress.phase || prev.phase,
            status:
              progress.phase === "done" ? "done" :
                progress.phase === "error" ? "error" : "running"
          }, opts);
        } else {
          showProgress(true, progress.percent || 10, progress.message || "받는 중…");
        }
        return;
      }
      const prev = uiJobs.get(jobId);
      if (prev && !UVDQueueState.shouldAccept(prev, progress)) return;
      if (prev && UVDQueueState.shouldIgnoreAmbient(prev, progress)) return;
      const raw =
        typeof progress.percent === "number" ? progress.percent : prev?.percent || 0;
      const nextStatus = UVDQueueState.statusOf(progress, prev);
      const percent = prev
        ? UVDQueueState.percentFor(prev, progress, nextStatus)
        : raw;
      upsertUiJob({
        id: jobId,
        title: progress.title,
        percent,
        message: progress.message || progress.error,
        phase: progress.phase,
        status: nextStatus,
        error: progress.error,
        result: progress.result,
        path: progress.path,
        filename: progress.filename,
        quality: progress.quality,
        pageUrl: progress.pageUrl,
        startedAt: progress.startedAt,
        updatedAt: progress.updatedAt || now(),
        progressVersion: progress.progressVersion,
        progressAttempt: progress.progressAttempt,
        progressSeq: progress.progressSeq,
        _silentDone: progress._silentDone
      }, opts);
    }

    async function restoreActiveDownloads() {
      try {
        const res = await deps.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
        const jobs = res?.jobs || [];
        for (const job of jobs) {
          if (job?.id) {
            trackedJobIds.add(job.id);
            upsertUiJob(job, { toast: false });
          }
        }
        const running = jobs.filter((job) => job.status === "running");
        if (running.length) {
          restoredBackgroundJob = true;
          ensureQueuePoll();
          if (running.length > 1) {
            toast(`동시 다운로드 ${running.length}개 진행 중`, "ok");
          } else {
            toast("백그라운드에서 받는 중 — 추가로 더 받을 수 있어요", "ok");
          }
          return true;
        }
        if (jobs.length && !restoredBackgroundJob) {
          restoredBackgroundJob = true;
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    }

    return {
      runningJobCount,
      canStartAnotherDownload,
      syncDownloadingFlag,
      ensureQueuePoll,
      refreshJobsFromBackground,
      scheduleQueuePatch,
      scheduleQueueFullRender,
      upsertUiJob,
      sortedUiJobs,
      updateQueueHeader,
      patchQueueProgress,
      renderDownloadQueue,
      showProgress,
      applyJobProgress,
      restoreActiveDownloads,
      jobDisplayInfo,
      shortJobTitle,
      jobEtaLabel,
      jobPhaseLabel,
      cleanJobMessage
    };
  }

  return { createController };
});
