/**
 * Client for local yt-dlp helper (http://127.0.0.1:8787)
 * Loaded in service worker via importScripts.
 */
const YtDlp = (() => {
  const BASE = "http://127.0.0.1:8787";
  let cachedHealth = null;
  let cachedAt = 0;

  async function health(force = false) {
    const now = Date.now();
    if (!force && cachedHealth && now - cachedAt < 5000) return cachedHealth;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 900);
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
      throw new Error(data.error || data.hint || `yt-dlp helper HTTP ${res.status}`);
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
   * Start download and poll until done/error.
   * onProgress({ percent, message, status })
   */
  async function downloadAndWait(payload, onProgress, timeoutMs = 30 * 60 * 1000) {
    const started = await startDownload(payload);
    const jobId = started.jobId;
    const t0 = Date.now();
    onProgress?.({
      percent: 3,
      message: "yt-dlp 시작…",
      status: "running",
      outDir: started.outDir
    });

    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 700));
      let job;
      try {
        job = await getJob(jobId);
      } catch {
        continue;
      }
      onProgress?.({
        percent: job.percent ?? 0,
        message: job.message || job.status,
        status: job.status,
        outDir: job.outDir || started.outDir
      });
      if (job.status === "done") {
        return {
          ok: true,
          jobId,
          outDir: job.outDir || started.outDir,
          method: "yt-dlp",
          filename: payload.filename
        };
      }
      if (job.status === "error") {
        throw new Error(job.error || job.message || "yt-dlp 실패");
      }
    }
    throw new Error("yt-dlp 시간 초과");
  }

  return {
    BASE,
    health,
    available,
    startDownload,
    getJob,
    downloadAndWait
  };
})();
