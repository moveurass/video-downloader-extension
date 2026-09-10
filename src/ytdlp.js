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

  /** When the current token was last accepted by a protected endpoint. */
  let tokenVerifiedAt = 0;
  const TOKEN_VERIFY_TTL = 60_000;

  /**
   * Pair (or re-pair) with a fresh token. The helper accepts this when it is
   * unpaired or when the request comes from the same extension origin, which
   * is how a reinstalled extension or a wiped helper cache recovers.
   */
  function requestPairing() {
    if (pairingPromise) return pairingPromise;
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
        tokenVerifiedAt = Date.now();
        return { pairingMode: "paired", pairedNow: true };
      } catch (error) {
        return {
          pairingError: String(error?.message || error || "pairing failed")
        };
      }
    })();
    return pairingPromise.finally(() => {
      pairingPromise = null;
    });
  }

  /** /health is public; hit a protected route to learn whether our token still works. */
  async function tokenAccepted() {
    if (!cachedToken) return false;
    if (Date.now() - tokenVerifiedAt < TOKEN_VERIFY_TTL) return true;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${BASE}/job/__uvd_token_probe__`, {
        headers: await authHeaders(),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (res.status === 403) return false;
      tokenVerifiedAt = Date.now();
      return true;
    } catch {
      // Unreachable helper is not a token problem; keep the current token.
      return true;
    }
  }

  async function pairIfAvailable(healthData) {
    await authHeaders();
    if (healthData?.pairingMode === "manual") return healthData;
    if (healthData?.pairingMode === "available") {
      // Helper has no pairing (fresh install or wiped cache): any token we
      // still hold is stale, so pair again instead of keeping it.
      return { ...healthData, ...(await requestPairing()) };
    }
    if (healthData?.pairingMode === "paired") {
      if (await tokenAccepted()) return healthData;
      // No token (extension reinstalled) or a rejected one (helper re-paired
      // by the same origin elsewhere): try a same-origin re-pair once.
      const repaired = await requestPairing();
      if (repaired.pairingMode === "paired") return { ...healthData, ...repaired };
      return {
        ...healthData,
        authRequired: true,
        pairingError:
          /already paired/i.test(String(repaired.pairingError || ""))
            ? "도우미가 다른 확장 설치와 연결되어 있습니다. ~/.cache/uvd-helper/pairing.json 을 지우고 도우미를 재시작해 주세요"
            : repaired.pairingError || "도우미 인증에 실패했습니다"
      };
    }
    return healthData;
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

  async function startDownload(payload, retried = false) {
    const res = await fetch(`${BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    if (res.status === 403 && !retried) {
      // Token rejected (helper re-paired / cache wiped): re-pair once and retry.
      tokenVerifiedAt = 0;
      const repaired = await requestPairing();
      if (repaired.pairingMode === "paired") return startDownload(payload, true);
    }
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
    if (!res.ok || !data.ok) {
      const error = new Error(data.error || "job not found");
      error.status = res.status;
      throw error;
    }
    return data.job;
  }

  /**
   * Stop a running helper download (kills yt-dlp and its children).
   * `pause` keeps the work directory and reports PAUSED. `purge` is reserved
   * for an explicit user cancellation that must delete partial files.
   */
  async function cancelJob(jobId, options = {}) {
    if (!jobId) return { ok: false };
    try {
      const body = options.pause
        ? { pause: true }
        : options.purge
          ? { purge: true }
          : {};
      const res = await fetch(`${BASE}/job/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify(body)
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
      const error = new Error(data.error || `formats HTTP ${res.status}`);
      if (data.unsupported === true) error.unsupported = true;
      throw error;
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
   * A helper restart wipes its in-memory job table and a dead helper drops
   * every poll. Wait briefly for the helper to come back, then re-post the
   * same payload: resumeKey + outputStem pin the work directory, so the
   * helper's yt-dlp --continue picks up the partial file. Returns the new
   * { jobId, outDir } or null when resuming is impossible.
   */
  const HELPER_RECOVERY_LIMIT = 2;
  const HELPER_RECOVERY_POLLS = 60; // 60 × 1s ≈ launchd restart budget

  async function recoverHelperDownload(payload, onProgress, options = {}) {
    const { attemptsUsed = 0, lastPercent = 3, outDir = "" } = options;
    if (attemptsUsed >= HELPER_RECOVERY_LIMIT) return null;
    if (!String(payload?.resumeKey || "").trim()) return null;
    const percent = Math.min(98, Math.max(3, Number(lastPercent) || 3));
    onProgress?.({
      percent,
      message: "도우미 재시작 감지 — 재연결 대기 중…",
      status: "download",
      outDir
    });
    let healthy = null;
    for (let poll = 0; poll < HELPER_RECOVERY_POLLS; poll += 1) {
      const h = await health(true);
      if (h?.ok && h?.ytdlp && !h?.authRequired) {
        healthy = h;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) return null;
    const restarted = await startDownload(payload);
    onProgress?.({
      percent,
      message: "도우미 재시작 — 이어받는 중…",
      status: "running",
      outDir: restarted.outDir || outDir,
      helperJobId: restarted.jobId
    });
    return restarted;
  }

  /**
   * Start download and poll until done/error.
   * onProgress({ percent, message, status })
   */
  async function downloadAndWait(payload, onProgress, timeoutMs = 40 * 60 * 1000) {
    const started = await startDownload(payload);
    let jobId = started.jobId;
    const t0 = Date.now();
    onProgress?.({
      percent: 3,
      message: "다운로드 시작…",
      status: "running",
      outDir: started.outDir,
      helperJobId: jobId
    });

    // A helper restart wipes its in-memory job table (404), and a dead helper
    // fails every poll; neither must spin silently until the 40-minute timeout.
    let missing = 0;
    let unreachable = 0;
    let recoveries = 0;
    let lastPct = 3;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
      let job;
      try {
        job = await getJob(jobId);
        missing = 0;
        unreachable = 0;
      } catch (error) {
        if (error?.status === 404) missing += 1;
        else unreachable += 1;
        if (missing >= 6 || unreachable >= 40) {
          const restarted = await recoverHelperDownload(payload, onProgress, {
            attemptsUsed: recoveries,
            lastPercent: lastPct,
            outDir: started.outDir
          });
          if (!restarted) {
            throw new Error(
              missing >= 6
                ? "도우미가 재시작되어 진행 중인 작업을 잃었습니다. 다시 시작해 주세요"
                : "도우미와 연결이 끊겼습니다. helper/start.command 를 실행해 주세요"
            );
          }
          recoveries += 1;
          jobId = restarted.jobId;
          missing = 0;
          unreachable = 0;
        }
        continue;
      }
      const pct = typeof job.percent === "number" ? job.percent : 0;
      lastPct = pct;
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
          writeThumbnail:
            job.writeThumbnail === true || payload.writeThumbnail === true,
          thumbnailPath: job.thumbnailPath || "",
          method: "yt-dlp"
        };
      }
      if (job.status === "paused" || job.pause) {
        const error = new Error("PAUSED");
        error.code = "PAUSED";
        throw error;
      }
      if (job.status === "cancelled" || job.cancel) {
        const error = new Error("CANCELLED");
        error.code = "CANCELLED";
        throw error;
      }
      if (job.status === "error") {
        throw new Error(job.error || job.message || "다운로드 실패");
      }
    }
    // Do not leave yt-dlp running untracked after the UI gives up.
    await cancelJob(jobId).catch(() => {});
    throw new Error("다운로드 시간 초과");
  }

  /**
   * Ask the helper to self-update yt-dlp (`yt-dlp -U`). The helper classifies
   * the updater output (updated / already current / brew-pip hints) and clears
   * its version cache, so the next /health reports the new version.
   * @returns {Promise<{ok:boolean, updated:boolean, version?:string, message?:string, hint?:string}>}
   */
  async function updateSelf() {
    const res = await fetch(`${BASE}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `update HTTP ${res.status}`);
    }
    return data;
  }

  /**
   * Ask the helper to reveal a saved file in the OS file manager. Chrome's
   * downloads API cannot show files it never downloaded, so helper-saved
   * outputs go through here. Resolves (never throws) with {ok, revealed}.
   */
  async function revealPath(path) {
    try {
      const res = await fetch(`${BASE}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ path })
      });
      const data = await res.json().catch(() => ({}));
      return { ok: !!(res.ok && data.ok), revealed: !!data.revealed };
    } catch {
      return { ok: false, revealed: false };
    }
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
    listPlaylist,
    updateSelf,
    revealPath
  };
})();
