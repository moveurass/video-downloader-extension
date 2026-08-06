/**
 * Client for local yt-dlp helper (http://127.0.0.1:8787)
 * Used for YouTube, TikTok, and other hard sites.
 * Loaded in service worker via importScripts.
 */
const YtDlp = (() => {
  const BASE = "http://127.0.0.1:8787";
  let cachedHealth = null;
  let cachedAt = 0;

  async function health(force = false) {
    const now = Date.now();
    if (!force && cachedHealth && now - cachedAt < 4000) return cachedHealth;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error("bad status");
      cachedHealth = await res.json();
      cachedAt = now;
      return cachedHealth;
    } catch {
      cachedHealth = { ok: false, ytdlp: false };
      cachedAt = now;
      return cachedHealth;
    }
  }

  async function available() {
    const h = await health();
    return !!(h && h.ok && h.ytdlp);
  }

  async function startDownload(payload) {
    const res = await fetch(`${BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(
        data.error ||
          data.hint ||
          (res.status === 0
            ? "도우미에 연결할 수 없습니다. helper/start.command 를 실행해 주세요"
            : `도우미 HTTP ${res.status}`)
      );
    }
    return data;
  }

  async function getJob(jobId) {
    const res = await fetch(`${BASE}/job/${jobId}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "job not found");
    return data.job;
  }

  /**
   * List available quality labels for a page/media URL (yt-dlp -J).
   * @returns {Promise<{qualities: Array<{id:string,label:string,height?:number}>, heights: number[]}>}
   */
  async function listFormats(url, extra = {}) {
    const res = await fetch(`${BASE}/formats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, pageUrl: url, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `formats HTTP ${res.status}`);
    }
    return data;
  }

  /**
   * Start download and poll until done/error.
   * onProgress({ percent, message, status })
   */
  async function downloadAndWait(payload, onProgress, timeoutMs = 40 * 60 * 1000) {
    const started = await startDownload(payload);
    const jobId = started.jobId;
    const t0 = Date.now();
    onProgress?.({
      percent: 3,
      message: "다운로드 시작…",
      status: "running",
      outDir: started.outDir
    });

    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
      let job;
      try {
        job = await getJob(jobId);
      } catch {
        continue;
      }
      const pct = typeof job.percent === "number" ? job.percent : 0;
      // Pass helper job id for debugging; percent already monotonic on server
      onProgress?.({
        percent: pct,
        message: job.message || job.status,
        status: job.status,
        outDir: job.outDir || started.outDir,
        path: job.path,
        helperJobId: jobId
      });
      if (job.status === "done") {
        return {
          ok: true,
          jobId,
          outDir: job.outDir || started.outDir,
          path: job.path || job.outDir || started.outDir,
          size: job.size || 0,
          filename: job.filename || payload.filename,
          method: "yt-dlp"
        };
      }
      if (job.status === "error") {
        throw new Error(job.error || job.message || "다운로드 실패");
      }
    }
    throw new Error("다운로드 시간 초과");
  }

  return {
    BASE,
    health,
    available,
    startDownload,
    getJob,
    downloadAndWait,
    listFormats
  };
})();
