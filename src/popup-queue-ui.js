(function initPopupQueueUi(root, factory) {
  const api = factory();
  root.UVDPopupQueueUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeQueueUi() {
  "use strict";

  function createPresenter(deps = {}) {
    const etaSmoothMap = new Map();
    const now = deps.now || Date.now;

    function jobDisplayInfo(job) {
      const pathName = (path) => {
        if (!path) return "";
        return (String(path).split(/[/\\]/).pop() || "")
          .replace(/\.(mp4|webm|mkv|mp3|m4a|ts)$/i, "")
          .trim();
      };
      const file =
        pathName(job?.result?.filename) ||
        pathName(job?.result?.path) ||
        pathName(job?.filename) ||
        pathName(job?.path);
      let title = "";
      for (const candidate of [job?.title, job?.pageTitle, job?.displayName, file]) {
        const cleaned = deps.cleanTitleText(candidate);
        if (
          cleaned &&
          !deps.isUglyName(cleaned) &&
          !deps.UVD?.isGenericSaveName?.(cleaned) &&
          cleaned.length > title.length
        ) {
          title = cleaned;
        }
      }
      if (!title && file && !deps.UVD?.isGenericSaveName?.(file)) title = file;
      if (!title && job?.pageUrl) {
        const site = deps.siteLabel(job.pageUrl, job);
        try {
          const host = new URL(job.pageUrl).hostname.replace(/^www\./, "");
          title = site ? `${site} 영상` : host;
        } catch {
          title = site || "영상";
        }
      }
      if (!title) title = "영상";
      let fileLabel = "";
      if (file && file !== title && !title.includes(file.slice(0, 20))) {
        fileLabel = file.length > 48 ? `${file.slice(0, 46)}…` : file;
        const extension = (job?.result?.filename || job?.filename || "")
          .match(/\.(mp4|webm|mkv|mp3|m4a)$/i)?.[0] || "";
        if (extension && !fileLabel.endsWith(extension)) fileLabel += extension;
      } else if (file && file === title) {
        const extension = (job?.result?.filename || job?.filename || "")
          .match(/\.(mp4|webm|mkv|mp3|m4a)$/i)?.[0] || ".mp4";
        fileLabel = `${file.length > 40 ? `${file.slice(0, 38)}…` : file}${
          file.endsWith(extension) ? "" : extension
        }`;
      }
      const quality = job?.quality && !/^(best|all|unknown)$/i.test(String(job.quality))
        ? String(job.quality)
        : "";
      return {
        title,
        fileLabel,
        quality,
        site: deps.siteLabel(job?.pageUrl, job) || ""
      };
    }

    function shortJobTitle(job) {
      const title = jobDisplayInfo(job).title;
      return title.length > 48 ? `${title.slice(0, 46)}…` : title;
    }

    function jobEtaLabel(job) {
      if (!job || job.status !== "running") {
        if (job?.id) etaSmoothMap.delete(job.id);
        return "";
      }
      const percent = Number(job.percent) || 0;
      const started = Number(job.startedAt) || 0;
      if (percent < 3 || !started) return "";
      const current = now();
      const elapsed = current - started;
      if (elapsed < 4000) return "";
      const raw = Math.max(0, elapsed / (percent / 100) - elapsed);
      if (!Number.isFinite(raw) || raw > 6 * 60 * 60 * 1000) {
        etaSmoothMap.delete(job.id);
        return "";
      }
      const previous = etaSmoothMap.get(job.id);
      let remain = raw;
      if (previous && current - previous.at < 15000) {
        const aged = Math.max(0, previous.remain - (current - previous.at));
        remain = aged * 0.65 + raw * 0.35;
      }
      etaSmoothMap.set(job.id, { remain, at: current });
      const seconds = Math.round(remain / 1000);
      if (seconds < 60) return `약 ${Math.max(5, Math.round(seconds / 5) * 5)}초`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `약 ${minutes}분`;
      const hours = Math.floor(minutes / 60);
      return `약 ${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
    }

    function jobPhaseLabel(job) {
      const status = job?.status || "running";
      if (status === "done") return "완료";
      if (status === "error") return "실패";
      if (status === "cancelled") return "취소";
      if (status === "paused") return "일시정지";
      const phase = String(job?.phase || "");
      const message = String(job?.message || "");
      if (phase === "merge" || /만들|합치|Merg/i.test(message)) return "합치는 중";
      if (phase === "save" || /^저장/i.test(message)) return "저장 중";
      if (/시작|준비|해석|목록/i.test(message)) return "준비 중";
      return "받는 중";
    }

    function cleanJobMessage(message, phase) {
      const text = String(message || "").trim();
      if (phase === "error" || /ERROR|실패|error/i.test(text)) {
        const clean = text.replace(/^Error:\s*/i, "").trim();
        return clean.length > 56 ? `${clean.slice(0, 54)}…` : clean || "실패";
      }
      if (phase === "save" || /디스크|쓰는 중|저장 중|Destination|Merging into/i.test(text)) {
        if (/디스크|쓰는 중|MB|약 \d/.test(text)) {
          return text.length > 52 ? `${text.slice(0, 50)}…` : text;
        }
        const destination = text.match(
          /(?:Destination|Merging into|to:\s*)(.+\.(?:mp4|mkv|webm|mp3))/i
        );
        if (destination) {
          const name = destination[1].split(/[/\\]/).pop();
          return `저장 중 · ${name.length > 28 ? `${name.slice(0, 26)}…` : name}`;
        }
        return "디스크에 저장 중…";
      }
      if (phase === "merge" || /만들|합치|Merg|ffmpeg/i.test(text)) {
        if (/\d+\s*\/\s*\d+/.test(text) || /MB|KB|GB/.test(text)) {
          return text.length > 48 ? `${text.slice(0, 46)}…` : text;
        }
        return "파일 만드는 중…";
      }
      if (
        /받는 중…\s*[\d.]+(KB|MB|GB)/i.test(text) ||
        /[\d.]+\s*(KB|MB|GB)\s*\/\s*약/i.test(text) ||
        /추가 트랙/.test(text)
      ) {
        return text.length > 48 ? `${text.slice(0, 46)}…` : text;
      }
      if (
        !text ||
        /조각|세그먼트|\[download\]|ETA|at\s+\d|% of|MiB|KiB/i.test(text) ||
        /받는 중|다운로드/i.test(text)
      ) {
        if (/받는 중…\s*\d/.test(text) || /전체 \d/.test(text) || /(KB|MB|GB)/i.test(text)) {
          return text.length > 48 ? `${text.slice(0, 46)}…` : text;
        }
        return "받는 중…";
      }
      if (/시작|준비|해석|목록|쿠키|연결/i.test(text)) return "준비 중…";
      return text.length > 40 ? "받는 중…" : text;
    }

    return { jobDisplayInfo, shortJobTitle, jobEtaLabel, jobPhaseLabel, cleanJobMessage };
  }

  return { createPresenter };
});
