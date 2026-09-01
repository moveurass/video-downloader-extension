(function initPopupRecoveryUi(root, factory) {
  const api = factory();
  root.UVDPopupRecoveryUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeRecoveryUi() {
  "use strict";

  function recoveryActionsHtml(errorMeta, pageUrl, job, escapeAttr) {
    const actions = errorMeta?.actions || ["retry"];
    const url = pageUrl || job?.pageUrl || "";
    const buttons = [];
    const addUrlAction = (action, label) => {
      if (actions.includes(action) && url) {
        buttons.push(
          `<button type="button" class="btn" data-act="${
            action === "open_page" ? "open" : action
          }" data-url="${escapeAttr(url)}">${label}</button>`
        );
      }
    };
    addUrlAction("play_retry", "재생 후 재시도");
    addUrlAction("retry", "다시 받기");
    addUrlAction("open_page", "페이지 열기");
    addUrlAction("login", "로그인");
    if (actions.includes("helper_start")) {
      buttons.push('<button type="button" class="btn" data-act="helper_start">도우미 실행</button>');
    }
    if (actions.includes("helper")) {
      buttons.push('<button type="button" class="btn" data-act="helper">안내</button>');
    }
    if (actions.includes("resume") && job?.id) {
      buttons.push(
        `<button type="button" class="btn" data-act="resume" data-job="${escapeAttr(job.id)}">다시 시작</button>`
      );
    }
    return buttons.length ? `<div class="dl-job-actions">${buttons.join("")}</div>` : "";
  }

  function resolveRealJobId(jobId, jobs) {
    if (!jobId) return "";
    if (!String(jobId).startsWith("local_")) return jobId;
    const local = jobs.get(jobId);
    for (const [id, job] of jobs) {
      if (String(id).startsWith("local_")) continue;
      if (job.status !== "running" && job.status !== "paused") continue;
      if (
        local &&
        ((local.pageUrl && job.pageUrl && local.pageUrl === job.pageUrl) ||
          (local.title && job.title && local.title === job.title))
      ) {
        return id;
      }
    }
    const running = [...jobs.entries()].filter(
      ([id, job]) =>
        !String(id).startsWith("local_") &&
        (job.status === "running" || job.status === "paused")
    );
    return running.length === 1 ? running[0][0] : jobId;
  }

  function createController(deps) {
    async function showHelperHelp() {
      deps.toast(
        "① 「실행 파일」저장 후 더블클릭  ② 또는 helper/start_background.command",
        "error"
      );
      deps.sendMessage({
        type: "OPEN_URL",
        url: "https://github.com/moveurass/video-downloader-extension#helper"
      }).catch(() => {});
    }

    async function downloadHelperStarter() {
      try {
        const response = await deps.sendMessage({ type: "DOWNLOAD_HELPER_STARTER" });
        if (response?.ok) {
          deps.toast(
            response.hint || "다운로드에 UVD-도우미-시작.command 저장됨 · 더블클릭 실행",
            "ok"
          );
          deps.startHelperPoll();
          setTimeout(() => deps.refreshHelperStatus(true), 2000);
          setTimeout(() => deps.refreshHelperStatus(true), 5000);
        } else {
          deps.toast(response?.error || "실행 파일 저장 실패", "error");
          showHelperHelp();
        }
      } catch (error) {
        deps.toast(deps.userError(error?.message) || "실행 파일 저장 실패", "error");
        showHelperHelp();
      }
    }

    async function handleAction(action, { url, path, downloadId, jobId, button }) {
      if (action === "dismiss") {
        const id = button?.getAttribute("data-job") || jobId || "";
        if (id) {
          deps.jobs.delete(id);
          deps.renderDownloadQueue(true);
        }
      } else if (action === "play_retry" && url) {
        await deps.sendMessage({ type: "OPEN_URL", url });
        deps.toast("페이지에서 재생을 시작한 뒤 다시 받기를 누르세요", "ok");
      } else if (action === "retry" && url) {
        await deps.downloadByPastedLink(url, { skipDupCheck: true });
      } else if (action === "open" && url) {
        await deps.sendMessage({ type: "OPEN_URL", url });
      } else if (action === "login" && url) {
        let loginUrl = url;
        try {
          loginUrl = new URL(url).origin + "/";
        } catch {
          // Keep the original URL.
        }
        await deps.sendMessage({ type: "OPEN_URL", url: loginUrl });
        deps.toast("로그인 후 다시 받아 주세요", "ok");
      } else if (action === "helper_start") {
        await downloadHelperStarter();
      } else if (action === "helper") {
        await showHelperHelp();
      } else if (action === "show") {
        await deps.sendMessage({
          type: "SHOW_DOWNLOAD",
          downloadId: downloadId ? Number(downloadId) : null,
          path
        });
      }
    }

    function bindRecoveryButtons(root) {
      if (!root || root.dataset.actBound === "1") return;
      root.dataset.actBound = "1";
      root.addEventListener("click", async (event) => {
        const button = event.target?.closest?.("[data-act]");
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.getAttribute("data-act");
        const url = button.getAttribute("data-url") || "";
        const path = button.getAttribute("data-path") || "";
        const downloadId = button.getAttribute("data-did");
        const rawJobId = button.getAttribute("data-job") || "";
        const jobId = resolveRealJobId(rawJobId, deps.jobs);
        try {
          if (action === "cancel" && jobId) {
            button.disabled = true;
            const job = deps.jobs.get(jobId) || deps.jobs.get(rawJobId);
            if (job) {
              deps.upsertUiJob({
                ...job,
                id: jobId,
                status: "cancelled",
                message: "취소됨",
                phase: "cancelled",
                percent: job.percent || 0
              }, { toast: false, forceStructure: true, local: true });
            }
            const response = await deps.sendMessage({ type: "CANCEL_DOWNLOAD", jobId });
            if (response?.ok === false) {
              deps.toast(response.error || "취소 실패", "error");
              button.disabled = false;
              await deps.refreshJobsFromBackground();
              return;
            }
            deps.toast("취소했습니다", "ok");
            setTimeout(() => deps.refreshJobsFromBackground(), 400);
            return;
          }
          if (action === "pause" && jobId) {
            button.disabled = true;
            const job = deps.jobs.get(jobId) || deps.jobs.get(rawJobId);
            if (job) {
              deps.upsertUiJob({
                ...job,
                id: jobId,
                status: "paused",
                message: "일시정지됨 · 다시 시작 가능",
                phase: "paused"
              }, { toast: false, forceStructure: true, local: true });
            }
            const response = await deps.sendMessage({ type: "PAUSE_DOWNLOAD", jobId });
            if (response?.ok === false) {
              deps.toast(response.error || "일시정지 실패", "error");
              button.disabled = false;
              await deps.refreshJobsFromBackground();
              return;
            }
            deps.toast("일시정지했습니다", "ok");
            setTimeout(() => deps.refreshJobsFromBackground(), 400);
            return;
          }
          if (action === "resume" && jobId) {
            button.disabled = true;
            const response = await deps.sendMessage({ type: "RESUME_DOWNLOAD", jobId });
            if (response?.ok === false) {
              deps.toast(response.error || "다시 시작 실패", "error");
              button.disabled = false;
              return;
            }
            deps.toast("다시 시작합니다", "ok");
            deps.ensureQueuePoll();
            await deps.refreshJobsFromBackground();
            return;
          }
          await handleAction(action, {
            url,
            path,
            downloadId,
            jobId,
            button
          });
        } catch (error) {
          button.disabled = false;
          deps.toast(String(error?.message || error || "실패"), "error");
        }
      });
    }

    return { bindRecoveryButtons, downloadHelperStarter, showHelperHelp, handleAction };
  }

  return { recoveryActionsHtml, resolveRealJobId, createController };
});
