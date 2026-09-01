/**
 * Client for local yt-dlp helper (http://127.0.0.1:8787)
 * Used for YouTube, TikTok, and other hard sites.
 * Loaded in service worker via importScripts.
 */
const YtDlp = (() => {
  const BASE = "http://127.0.0.1:8787";
  let cachedHealth = null;
  let cachedAt = 0;
  let pairingPromise = null;

  // Optional shared secret — set the same value in extension settings
  // (storage key "helperToken") and helper env UVD_TOKEN.
  let cachedToken = null;
  let tokenLoaded = false;
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes.helperToken) {
        cachedToken = (changes.helperToken.newValue || "").trim() || null;
        tokenLoaded = true;
      }
    });
  } catch {
    /* ignore */
  }

  async function authHeaders() {
    if (!tokenLoaded) {
      try {
        const st = await chrome.storage.local.get("helperToken");
        cachedToken = String(st.helperToken || "").trim() || null;
      } catch {
        cachedToken = null;
      }
      tokenLoaded = true;
    }
    return cachedToken ? { "X-UVD-Token": cachedToken } : {};
  }

  function generatePairToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function pairIfAvailable(healthData) {
    await authHeaders();
    if (cachedToken || healthData?.pairingMode !== "available") {
      return healthData;
    }
    if (pairingPromise) {
      const paired = await pairingPromise;
      return { ...healthData, ...paired };
    }
    pairingPromise = (async () => {
      const token = generatePairToken();
      try {
        const response = await fetch(`${BASE}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          return { pairingError: data.error || "pairing failed" };
        }
        await chrome.storage.local.set({ helperToken: token });
        cachedToken = token;
        tokenLoaded = true;
        return { pairingMode: "paired", pairedNow: true };
      } catch (error) {
        return {
          pairingError: String(error?.message || error || "pairing failed")
        };
      }
    })();
    try {
      return { ...healthData, ...(await pairingPromise) };
    } finally {
      pairingPromise = null;
    }
  }

  async function health(force = false) {
    const now = Date.now();
    if (!force && cachedHealth && now - cachedAt < 4000) return cachedHealth;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error("bad status");
      cachedHealth = await pairIfAvailable(await res.json());
      if (cachedHealth?.pairingMode === "paired" && !cachedToken) {
        cachedHealth = {
          ...cachedHealth,
          authRequired: true,
          pairingError:
            cachedHealth.pairingError ||
            "도우미가 다른 확장 설치와 연결되어 있습니다"
        };
      }
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
    return !!(h && h.ok && h.ytdlp && !h.authRequired);
  }

  async function startDownload(payload) {
    const res = await fetch(`${BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
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
    const res = await fetch(`${BASE}/job/${jobId}`, {
      headers: await authHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "job not found");
    return data.job;
  }

  /** Cancel a running helper download (kills yt-dlp process). */
  async function cancelJob(jobId) {
    if (!jobId) return { ok: false };
    try {
      const res = await fetch(`${BASE}/job/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: "{}"
      });
      const data = await res.json().catch(() => ({}));
      return { ok: !!(res.ok && data.ok), ...data };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /**
   * List available quality labels for a page/media URL (yt-dlp -J).
   * @returns {Promise<{qualities: Array<{id:string,label:string,height?:number}>, heights: number[]}>}
   */
  async function listFormats(url, extra = {}) {
    const res = await fetch(`${BASE}/formats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ url, pageUrl: url, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `formats HTTP ${res.status}`);
    }
    return data;
  }

  /**
   * List playlist entries (flat, no download).
   * @returns {Promise<{title:string, count:number, entries:Array<{id,title,url,duration}>}>}
   */
  async function listPlaylist(url, extra = {}) {
    const res = await fetch(`${BASE}/playlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ url, pageUrl: url, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `playlist HTTP ${res.status}`);
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
      if (job.status === "cancelled" || job.cancel) {
        throw new Error("CANCELLED");
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
    cancelJob,
    downloadAndWait,
    listFormats,
    listPlaylist
  };
})();
