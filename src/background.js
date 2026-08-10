/**
 * Universal Video Downloader — Background Service Worker
 * Detect media, merge HLS, save via chrome.downloads (verified complete).
 */
importScripts("uvd-common.js", "hls-downloader.js", "naming.js", "ytdlp.js");

/** @type {Map<number, Map<string, object>>} */
const tabMedia = new Map();
/** @type {Map<number, { title?: string, thumbnail?: string, host?: string, lastUrl?: string }>} */
const tabMeta = new Map();
const hlsProgress = new Map();
const videoAssemblies = new Map();
const probedUrls = new Set();
/** Base id for per-download DNR referer rules (unique ids avoid concurrent races) */
const REFERER_RULE_BASE = 771001;
let nextRefererRuleId = REFERER_RULE_BASE;
const MAX_REFERER_RULES = 40;

/**
 * Active download jobs — independent of tab navigation / popup close.
 * @type {Map<string, object>}
 */
const activeDownloads = new Map();
/** @type {Map<number, string>} tabId → latest jobId for that tab */
const tabJobMap = new Map();
/** jobId → AbortController (best-effort cancel for fetch-based paths) */
const jobAbortControllers = new Map();
let jobSeq = 0;
/** Refcounted SW keep-alive while any download runs */
let keepAliveRefs = 0;
let keepAliveTimer = null;
const BG_MAX_CONCURRENT_STARTS = 6;
function MAX_CONCURRENT_STARTS_BG() {
  return BG_MAX_CONCURRENT_STARTS;
}
/**
 * Async job context for progress routing when several downloads run at once.
 * Without this, emitDownloadProgress(tabId) would update the wrong job.
 */
let currentJobContext = null;

const MEDIA_EXTENSIONS = new Set([
  "mp4", "webm", "mkv", "mov", "m4v", "mp3", "m4a", "aac", "wav",
  "m3u8", "mpd", "ts", "m4s"
]);

// ─── helpers ───────────────────────────────────────────────

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,5})(?:$|[?#])/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function qualityLabel(height) {
  const h = height || 0;
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  if (h > 0) return `${h}p`;
  return null;
}

function hashUrl(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function getTabMap(tabId) {
  if (!tabMedia.has(tabId)) tabMedia.set(tabId, new Map());
  return tabMedia.get(tabId);
}

function isHlsUrl(url) {
  return /\.m3u8(\?|$|#)/i.test(url || "") || /m3u8/i.test(url || "");
}

function isRealHls(url, mediaType) {
  if (!url) return false;
  if (/\.m3u8(\?|$|#)/i.test(url)) return true;
  if (/m3u8/i.test(url) && (mediaType === "stream" || /playlist|format=m3u8/i.test(url))) return true;
  return false;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isYoutubeUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  return (
    h === "youtu.be" ||
    h === "youtube.com" ||
    h === "m.youtube.com" ||
    h === "music.youtube.com" ||
    h.endsWith(".youtube.com") ||
    h === "youtube-nocookie.com" ||
    h.endsWith(".youtube-nocookie.com")
  );
}

/** TikTok *page* (watch URL) — not CDN media hosts */
function isTiktokUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  // Exclude CDN hosts — those are direct media, not yt-dlp page extractors
  if (/tiktokcdn|byteicdn|byteoversea|ibyteimg/i.test(h)) return false;
  return (
    h === "tiktok.com" ||
    h.endsWith(".tiktok.com") ||
    h === "vm.tiktok.com" ||
    h === "vt.tiktok.com" ||
    h === "m.tiktok.com" ||
    h === "tiktokv.com" ||
    h.endsWith(".tiktokv.com")
  );
}

/** Instagram host (any page) */
function isInstagramHostUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (/cdninstagram|fbcdn\.net|instagram\.fs/i.test(h)) return false;
  return (
    h === "instagram.com" ||
    h.endsWith(".instagram.com") ||
    h === "instagr.am" ||
    h.endsWith(".instagr.am")
  );
}

/** Instagram post / reel / TV only — not home or profile */
function isInstagramPostUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "instagr.am") return (u.pathname || "/").length > 2;
    if (h === "instagram.com" || h.endsWith(".instagram.com")) {
      return /\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(u.pathname || "");
    }
  } catch {
    /* fall through */
  }
  return /instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(url);
}

/** Downloadable Instagram page URL (alias) */
function isInstagramUrl(url) {
  return isInstagramPostUrl(url);
}

function isInstagramCdnUrl(url) {
  const u = url || "";
  if (!/^https?:/i.test(u)) return false;
  if (/\.(jpe?g|png|gif|webp|bmp|svg|js|css)(\?|$)/i.test(u)) return false;
  return (
    (/cdninstagram\.com|fbcdn\.net/i.test(u) &&
      (/\.mp4(\?|$)/i.test(u) || /video|\/v\/t/i.test(u))) ||
    (/\.mp4(\?|$)/i.test(u) && /instagram/i.test(u))
  );
}

function isTiktokCdnUrl(url) {
  const u = url || "";
  if (!u || !/^https?:/i.test(u)) return false;
  // Never treat images / covers / scripts as video CDN
  if (/\.(js|css|json|map|html?|woff2?|jpe?g|png|gif|webp|bmp|svg|ico)(\?|$)/i.test(u)) {
    return false;
  }
  if (/\/webmssdk|webpack|chunk|runtime|analytics|sentry|cover|avatar|photo/i.test(u)) {
    return false;
  }
  // Real TikTok media almost always has video/tos or mime_type=video
  if (/mime_type=video/i.test(u)) return true;
  if (/\/video\/tos\//i.test(u)) return true;
  if (/\.mp4(\?|$)/i.test(u) && /tiktokcdn|byteicdn|byteoversea|tiktokv/i.test(u)) return true;
  return false;
}

function looksLikeVideoFileUrl(url) {
  if (!url || !/^https?:/i.test(url)) return false;
  if (/\.(js|css|json|map|html?|woff2?|jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.test(url)) {
    return false;
  }
  if (/\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url)) return true;
  if (/mime_type=video|\/video\/tos\//i.test(url)) return true;
  return isTiktokCdnUrl(url) || isInstagramCdnUrl(url);
}

/** Sniff first bytes — reject images (BMP/JPEG/PNG/…) */
function sniffIsVideo(uint8) {
  if (!uint8 || uint8.length < 12) return false;
  // BMP
  if (uint8[0] === 0x42 && uint8[1] === 0x4d) return false;
  // JPEG
  if (uint8[0] === 0xff && uint8[1] === 0xd8) return false;
  // PNG
  if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e && uint8[3] === 0x47) {
    return false;
  }
  // GIF
  if (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46) return false;
  // WEBP (RIFF....WEBP)
  if (
    uint8[0] === 0x52 &&
    uint8[1] === 0x49 &&
    uint8[2] === 0x46 &&
    uint8[3] === 0x46 &&
    uint8[8] === 0x57 &&
    uint8[9] === 0x45
  ) {
    return false;
  }
  // MP4 ftyp
  if (uint8[4] === 0x66 && uint8[5] === 0x74 && uint8[6] === 0x79 && uint8[7] === 0x70) {
    return true;
  }
  // WebM/MKV EBML
  if (uint8[0] === 0x1a && uint8[1] === 0x45 && uint8[2] === 0xdf && uint8[3] === 0xa3) {
    return true;
  }
  // MPEG-TS
  if (uint8[0] === 0x47) return true;
  return false;
}

/** X (Twitter) status pages */
function isXUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "t.co") return true;
    if (h === "x.com" || h.endsWith(".x.com") || h === "twitter.com" || h.endsWith(".twitter.com")) {
      return /\/status\/\d+/i.test(u.pathname || "") || /\/i\/status\/\d+/i.test(u.pathname || "");
    }
  } catch {
    /* fall through */
  }
  return /(?:x|twitter)\.com\/.+\/status\/\d+/i.test(url);
}

/** Facebook watch / reel / video pages */
function isFacebookUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "fb.watch" || h === "fb.com" || h.endsWith(".fb.com")) return true;
    if (h.includes("facebook.com")) {
      return (
        /\/(watch|reel|reels|videos|share|story\.php)/i.test(u.pathname || "") ||
        u.searchParams.has("v") ||
        /\/posts\//i.test(u.pathname || "")
      );
    }
  } catch {
    /* fall through */
  }
  return /facebook\.com\/(watch|reel|videos)|fb\.watch\//i.test(url);
}

/** Bilibili video pages */
function isBilibiliUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "b23.tv") return true;
    if (h.includes("bilibili.com") || h.includes("bilibili.tv")) {
      return (
        /\/video\/(BV|av)/i.test(u.pathname || "") ||
        /\/bangumi\//i.test(u.pathname || "") ||
        /\/play\//i.test(u.pathname || "")
      );
    }
  } catch {
    /* fall through */
  }
  return /bilibili\.com\/video\/|b23\.tv\//i.test(url);
}

/** Sites that need local yt-dlp helper for reliable full-quality download */
function needsYtDlpHelper(url, pageUrl) {
  // Direct CDN files never need the page extractor
  if (isTiktokCdnUrl(url) && !isTiktokUrl(url)) return false;
  if (isInstagramCdnUrl(url) && !isInstagramPostUrl(url)) return false;
  return (
    isYoutubeUrl(url) ||
    isYoutubeUrl(pageUrl) ||
    isTiktokUrl(url) ||
    isTiktokUrl(pageUrl) ||
    isInstagramPostUrl(url) ||
    isInstagramPostUrl(pageUrl) ||
    isXUrl(url) ||
    isXUrl(pageUrl) ||
    isFacebookUrl(url) ||
    isFacebookUrl(pageUrl) ||
    isBilibiliUrl(url) ||
    isBilibiliUrl(pageUrl)
  );
}

function siteKind(url, pageUrl) {
  if (isYoutubeUrl(url) || isYoutubeUrl(pageUrl)) return "youtube";
  if (isTiktokUrl(url) || isTiktokUrl(pageUrl)) return "tiktok";
  // Only real posts/reels — never homepage
  if (isInstagramPostUrl(url) || isInstagramPostUrl(pageUrl)) return "instagram";
  if (isXUrl(url) || isXUrl(pageUrl)) return "x";
  if (isFacebookUrl(url) || isFacebookUrl(pageUrl)) return "facebook";
  if (isBilibiliUrl(url) || isBilibiliUrl(pageUrl)) return "bilibili";
  return null;
}

function siteDefaultTitle(kind) {
  if (kind === "youtube") return "YouTube 영상";
  if (kind === "tiktok") return "TikTok 영상";
  if (kind === "instagram") return "Instagram 영상";
  if (kind === "x") return "X 영상";
  if (kind === "facebook") return "Facebook 영상";
  if (kind === "bilibili") return "Bilibili 영상";
  return "영상";
}

function makeSitePlaceholder(tab) {
  const pageUrl = tab?.url || "";
  const kind = siteKind(pageUrl, pageUrl);
  if (!kind) return null;
  const meta = tab?.id != null ? tabMeta.get(tab.id) : null;
  const title =
    meta?.title ||
    Naming.cleanPageTitle(tab?.title || "") ||
    siteDefaultTitle(kind);
  const item = enrichItem(tab.id, {
    url: pageUrl,
    type: "stream",
    isHls: false,
    isSiteDownload: true,
    site: kind,
    source: kind,
    title,
    pageTitle: title,
    pageUrl,
    thumbnail: meta?.thumbnail,
    host: hostOf(pageUrl),
    quality: "best",
    format: "MP4"
  });
  return item;
}

function classifyMedia(url, mime = "") {
  const ext = extFromUrl(url);
  const m = (mime || "").toLowerCase();
  if (ext === "m3u8" || m.includes("mpegurl") || m.includes("m3u8")) return { type: "stream" };
  if (ext === "mpd" || m.includes("dash+xml")) return { type: "stream" };
  if (ext === "ts" || ext === "m4s") return { type: "segment" };
  if (m.startsWith("audio/") || ["mp3", "m4a", "aac", "wav"].includes(ext)) return { type: "audio" };
  return { type: "video" };
}

function isLikelyMedia(url, mime = "", size = 0) {
  if (!url || url.startsWith("chrome") || url.startsWith("data:")) return false;
  if (url.startsWith("blob:")) return false;
  if (/\.m3u8(\?|$|#)/i.test(url) || /mpegurl|m3u8/i.test(mime || "")) return true;
  // YouTube / TikTok CDN (often no file extension)
  if (/googlevideo\.com\/videoplayback/i.test(url) && !/[&?]oad=/i.test(url)) return true;
  // TikTok CDN progressive files (often no classic extension)
  if (
    /tiktokcdn|musical\.ly|byteicdn|ibyteimg|tiktokv\.com|byteoversea|tiktok\.com\/aweme/i.test(
      url
    ) &&
    (/video|play|media|mime_type=video|\.mp4|\/play\//i.test(url) ||
      (mime || "").startsWith("video/"))
  ) {
    return true;
  }
  // Instagram CDN video
  if (isInstagramCdnUrl(url)) return true;
  if ((mime || "").startsWith("video/") && /cdninstagram|fbcdn\.net/i.test(url)) return true;
  if (Naming.isJunkMedia({ url, size, type: "video" })) return false;
  if (/\d+_\d{2,4}x\d{2,4}/i.test(url)) return false;
  if (/doubleclick|googlesyndication|exoclick|trafficjunky/i.test(url)) return false;
  const ext = extFromUrl(url);
  if (MEDIA_EXTENSIONS.has(ext)) return true;
  const m = (mime || "").toLowerCase();
  if (m.startsWith("video/") || m.startsWith("audio/")) return true;
  return false;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(message || `시간 초과 (${Math.round(ms / 1000)}초)`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function friendlyFetchError(err) {
  const s = String(err?.message || err || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(s)) {
    return "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 시도해 주세요";
  }
  return s;
}

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

/** Parse yt-dlp-style speed from progress text, e.g. "1.23MiB/s" */
function parseSpeedFromMessage(msg) {
  const s = String(msg || "");
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|KB|MB|GB|kB|mB|B)\/s/i
  );
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2].toLowerCase();
  if (unit === "b") return n;
  if (unit === "kib" || unit === "kb") return n * 1024;
  if (unit === "mib" || unit === "mb") return n * 1024 * 1024;
  if (unit === "gib" || unit === "gb") return n * 1024 * 1024 * 1024;
  return 0;
}

/** Throw if user paused/cancelled this job (checked during long downloads). */
function throwIfJobStopped(jobId) {
  if (!jobId) return;
  const j = activeDownloads.get(jobId);
  if (!j) return;
  if (j.pauseRequested || j.status === "paused") {
    const e = new Error("PAUSED");
    e.code = "PAUSED";
    throw e;
  }
  if (j.cancelRequested || j.status === "cancelled") {
    const e = new Error("CANCELLED");
    e.code = "CANCELLED";
    throw e;
  }
}

function finalizePausedJob(jobId) {
  const job = activeDownloads.get(jobId);
  if (!job) return;
  // Already cancelled wins
  if (job.status === "cancelled" || job.status === "done") return;
  job.status = "paused";
  job.phase = "paused";
  job.message = "일시정지됨 · 다시 시작 가능";
  // Keep pauseRequested true so in-flight loops still throw until they exit
  job.pauseRequested = true;
  job.cancelRequested = false;
  job.error = null;
  job.updatedAt = Date.now();
  try {
    jobAbortControllers.get(jobId)?.abort();
  } catch {
    /* ignore */
  }
  // Drop controller after abort so resume can install a fresh one
  jobAbortControllers.delete(jobId);
  persistJobs();
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
  job.updatedAt = Date.now();
  try {
    jobAbortControllers.get(jobId)?.abort();
  } catch {
    /* ignore */
  }
  jobAbortControllers.delete(jobId);
  if (job.tabId != null && tabJobMap.get(job.tabId) === jobId) {
    tabJobMap.delete(job.tabId);
  }
  persistJobs();
  broadcastJob(job);
  updateDownloadBadge();
  // Tell open pages to stop page-context HLS if any
  try {
    if (job.tabId != null && job.tabId >= 0) {
      chrome.tabs
        .sendMessage(job.tabId, { type: "STOP_DOWNLOAD", jobId })
        .catch(() => {});
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    const cur = activeDownloads.get(jobId);
    if (cur && cur.status === "cancelled") {
      activeDownloads.delete(jobId);
      persistJobs();
      updateDownloadBadge();
    }
  }, 30_000);
}

/** True when job must ignore progress / stop work */
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

/**
 * Cancel a running (or paused) download.
 */
async function cancelDownloadJob(jobId) {
  const job = activeDownloads.get(jobId);
  if (!job) return { ok: false, error: "작업 없음" };
  if (job.status === "done" || job.status === "cancelled") {
    return { ok: true, status: job.status };
  }
  job.cancelRequested = true;
  job.pauseRequested = false;
  job.message = "취소 중…";
  job.updatedAt = Date.now();
  try {
    jobAbortControllers.get(jobId)?.abort();
  } catch {
    /* ignore */
  }
  if (job.helperJobId) {
    try {
      await YtDlp.cancelJob(job.helperJobId);
    } catch {
      /* ignore */
    }
  }
  if (job.result?.downloadId != null) {
    try {
      chrome.downloads.cancel(job.result.downloadId);
    } catch {
      /* ignore */
    }
  }
  // Stop UI / progress immediately — do not wait for network to die
  finishCancelledJob(jobId);
  return { ok: true, status: "cancelled" };
}

/**
 * Pause a running download (abort current work; job stays for resume).
 */
async function pauseDownloadJob(jobId) {
  const job = activeDownloads.get(jobId);
  if (!job) return { ok: false, error: "작업 없음" };
  if (job.status !== "running") {
    return { ok: false, error: "받는 중인 항목만 일시정지할 수 있습니다" };
  }
  job.pauseRequested = true;
  job.cancelRequested = false;
  job.message = "일시정지 중…";
  job.updatedAt = Date.now();
  try {
    jobAbortControllers.get(jobId)?.abort();
  } catch {
    /* ignore */
  }
  if (job.helperJobId) {
    try {
      await YtDlp.cancelJob(job.helperJobId);
    } catch {
      /* ignore */
    }
  }
  // Tell page-context downloads to stop
  try {
    if (job.tabId != null && job.tabId >= 0) {
      chrome.tabs
        .sendMessage(job.tabId, { type: "STOP_DOWNLOAD", jobId })
        .catch(() => {});
    }
  } catch {
    /* ignore */
  }
  // Immediate UI state — blocks progress overwrite / flicker
  finalizePausedJob(jobId);
  return { ok: true, status: "paused" };
}

/**
 * Resume a paused job from its page/media URL.
 */
async function resumeDownloadJob(jobId) {
  const job = activeDownloads.get(jobId);
  if (!job) return { ok: false, error: "작업 없음" };
  if (job.status !== "paused") {
    return { ok: false, error: "일시정지된 항목만 다시 시작할 수 있습니다" };
  }
  const pageUrl = job.pageUrl || "";
  if (!pageUrl || !/^https?:/i.test(pageUrl)) {
    return { ok: false, error: "다시 시작할 주소가 없습니다" };
  }
  job.status = "running";
  job.phase = "start";
  job.percent = 0;
  job.message = "다시 시작…";
  job.pauseRequested = false;
  job.cancelRequested = false;
  job.error = null;
  job.helperJobId = null;
  job.updatedAt = Date.now();
  const ac = new AbortController();
  jobAbortControllers.set(jobId, ac);
  persistJobs();
  broadcastJob(job);
  updateDownloadBadge();
  const keep = startKeepAlive();
  withJobContext(jobId, () =>
    downloadPageFromUi(job.tabId, pageUrl, job.quality || "best", jobId, {
      mediaMode: job.mediaMode,
      mediaUrl: job.mediaUrl || "",
      title: job.title || ""
    })
  )
    .then((r) => {
      const j = activeDownloads.get(jobId);
      if (j?.pauseRequested) finalizePausedJob(jobId);
      else if (j?.cancelRequested) finishCancelledJob(jobId);
      else finishDownloadJob(jobId, r, null);
      stopKeepAlive(keep);
    })
    .catch((err) => {
      const j = activeDownloads.get(jobId);
      const msg = String(err?.message || err || "");
      if (j?.pauseRequested || /PAUSED/i.test(msg)) finalizePausedJob(jobId);
      else if (j?.cancelRequested || /CANCELLED|취소/i.test(msg)) {
        finishCancelledJob(jobId);
      } else finishDownloadJob(jobId, null, err);
      stopKeepAlive(keep);
    });
  return { ok: true, status: "running" };
}

/** Chrome downloads relative path under user Downloads */
async function relDownloadPath(filename) {
  const s = await UVD.getSettings();
  return UVD.downloadRelPath(s.subfolder, filename);
}

/**
 * Build human-readable filename. Empty string = let yt-dlp use real page title.
 * Avoids forcing YouTube_xxxx / TikTok_123 junk names.
 */
async function buildSaveFilename({
  title,
  quality,
  pageUrl,
  mediaType,
  mediaMode,
  seriesKey,
  playlistTitle,
  seriesIndex,
  seriesTotal
} = {}) {
  const s = await UVD.getSettings();
  const mode = mediaMode || s.mediaMode || "video";
  const mime = mode === "audio" || mediaType === "audio" ? "audio/mp3" : "video/mp4";
  // Prefer Naming helpers — strip Uncensored-Leaked noise, put CODE first
  if (typeof Naming !== "undefined" && Naming.buildFilename) {
    // Series / playlist structured names when applicable
    if (
      (playlistTitle || seriesKey || seriesIndex > 0) &&
      Naming.buildSeriesFilename
    ) {
      const full = Naming.buildSeriesFilename({
        title: title || "",
        pageTitle: title || "",
        quality: quality || "",
        type: mode === "audio" ? "audio" : "video",
        seriesKey: seriesKey || Naming.extractProductCode?.(title) || "",
        playlistTitle: playlistTitle || "",
        index: seriesIndex || 0,
        total: seriesTotal || 0
      });
      if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
        return safeDownloadName(full, mime);
      }
    }
    const bound = Naming.bindTitleToPage?.(pageUrl, title || "") || title || "";
    const full = Naming.buildFilename({
      title: bound || title || "",
      pageTitle: bound || title || "",
      quality: quality || "",
      type: mode === "audio" ? "audio" : "video",
      pageUrl: pageUrl || ""
    });
    if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
      return safeDownloadName(full, mime);
    }
  }
  // Fallback legacy template
  const cleanTitle = UVD.isGenericSaveName(title)
    ? ""
    : Naming.bindTitleToPage?.(pageUrl, title) || title || "";
  const base = UVD.applyFilenameTemplate("legacy", {
    title: cleanTitle,
    quality: quality || "",
    site: UVD.siteFromUrl(pageUrl || ""),
    mediaMode: mode
  });
  if (!base || UVD.isGenericSaveName(base)) return "";
  const ext = mode === "audio" || mediaType === "audio" ? ".mp3" : ".mp4";
  return safeDownloadName(base.endsWith(ext) ? base : base + ext, mime);
}

/**
 * Normalize any client-provided filename through Naming
 * so Uncensored-Leaked / site brands never reach disk or yt-dlp.
 */
function normalizeIncomingFilename(filename, quality = "", mediaMode = "video") {
  if (!filename) return "";
  const mime =
    mediaMode === "audio" || /\.mp3$/i.test(filename)
      ? "audio/mp3"
      : "video/mp4";
  if (typeof Naming !== "undefined" && Naming.buildFilename) {
    const full = Naming.buildFilename({
      title: String(filename),
      pageTitle: String(filename),
      quality: quality || "",
      type: mediaMode === "audio" ? "audio" : "video",
      existing: String(filename)
    });
    if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
      return safeDownloadName(full, mime);
    }
  }
  return safeDownloadName(filename, mime);
}

/** True when two titles refer to the same product / video identity */
function titlesMatchVideo(a, b) {
  const sa = String(a || "").trim();
  const sb = String(b || "").trim();
  if (!sa || !sb) return false;
  const ca = Naming.extractProductCode?.(sa) || "";
  const cb = Naming.extractProductCode?.(sb) || "";
  if (ca && cb) return ca.toUpperCase() === cb.toUpperCase();
  // If only one has a product code, they are different videos
  if (ca || cb) return false;
  const na = Naming.cleanPageTitle?.(sa) || sa;
  const nb = Naming.cleanPageTitle?.(sb) || sb;
  if (na === nb) return true;
  // Same stem ignoring quality suffix
  const stripQ = (s) => s.replace(/[_\s-]*\d{3,4}p\b/gi, "").trim().toLowerCase();
  return stripQ(na) === stripQ(nb) && stripQ(na).length >= 4;
}

/**
 * Lock the save filename at download START.
 * Must not be recomputed from the live tab later — user may navigate away
 * or start another video while HLS/yt-dlp is still running.
 */
function lockSaveName({
  filenameHint = "",
  title = "",
  pageTitle = "",
  quality = "",
  mediaMode = "video",
  pageUrl = "",
  seriesKey = "",
  playlistTitle = "",
  seriesIndex = 0,
  seriesTotal = 0
} = {}) {
  const mime = mediaMode === "audio" ? "audio/mp3" : "video/mp4";
  // Always bind titles to THIS pageUrl so another video's name can't leak in
  const bound =
    Naming.bindTitleToPage?.(pageUrl, title || pageTitle || filenameHint) ||
    Naming.cleanPageTitle?.(title || pageTitle || "") ||
    title ||
    pageTitle ||
    "";
  const boundHint = filenameHint
    ? Naming.bindTitleToPage?.(pageUrl, filenameHint) ||
      Naming.cleanPageTitle?.(
        String(filenameHint).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "")
      ) ||
      filenameHint
    : "";

  // 1) Explicit filename from popup/job — re-bind to pageUrl identity
  if (boundHint && !UVD.isGenericSaveName(boundHint)) {
    const full = Naming.buildFilename({
      title: boundHint,
      pageTitle: bound || boundHint,
      quality: quality || "",
      type: mediaMode === "audio" ? "audio" : "video",
      pageUrl: pageUrl || "",
      existing: boundHint
    });
    if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
      return safeDownloadName(full, mime);
    }
  }
  // 2) Build from the title that belongs to THIS job only
  if (bound && !UVD.isGenericSaveName(bound)) {
    if (
      (playlistTitle || seriesKey || seriesIndex > 0) &&
      Naming.buildSeriesFilename
    ) {
      const full = Naming.buildSeriesFilename({
        title: bound,
        pageTitle: bound,
        quality,
        type: mediaMode === "audio" ? "audio" : "video",
        seriesKey:
          seriesKey ||
          Naming.extractProductCode?.(pageUrl) ||
          Naming.extractProductCode?.(bound) ||
          "",
        playlistTitle: playlistTitle || "",
        index: seriesIndex || 0,
        total: seriesTotal || 0
      });
      if (full) return safeDownloadName(full, mime);
    }
    const full = Naming.buildFilename({
      title: bound,
      pageTitle: bound,
      quality,
      type: mediaMode === "audio" ? "audio" : "video",
      pageUrl: pageUrl || ""
    });
    if (full) return safeDownloadName(full, mime);
  }
  // 3) Product code from the page URL of THIS job (not current tab)
  const code =
    Naming.extractProductCode?.(pageUrl || "") ||
    Naming.extractProductCode?.(seriesKey || "") ||
    "";
  if (code) {
    return safeDownloadName(
      Naming.buildFilename({
        title: code,
        quality,
        type: mediaMode === "audio" ? "audio" : "video",
        pageUrl: pageUrl || ""
      }),
      mime
    );
  }
  return "";
}

/**
 * Apply real quality after download without changing the video identity in the name.
 */
function applyQualityToLockedName(lockedName, quality, mediaMode = "video") {
  if (!lockedName) return lockedName;
  const mime = mediaMode === "audio" ? "audio/mp3" : "video/mp4";
  let q =
    quality && !/^(best|all|unknown|highest|default)$/i.test(String(quality))
      ? String(quality).replace(/[()]/g, "").trim()
      : "";
  if (!q) return safeDownloadName(lockedName, mime);
  const base = String(lockedName).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
  if (new RegExp(`[_\\s-]${q}\\b`, "i").test(base) || base.endsWith(q)) {
    return safeDownloadName(lockedName, mime);
  }
  // Replace trailing quality if present, else append
  const stripped = base.replace(/[_\s-]*\d{3,4}p\b/i, "").trim() || base;
  return safeDownloadName(`${stripped}_${q}.mp4`, mime);
}

/** Only pass a forced name to yt-dlp when it's a real human title */
function ytdlpFilenameHint(filename, title) {
  const candidates = [filename, title].filter(Boolean);
  for (const c of candidates) {
    const base = String(c).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
    if (base && !UVD.isGenericSaveName(base) && base.length >= 2) {
      // Always re-clean (popup may still send dirty names)
      return normalizeIncomingFilename(
        /\.[a-z0-9]{2,5}$/i.test(c) ? c : `${base}.mp4`,
        "",
        "video"
      );
    }
  }
  return undefined; // yt-dlp %(title)s
}

/**
 * @param {string} pageUrl
 * @param {{ mediaMode?: string, saveThumbnail?: boolean }} [force]
 */
async function ytdlpExtraFromSettings(pageUrl, force = {}) {
  const s = await UVD.getSettings();
  const mediaMode = force.mediaMode || s.mediaMode || "video";
  const saveThumb =
    force.saveThumbnail !== undefined
      ? force.saveThumbnail
      : s.saveThumbnail !== false;
  return {
    audioOnly: mediaMode === "audio",
    writeSubs: mediaMode === "video_subs",
    writeThumbnail: saveThumb && mediaMode !== "audio",
    mediaMode,
    codecPref: s.codecPref || "best",
    // Parallel fragments / optional aria2 — quality unchanged
    speedProfile: s.downloadSpeed || force.speedProfile || "fast",
    // Only pure playlist URLs auto-expand; single watch+list stays one video
    yesPlaylist: UVD.isPlaylistOnlyUrl
      ? UVD.isPlaylistOnlyUrl(pageUrl)
      : UVD.isPlaylistUrl(pageUrl),
    subfolder: s.subfolder
  };
}

/**
 * Download cover image next to the video file (same basename .jpg).
 * Best-effort — never fails the main download.
 */
async function saveCompanionThumbnail(job, result) {
  try {
    const settings = await UVD.getSettings();
    if (settings.saveThumbnail === false) return;
    if ((job?.mediaMode || settings.mediaMode) === "audio") return;
    // yt-dlp already wrote thumb when writeThumbnail was set
    if (result?.method === "yt-dlp" || result?.ytdlp) {
      // Still try if we have a URL and helper didn't (some extractors skip thumbs)
    }
    let thumbUrl = job?.thumbnail || "";
    if (!thumbUrl && job?.tabId != null && job.tabId >= 0) {
      thumbUrl = tabMeta.get(job.tabId)?.thumbnail || "";
    }
    if (!thumbUrl || !/^https?:/i.test(thumbUrl)) return;

    const videoName =
      result?.filename ||
      job?.filename ||
      (result?.path ? String(result.path).split(/[/\\]/).pop() : "") ||
      "영상.mp4";
    let base = String(videoName).replace(/\.[a-z0-9]{2,5}$/i, "");
    if (!base || UVD.isGenericSaveName(base)) {
      base = (job?.title || "영상")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "영상";
    }
    const jpgName = safeDownloadName(`${base}.jpg`, "image/jpeg");
    const rel = await relDownloadPath(jpgName);

    // Prefer chrome.downloads direct URL (simple, no blob memory)
    try {
      await startChromeDownload(thumbUrl, rel);
      return;
    } catch {
      /* fall through to fetch */
    }
    try {
      const res = await fetch(thumbUrl, {
        credentials: "omit",
        cache: "no-store",
        headers: job?.pageUrl ? { Referer: job.pageUrl } : {}
      });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob.size || blob.size < 500) return;
      // small image via data URL
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
      const dataUrl = `data:${mime};base64,${b64}`;
      await startChromeDownload(dataUrl, rel);
    } catch (e) {
      console.warn("[UVD] thumb save", e);
    }
  } catch (e) {
    console.warn("[UVD] saveCompanionThumbnail", e);
  }
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
    /* ignore */
  }
}

function broadcastJob(job) {
  if (!job) return;
  const pub = publicJob(job);
  const progress = {
    percent: job.percent,
    message: job.message,
    phase: job.phase,
    jobId: job.id,
    title: job.title,
    status: job.status,
    global: true
  };
  hlsProgress.set(job.tabId ?? -1, progress);
  hlsProgress.set(-1, progress);
  chrome.runtime
    .sendMessage({ type: "DOWNLOAD_JOB", job: pub })
    .catch(() => {});
  chrome.runtime
    .sendMessage({
      type: "HLS_PROGRESS",
      tabId: job.tabId ?? -1,
      progress
    })
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
  const id = `dl_${Date.now()}_${++jobSeq}`;
  // Resolve thumbnail from tab meta if not provided
  let thumb = thumbnail || "";
  if (!thumb && tabId != null && tabId >= 0) {
    thumb = tabMeta.get(tabId)?.thumbnail || "";
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
        // Only mark as series when we actually have a series id
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
    message: niceTitle !== "영상" ? `받는 중 · ${niceTitle.slice(0, 40)}` : "백그라운드에서 받는 중…",
    phase: "start",
    error: null,
    errorCode: null,
    result: null,
    helperJobId: null,
    cancelRequested: false,
    pauseRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  activeDownloads.set(id, job);
  jobAbortControllers.set(id, new AbortController());
  // Keep latest job id for tab (UI only); progress always uses explicit jobId
  if (tabId != null && tabId >= 0) tabJobMap.set(tabId, id);
  persistJobs();
  broadcastJob(job);
  updateDownloadBadge();
  return id;
}

function countRunningJobs() {
  let n = 0;
  for (const j of activeDownloads.values()) {
    if (j.status === "running") n += 1;
  }
  return n;
}

/**
 * Resolve which job a progress event belongs to.
 * When several downloads run, NEVER guess — only explicit jobId is safe
 * (currentJobContext breaks across await boundaries).
 */
function findRunningJob(tabId, explicitJobId = null) {
  if (explicitJobId) {
    const j = activeDownloads.get(explicitJobId);
    if (j) return j;
  }
  const running = countRunningJobs();
  // Only use ambient context when a single job is active
  if (running <= 1 && currentJobContext) {
    const ctx = activeDownloads.get(currentJobContext);
    if (ctx?.status === "running") return ctx;
  }
  if (running === 1) {
    for (const j of activeDownloads.values()) {
      if (j.status === "running") return j;
    }
  }
  // Multiple jobs: do not map by tabId (many jobs share one tab)
  if (running > 1) return null;
  if (tabId != null && tabId >= 0) {
    const mapped = tabJobMap.get(tabId);
    if (mapped) {
      const j = activeDownloads.get(mapped);
      if (j?.status === "running") return j;
    }
  }
  return null;
}

async function withJobContext(jobId, fn) {
  const prev = currentJobContext;
  currentJobContext = jobId;
  try {
    return await fn();
  } finally {
    // Only restore if we still own the slot (another job may have nested)
    if (currentJobContext === jobId) currentJobContext = prev;
    else currentJobContext = prev;
  }
}

function phaseRank(phase) {
  const p = String(phase || "");
  if (p === "start" || p === "playlist") return 1;
  if (p === "download" || p === "segments" || p === "running") return 2;
  if (p === "merge" || p === "save") return 3;
  if (p === "done") return 4;
  if (p === "error") return 4;
  return 2;
}

function updateDownloadJob(jobId, patch) {
  const job = activeDownloads.get(jobId);
  if (!job) return null;
  // Hard stop: never let progress revive a paused/cancelled job
  if (jobIsStopping(job) && job.status !== "running") {
    return job;
  }
  if (job.pauseRequested || job.cancelRequested) {
    // Still running loop but user asked to stop — ignore progress patches
    if (patch.status === "running" || patch.percent != null || patch.message) {
      return job;
    }
  }
  if (job.status !== "running" && patch.status === "running") {
    // ignore late progress after finish
    return job;
  }
  const next = { ...patch };
  // Progress: allow intentional reset on method retry (page HLS → SW HLS).
  // Otherwise keep monotonic so the bar doesn't jitter from noisy updates.
  if (job.status === "running" && typeof next.percent === "number") {
    const prevP = typeof job.percent === "number" ? job.percent : 0;
    if (next.progressReset) {
      next.percent = Math.max(0, Math.min(100, next.percent));
      delete next.progressReset;
    } else {
      next.percent = Math.max(prevP, Math.min(100, next.percent));
    }
  }

  // Speed: parse from message, or estimate from % · estimatedSize
  if (job.status === "running") {
    const fromMsg = parseSpeedFromMessage(next.message || job.message || "");
    if (fromMsg > 0) {
      next.speedBps = fromMsg;
    } else if (
      typeof next.percent === "number" &&
      (job.estimatedSize > 0 || next.estimatedSize > 0)
    ) {
      const est = next.estimatedSize || job.estimatedSize || 0;
      const now = Date.now();
      const bytesNow = (next.percent / 100) * est;
      const prevBytes = job._speedBytes;
      const prevAt = job._speedAt;
      if (
        prevBytes != null &&
        prevAt &&
        now - prevAt >= 400 &&
        bytesNow > prevBytes
      ) {
        const inst = ((bytesNow - prevBytes) / (now - prevAt)) * 1000;
        // EMA smooth
        const prevSp = job.speedBps || inst;
        next.speedBps = prevSp * 0.55 + inst * 0.45;
      }
      next._speedBytes = bytesNow;
      next._speedAt = now;
    }
  }

  Object.assign(job, next, { updatedAt: Date.now() });
  persistJobs();
  broadcastJob(job);
  updateDownloadBadge();
  return job;
}

function finishDownloadJob(jobId, result, error) {
  const job = activeDownloads.get(jobId);
  if (!job) return;
  if (error) {
    job.status = "error";
    job.phase = "error";
    job.error = String(error?.message || error);
    job.message = job.error;
    job.percent = job.percent || 0;
    const meta = UVD.classifyError(job.error);
    job.errorCode = meta.code;
  } else {
    job.status = "done";
    job.phase = "done";
    job.percent = 100;
    job.result = result || null;
    job.error = null;
    job.errorCode = null;
    // Surface the real saved name so the popup can show what finished
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
        (!job.title ||
          job.title === "영상" ||
          UVD.isGenericSaveName(job.title))
      ) {
        job.title = base;
      }
      job.message = `저장 완료 · ${savedName}`;
    } else {
      job.message = "저장 완료";
    }
  }
  job.updatedAt = Date.now();
  // Detach from tab map so navigation cleanup is harmless
  if (job.tabId != null && tabJobMap.get(job.tabId) === jobId) {
    tabJobMap.delete(job.tabId);
  }
  persistJobs();
  broadcastJob(job);
  updateDownloadBadge();

  // Persist history (done + failed)
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
      at: Date.now()
    }).catch(() => {});
  } catch {
    /* ignore */
  }

  // Companion thumbnail (best-effort, success only)
  if (!error && job.status === "done") {
    saveCompanionThumbnail(job, result).catch(() => {});
  }

  // OS notification (works even when popup is closed)
  notifyDownloadFinished(job, result, error).catch(() => {});

  // Keep finished job briefly so reopened popup can show result
  setTimeout(() => {
    const cur = activeDownloads.get(jobId);
    if (cur && cur.status !== "running") {
      activeDownloads.delete(jobId);
      persistJobs();
      if (hlsProgress.get(-1)?.jobId === jobId) hlsProgress.delete(-1);
      updateDownloadBadge();
    }
  }, 120_000);
}

/** Map notificationId → { downloadId, path } for click-to-open */
const notifActions = new Map();

async function notifyDownloadFinished(job, result, error) {
  try {
    const settings = await UVD.getSettings();
    if (settings.notifyOnComplete === false) return;
    if (!chrome.notifications?.create) return;

    const title = (job?.title || job?.filename || "영상").slice(0, 60);
    const ok = !error && job?.status === "done";
    const notifId = `uvd_${job?.id || Date.now()}`;
    const path = result?.path || result?.outDir || "";
    const downloadId = result?.downloadId ?? null;
    const size = result?.size || 0;
    const sizeTxt =
      size >= 1024 * 1024
        ? `${(size / 1024 / 1024).toFixed(1)}MB`
        : size > 0
          ? `${Math.round(size / 1024)}KB`
          : "";

    notifActions.set(notifId, { downloadId, path, pageUrl: job?.pageUrl || "" });
    // prune old
    if (notifActions.size > 40) {
      const first = notifActions.keys().next().value;
      notifActions.delete(first);
    }

    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: ok ? "저장 완료" : "다운로드 실패",
      message: ok
        ? `${title}${sizeTxt ? ` · ${sizeTxt}` : ""}\n클릭하면 폴더를 엽니다`
        : `${title}\n${String(error?.message || job?.error || "실패").slice(0, 100)}`,
      priority: 1,
      requireInteraction: false
    });
  } catch (e) {
    console.warn("[UVD] notify", e);
  }
}

if (chrome.notifications?.onClicked) {
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
      /* ignore */
    }
  });
}

function listActiveDownloads() {
  return [...activeDownloads.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
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
      (j) => j.status === "running"
    ).length;
    const paused = [...activeDownloads.values()].filter(
      (j) => j.status === "paused"
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
    /* ignore */
  }
}

/**
 * Detach a job from a tab so navigation/close does not wipe progress.
 * Download keeps running; tabJobMap is kept so in-flight emit(tabId) still finds the job.
 */
function detachJobsFromTab(tabId) {
  if (tabId == null) return;
  const mapped = tabJobMap.get(tabId);
  if (mapped) {
    const job = activeDownloads.get(mapped);
    if (job?.status === "running") {
      // Keep tabJobMap → jobId so progress callbacks with old tabId still route
      job.tabId = -1;
      job.updatedAt = Date.now();
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
      job.updatedAt = Date.now();
      persistJobs();
      broadcastJob(job);
    }
  }
}

/**
 * @param {number|null} tabId
 * @param {number} percent
 * @param {string} message
 * @param {string} [phase]
 * @param {string|null} [jobId] — required when multiple downloads run
 */
/**
 * Map HLS phases to honest percent bands.
 * Leave plenty of room AFTER network download so merge + disk write
 * do not look like "stuck at 99%" for minutes on large files.
 *
 *   playlist/init  2–5%
 *   segments       5–78%  proportional to completed/total segments
 *   merge          78–85%
 *   save           85–98%  (Chrome writing the blob to disk)
 *   done           100%
 */
function hlsPhasePercent(p = {}) {
  if (p.phase === "save") {
    if (typeof p.percent === "number" && p.percent >= 0) {
      return Math.max(85, Math.min(98, p.percent));
    }
    return 86;
  }
  // Segments: ONLY completed/total — never remap onto a rising floor
  if (p.phase === "segments") {
    if (p.total > 0) {
      const ratio = Math.max(0, Math.min(1, Number(p.current) / Number(p.total)));
      return Math.round(5 + ratio * 73); // 5 .. 78
    }
    return 5;
  }
  if (p.phase === "merge") {
    if (p.total > 0 && p.current >= 0) {
      const ratio = Math.max(0, Math.min(1, Number(p.current) / Number(p.total)));
      return Math.round(78 + ratio * 7); // 78 .. 85
    }
    return 80;
  }
  if (p.phase === "done") return 100;
  if (p.phase === "playlist" || p.phase === "init" || p.phase === "start") {
    return 3;
  }
  // Non-HLS (yt-dlp etc.): trust helper mapping; never show 99 until truly done
  if (typeof p.percent === "number" && p.percent >= 0) {
    return Math.max(0, Math.min(98, p.percent));
  }
  return 3;
}

/**
 * Estimate disk-write progress when chrome.downloads gives no byte updates
 * (common for blob: URLs). Advances 85→97 based on elapsed vs size estimate.
 */
/**
 * Estimate disk-write progress when chrome.downloads gives no byte updates
 * (common for blob: URLs). Advances 85→97 based on elapsed vs size estimate.
 */
function estimateSavePercent(blobSize, startedAt, bytesReceived, totalBytes) {
  // Prefer real Chrome byte progress when it actually moves
  if (totalBytes > 0 && bytesReceived > 0) {
    const ratio = Math.min(1, bytesReceived / totalBytes);
    return Math.round(85 + ratio * 13); // 85 .. 98
  }
  const elapsed = Math.max(0, Date.now() - (startedAt || Date.now()));
  // ~60MB/s local write estimate; min 3s so bar doesn't jump
  const estMs = Math.min(
    10 * 60 * 1000,
    Math.max(3000, ((blobSize || 50_000_000) / (60 * 1024 * 1024)) * 1000)
  );
  // Approach 97% asymptotically — never claim 99/100 until save finishes
  const ratio = Math.min(0.92, elapsed / estMs);
  return Math.round(85 + ratio * 12); // 85 .. ~96
}

function emitDownloadProgress(tabId, percent, message, phase = "download", jobId = null, extra = {}) {
  // If this job is stopping, surface the stop error so download loops exit
  const explicit = jobId ? activeDownloads.get(jobId) : null;
  if (explicit && jobIsStopping(explicit)) {
    throwIfJobStopped(jobId);
    return; // paused/cancelled — no progress spam
  }
  try {
    throwIfJobStopped(jobId);
  } catch (e) {
    throw e;
  }
  const job = findRunningJob(tabId, jobId);
  if (!job) {
    // Multi-download without jobId: drop ambient noise (was causing % thrash)
    if (countRunningJobs() > 1 && !jobId) return;
    const progress = {
      percent,
      message,
      phase,
      global: true,
      jobId: jobId || null
    };
    // Per-job progress map key when we have id
    if (jobId) hlsProgress.set(jobId, progress);
    hlsProgress.set(tabId ?? -1, progress);
    chrome.runtime
      .sendMessage({ type: "HLS_PROGRESS", tabId: tabId ?? -1, progress })
      .catch(() => {});
    return;
  }
  // Never force status back to "running" if user paused/cancelled
  if (jobIsStopping(job)) {
    throwIfJobStopped(job.id);
    return;
  }
  const status =
    phase === "done" ? "done" : phase === "error" ? "error" : "running";
  // Don't mark done/error here — finishDownloadJob owns terminal states
  if (status === "running") {
    const reset = !!extra.progressReset;
    const floor = typeof job.percent === "number" ? job.percent : 0;
    let pct =
      typeof percent === "number" ? Math.min(100, Math.max(0, percent)) : floor;
    // Default: never go backwards (jitter). Method switch may reset.
    if (!reset) pct = Math.max(floor, pct);
    updateDownloadJob(job.id, {
      percent: pct,
      message,
      phase,
      // Do NOT set status:"running" every tick — preserves pause transitions
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
      .sendMessage({ type: "HLS_PROGRESS", tabId: job.tabId ?? -1, progress })
      .catch(() => {});
  }
}

function safeDownloadName(filename, mime = "") {
  const defaultExt = mime.includes("audio") ? ".mp3" : ".mp4";
  let name = String(filename || "");
  // Never keep directory components here — relDownloadPath adds subfolder
  name = name.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  // Broken uniquify forms: "title.mp4 (1).mp4" / "title.mp4 (1)" / "title (2)"
  name = name.replace(
    /\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*\.(mp4|webm|mkv|mp3|m4a)$/i,
    ".$1"
  );
  name = name.replace(/\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*$/i, ".$1");
  name = name.replace(/\s*\(\d{1,3}\)\s*(?=\.[a-z0-9]{2,5}$)/i, "");
  name = name.replace(/\s*\(\d{1,3}\)\s*$/g, "");
  // Strip leak tags again (safety net if Naming not used)
  name = name
    .replace(/[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi, " ")
    .replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ")
    .replace(
      /[-–—|·•:_\s]*(No\s*Mosaic|Demosaic|Uncut|Raw)(?=[_\s\-–—.]|$)/gi,
      " "
    );
  name = name
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[♥❤💕💗💖💘⭐✨…·•]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/[\u2010-\u2015\u2212]+/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.ts$/i, ".mp4")
    .replace(/\.m3u8$/i, ".mp4")
    .replace(/^\.+/, "")
    .trim();

  let ext = defaultExt;
  // Peel ALL trailing extensions so "a.mp4.mp4" → base a, ext .mp4
  let peelGuard = 0;
  while (peelGuard++ < 6 && /\.[a-z0-9]{2,5}$/i.test(name)) {
    const m = name.match(/(\.[a-z0-9]{2,5})$/i);
    if (!m) break;
    const e = m[1].toLowerCase();
    if (e === ".ts" || e === ".m3u8") {
      ext = ".mp4";
    } else if (
      [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".mp3", ".m4a", ".aac"].includes(e)
    ) {
      ext = e;
    } else {
      // quality-like or unknown — stop peeling
      break;
    }
    name = name.slice(0, -m[1].length).trim();
    // Stop if we hit a quality tag mistaken as base
    if (/^\d{3,4}p$/i.test(name)) break;
  }
  // Basename must be real text
  name = name.replace(/^[.\s_-]+|[.\s_-]+$/g, "").trim();
  // Prefer Naming cleaner when available (before generic check)
  if (typeof Naming !== "undefined" && Naming.cleanPageTitle) {
    const cleaned = Naming.cleanPageTitle(name);
    if (cleaned && cleaned.length >= 2) name = cleaned;
  }
  if (
    !name ||
    name.length < 2 ||
    /^(best|all|unknown|video|media|download|file|영상|동영상|mp4|webm|mkv|mp3|m4a)$/i.test(
      name
    )
  ) {
    name = `영상_${Date.now()}`;
  }
  let full = `${name}${ext.startsWith(".") ? ext : `.${ext}`}`;
  // Never leave double video extensions
  full = full.replace(
    /\.(mp4|webm|mkv|mp3|m4a)\.(mp4|webm|mkv|mp3|m4a)$/i,
    ".$2"
  );
  if (full.length > 100) {
    const e = ext.startsWith(".") ? ext : `.${ext}`;
    full = name.slice(0, Math.max(8, 100 - e.length)).trim() + e;
  }
  if (!/^[^\s/\\].+\.[a-z0-9]{2,5}$/i.test(full) || full.startsWith(".")) {
    full = `영상_${Date.now()}${defaultExt}`;
  }
  return full;
}

function filenameFromUrl(url) {
  return Naming.buildFilename({ url, title: "영상" });
}

function resolveFilename(tabId, item = {}, url = item.url) {
  const meta = tabId != null ? tabMeta.get(tabId) : null;
  return Naming.buildFilename({
    url: url || item.url || "",
    title: item.title || item.pageTitle || meta?.title || "",
    pageTitle: item.pageTitle || meta?.title || "",
    quality: item.quality || "",
    type: item.type || "video",
    isHls: item.isHls || item.type === "stream",
    isFmp4: true,
    host: item.host || meta?.host || "",
    existing: item.filename || ""
  });
}

// ─── media store ───────────────────────────────────────────

/**
 * Identity of the "current video page" — used to wipe stale thumbs/titles.
 * YouTube /watch?v=A → /watch?v=B share pathname but are different videos.
 */
function pageIdentityKey(url) {
  if (!url || !/^https?:/i.test(url)) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname || "/";

    // YouTube
    if (host === "youtu.be") {
      const id = path.replace(/^\//, "").split("/")[0];
      return id ? `yt:${id}` : `yt:${path}`;
    }
    if (host.includes("youtube") || host.includes("youtube-nocookie")) {
      const v = u.searchParams.get("v");
      if (v) return `yt:${v}`;
      const m = path.match(/\/(shorts|embed|live|clip)\/([^/?#]+)/i);
      if (m) return `yt:${m[1]}:${m[2]}`;
      const list = u.searchParams.get("list");
      if (list && /playlist/i.test(path)) return `yt:list:${list}`;
      return `yt:${path}`;
    }

    // TikTok
    if (host.includes("tiktok")) {
      const m = path.match(/\/@[^/]+\/video\/(\d+)/i);
      if (m) return `tt:${m[1]}`;
      const t = path.match(/\/t\/([^/?#]+)/i);
      if (t) return `tt:t:${t[1]}`;
      return `tt:${path}`;
    }

    // Instagram
    if (host.includes("instagram") || host.includes("instagr.am")) {
      const m = path.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      if (m) return `ig:${m[1]}:${m[2]}`;
      return `ig:${path.replace(/\/+$/, "") || "/"}`;
    }

    // Adult tubes: product code in path is the true identity
    // e.g. /dm14/v/snos-309 → snos-309
    const codeInPath = path.match(
      /(?:^|\/)([a-z]{2,12})-?(\d{2,5})(?:\/|$|\.)/i
    );
    if (
      codeInPath &&
      /123av|missav|jable|avgle|netflav|supjav|njav|javdb|thisav|hanime/i.test(
        host
      )
    ) {
      return `${host}:code:${codeInPath[1].toUpperCase()}-${codeInPath[2]}`;
    }

    // Generic: origin + path + significant query keys
    const keep = [];
    for (const k of ["v", "id", "video_id", "vid", "clip", "watch", "code"]) {
      const val = u.searchParams.get(k);
      if (val) keep.push(`${k}=${val}`);
    }
    keep.sort();
    return `${host}${path.replace(/\/+$/, "") || "/"}${
      keep.length ? "?" + keep.join("&") : ""
    }`;
  } catch {
    return String(url).slice(0, 200);
  }
}

function clearTabMediaState(tabId, { keepLastUrl } = {}) {
  if (tabId == null) return;
  tabMedia.delete(tabId);
  const prevUrl = keepLastUrl || tabMeta.get(tabId)?.lastUrl || "";
  tabMeta.delete(tabId);
  if (prevUrl) {
    tabMeta.set(tabId, {
      lastUrl: prevUrl,
      pageKey: pageIdentityKey(prevUrl),
      title: undefined,
      thumbnail: undefined,
      host: (() => {
        try {
          return new URL(prevUrl).hostname;
        } catch {
          return undefined;
        }
      })()
    });
  }
  updateBadge(tabId);
  broadcastUpdate(tabId);
}

function enrichItem(tabId, item) {
  const meta = tabId != null ? tabMeta.get(tabId) : null;
  const quality = item.quality || qualityLabel(item.height) || null;
  const isHls = !!(
    item.isHls ||
    item.type === "stream" ||
    (item.url && /\.m3u8(\?|$|#)/i.test(item.url))
  );

  // Only inherit tab title/thumb when this media is from the same page
  const itemPage = item.pageUrl || item.url || meta?.lastUrl || "";
  const samePage =
    !meta?.pageKey ||
    !itemPage ||
    pageIdentityKey(itemPage) === meta.pageKey ||
    pageIdentityKey(meta.lastUrl || "") === meta.pageKey;

  const tabTitle = samePage ? meta?.title || "" : "";
  // Prefer the item's own title bound to its pageUrl — never a different video's name
  const pageRef = item.pageUrl || (samePage ? meta?.lastUrl : "") || "";
  let title = "";
  for (const c of [item.title, item.pageTitle]) {
    if (!c) continue;
    const cleaned = pageRef
      ? Naming.bindTitleToPage?.(pageRef, c) || Naming.cleanPageTitle(c) || c
      : Naming.cleanPageTitle(c) || c;
    if (cleaned && !Naming.isUglyBase(cleaned)) {
      title = cleaned;
      break;
    }
  }
  if ((!title || Naming.isUglyBase(title)) && tabTitle && samePage) {
    const tt = pageRef
      ? Naming.bindTitleToPage?.(pageRef, tabTitle) ||
        Naming.cleanPageTitle(tabTitle) ||
        tabTitle
      : Naming.cleanPageTitle(tabTitle) || tabTitle;
    if (tt && !Naming.isUglyBase(tt)) title = tt;
  } else if (title && tabTitle && samePage) {
    // Same page: allow longer tab title only if same product code
    const tt = Naming.cleanPageTitle(tabTitle) || tabTitle;
    if (
      tt &&
      !Naming.isUglyBase(tt) &&
      titlesMatchVideo(title, tt) &&
      tt.length > title.length + 5
    ) {
      title = pageRef
        ? Naming.bindTitleToPage?.(pageRef, tt) || tt
        : tt;
    }
  }
  if (!title && pageRef) {
    title = Naming.extractProductCode?.(pageRef) || "";
  }

  const host = meta?.host || item.host || "";
  const thumbnail =
    item.thumbnail ||
    (samePage && meta?.thumbnail ? meta.thumbnail : undefined) ||
    undefined;
  const existingRaw = (item.filename || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const existingOk =
    existingRaw && !Naming.isUglyBase(existingRaw) ? item.filename : "";

  // Filename must stay bound to this item's page, not a foreign tab title
  const filename = Naming.buildFilename({
    title,
    pageTitle: item.pageTitle || (samePage ? meta?.title : "") || "",
    quality,
    type: item.type || "video",
    isHls,
    isFmp4: true,
    host,
    existing: existingOk,
    pageUrl: pageRef
  });
  const displayName = Naming.displayTitle({
    title,
    pageTitle: item.pageTitle || (samePage ? meta?.title : "") || "",
    type: item.type || "video"
  });

  let estimatedSize = item.estimatedSize;
  // Prefer estimateBandwidth (avg); raw BANDWIDTH is peak and often ~2× actual size
  const estBw = item.estimateBandwidth || item.bandwidth;
  if (!item.size && !estimatedSize && estBw > 0 && item.duration >= 1) {
    const rate = item.estimateBandwidth ? estBw : Math.round(estBw * 0.55);
    estimatedSize = Math.round((rate / 8) * item.duration);
  }

  return {
    ...item,
    quality,
    isHls,
    isFmp4: true,
    format: "MP4",
    estimatedSize: estimatedSize || undefined,
    title: title || undefined,
    pageTitle: item.pageTitle || (samePage ? meta?.title : undefined) || undefined,
    host: host || undefined,
    thumbnail,
    filename,
    displayName
  };
}

function mergePrefer(existing, incoming) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || v === "") continue;
    if (k === "filename" || k === "displayName" || k === "title") {
      const prevBase = String(out[k] || "").replace(/\.[^.]+$/, "");
      const nextBase = String(v).replace(/\.[^.]+$/, "");
      if (!out[k] || Naming.isUglyBase(prevBase)) {
        if (!Naming.isUglyBase(nextBase)) out[k] = v;
      } else if (!Naming.isUglyBase(nextBase) && nextBase.length > prevBase.length) {
        // Never replace with a longer title for a *different* product code
        if (titlesMatchVideo(prevBase, nextBase) || !Naming.extractProductCode?.(prevBase)) {
          out[k] = v;
        }
      }
      continue;
    }
    if (k === "thumbnail") {
      if (!out.thumbnail || (String(v).startsWith("data:") && !String(out.thumbnail).startsWith("data:"))) {
        out.thumbnail = v;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

function addMedia(tabId, item) {
  if (tabId == null || tabId < 0 || !item?.url) return;
  if (Naming.isJunkMedia(item)) return;

  const enriched = enrichItem(tabId, item);
  if (Naming.isJunkMedia(enriched)) return;

  const map = getTabMap(tabId);
  const key = item.url;
  const existing = map.get(key);
  if (existing) {
    map.set(key, {
      ...mergePrefer(existing, enriched),
      foundAt: existing.foundAt,
      id: existing.id,
      tabId
    });
  } else {
    map.set(key, {
      id: `${tabId}_${hashUrl(key)}`,
      foundAt: Date.now(),
      tabId,
      ...enriched
    });
  }
  updateBadge(tabId);
  broadcastUpdate(tabId);
  if (enriched.isHls || enriched.type === "stream") maybeProbeHls(tabId, key);
}

function setTabMeta(tabId, meta) {
  if (tabId == null || tabId < 0 || !meta) return;
  const prev = tabMeta.get(tabId) || {};
  const nextUrl = meta.lastUrl || prev.lastUrl || "";
  const nextKey =
    meta.pageKey ||
    (nextUrl ? pageIdentityKey(nextUrl) : "") ||
    prev.pageKey ||
    "";
  const prevKey = prev.pageKey || (prev.lastUrl ? pageIdentityKey(prev.lastUrl) : "");
  const pageChanged = !!(prevKey && nextKey && prevKey !== nextKey);

  // Never keep previous page's thumbnail/title when the video page changed
  let title;
  if (pageChanged) {
    title = meta.title || undefined;
  } else if (Object.prototype.hasOwnProperty.call(meta, "title")) {
    title = meta.title || undefined;
  } else {
    title = prev.title;
  }

  let thumbnail;
  if (pageChanged) {
    thumbnail = meta.thumbnail || undefined;
  } else if (Object.prototype.hasOwnProperty.call(meta, "thumbnail")) {
    thumbnail = meta.thumbnail || undefined;
  } else {
    thumbnail = prev.thumbnail;
  }

  const next = {
    title,
    thumbnail,
    host: meta.host || prev.host,
    lastUrl: nextUrl || prev.lastUrl,
    pageKey: nextKey || prevKey || undefined
  };

  if (pageChanged) {
    // Drop media from previous video page; jobs keep running separately
    tabMedia.delete(tabId);
  }

  tabMeta.set(tabId, next);

  const map = tabMedia.get(tabId);
  if (!map) {
    if (pageChanged) {
      updateBadge(tabId);
      broadcastUpdate(tabId);
    }
    return;
  }
  let changed = pageChanged;
  for (const [url, item] of map) {
    // Strip stale thumbnails that don't match current page
    let base = item;
    if (pageChanged || (item.thumbnail && next.pageKey && item.pageUrl && pageIdentityKey(item.pageUrl) !== next.pageKey)) {
      base = { ...item, thumbnail: item.pageUrl && pageIdentityKey(item.pageUrl) === next.pageKey ? item.thumbnail : undefined };
    }
    const patched = enrichItem(tabId, base);
    if (
      patched.filename !== item.filename ||
      patched.thumbnail !== item.thumbnail ||
      patched.displayName !== item.displayName ||
      patched.title !== item.title
    ) {
      map.set(url, { ...item, ...patched, foundAt: item.foundAt, id: item.id, tabId });
      changed = true;
    }
  }
  if (changed) {
    updateBadge(tabId);
    broadcastUpdate(tabId);
  }
}

async function maybeProbeHls(tabId, url) {
  if (!url || probedUrls.has(url)) return;
  if (!/\.m3u8(\?|$|#)/i.test(url) && !url.includes("m3u8")) return;
  probedUrls.add(url);
  try {
    let info;
    await withTabReferer(tabId, async () => {
      info = await HLS.probe(url);
    });
    const map = tabMedia.get(tabId);
    if (!map || !map.has(url) || !info) return;
    const cur = map.get(url);

    if (info.kind === "master" && info.variants?.length) {
      const best = info.variants[0];
      let mediaDuration = cur.duration;
      let segmentCount = cur.segmentCount;
      try {
        await withTabReferer(tabId, async () => {
          const mediaInfo = await HLS.probe(best.url);
          if (mediaInfo.kind === "media") {
            mediaDuration = mediaInfo.duration || mediaDuration;
            segmentCount = mediaInfo.segmentCount;
          }
        });
      } catch {
        /* ignore */
      }
      // Size estimate uses average bitrate (or ~55% of peak) — peak alone is often ~2× real
      const bw = best.estimateBandwidth || best.bandwidth || 0;
      const dur = mediaDuration >= 1 ? mediaDuration : cur.duration;
      const estimatedSize =
        bw > 0 && dur >= 1 ? Math.round((bw / 8) * dur) : undefined;
      const updated = enrichItem(tabId, {
        ...cur,
        isHls: true,
        type: "stream",
        format: "MP4",
        quality: best.quality || qualityLabel(best.height),
        width: best.width || cur.width,
        height: best.height || cur.height,
        bandwidth: best.bandwidth || undefined,
        duration: dur >= 1 ? dur : undefined,
        estimatedSize,
        segmentCount,
        isFmp4: true
      });
      map.set(url, { ...cur, ...updated, foundAt: cur.foundAt, id: cur.id, tabId });
    } else if (info.kind === "media") {
      const dur = info.duration >= 1 ? info.duration : cur.duration;
      const inferredH =
        Number(info.inferredHeight) ||
        (typeof HLS?.heightFromString === "function"
          ? HLS.heightFromString(url)
          : 0) ||
        cur.height ||
        0;
      const qLab =
        (inferredH >= 240 && qualityLabel(inferredH)) ||
        (cur.quality && !/^(best|all|unknown)$/i.test(String(cur.quality))
          ? cur.quality
          : null);
      const updated = enrichItem(tabId, {
        ...cur,
        isHls: true,
        type: "stream",
        format: "MP4",
        duration: dur >= 1 ? dur : undefined,
        segmentCount: info.segmentCount,
        encrypted: info.encrypted,
        isFmp4: true,
        height: inferredH >= 240 ? inferredH : cur.height,
        quality: qLab || cur.quality
      });
      map.set(url, { ...cur, ...updated, foundAt: cur.foundAt, id: cur.id, tabId });
    }
    updateBadge(tabId);
    broadcastUpdate(tabId);
  } catch {
    /* keep URL for download */
  }
}

function filterDisplayable(map) {
  let items = [...map.values()].filter((i) => {
    if (!i?.url) return false;
    if (Naming.isJunkMedia(i)) return false;
    if (i.type === "segment") return false;
    if (
      !i.isHls &&
      i.type !== "stream" &&
      (i.duration === 0 || (typeof i.duration === "number" && i.duration > 0 && i.duration < 8))
    ) {
      return false;
    }
    if (i.type === "audio" || i.type === "video" || i.type === "stream" || i.isHls) return true;
    if (/\.(mp4|webm|m3u8|mp3|m4a)(\?|$|#)/i.test(i.url)) return true;
    if (i.url.startsWith("blob:")) return true;
    return false;
  });

  const hasReal = items.some(
    (i) =>
      !i.url.startsWith("blob:") &&
      (i.isHls || i.type === "stream" || /\.(mp4|webm|m3u8)(\?|$|#)/i.test(i.url) || i.type === "video")
  );
  if (hasReal) items = items.filter((i) => !i.url.startsWith("blob:"));

  items = items.map((i) => enrichItem(i.tabId, i));

  const score = (x) => {
    let s = Naming.mediaScore(x);
    if ((x.url || "").startsWith("blob:")) s -= 300;
    if (/\.m3u8/i.test(x.url || "")) s += 450;
    if (x.source === "script-sniff" && /\.m3u8/i.test(x.url || "")) s += 150;
    if (x.duration && x.duration > 60) s += 80;
    return s;
  };
  items.sort((a, b) => score(b) - score(a));

  // One main item per page
  return items[0] ? [items[0]] : [];
}

function updateBadge(tabId) {
  chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
  // Social pages always show download cue
  chrome.tabs
    .get(tabId)
    .then((tab) => {
      if (tab?.url && needsYtDlpHelper(tab.url, tab.url)) {
        updateSocialBadge(tabId, tab.url);
        return;
      }
      return getMediaForTabAsync(tabId).then((items) => {
        const count = items?.length || 0;
        chrome.action.setBadgeText({
          tabId,
          text: count > 0 ? String(count) : ""
        });
      });
    })
    .catch(() => {
      const map = tabMedia.get(tabId);
      const count = map ? filterDisplayable(map).length : 0;
      chrome.action.setBadgeText({
        tabId,
        text: count > 0 ? String(count) : ""
      });
    });
}

function broadcastUpdate(tabId) {
  // Must include YT/TT placeholders — sync getMediaForTab() is empty on those sites
  getMediaForTabAsync(tabId)
    .then((items) => {
      chrome.runtime
        .sendMessage({
          type: "MEDIA_UPDATED",
          tabId,
          items: items || []
        })
        .catch(() => {});
    })
    .catch(() => {
      chrome.runtime
        .sendMessage({
          type: "MEDIA_UPDATED",
          tabId,
          items: getMediaForTab(tabId)
        })
        .catch(() => {});
    });
}

function getMediaForTab(tabId) {
  const map = tabMedia.get(tabId);
  if (!map) return [];
  return filterDisplayable(map);
}

/**
 * For YouTube/TikTok: if no stream captured yet, still expose a page-level download item.
 */
async function getMediaForTabAsync(tabId, hint = {}) {
  let items = getMediaForTab(tabId);
  const pageUrl = hint.pageUrl || "";
  const titleHint = hint.title || "";

  // Prefer explicit pageUrl from popup (more reliable than tabs.get alone)
  if (
    pageUrl &&
    /^https?:/i.test(pageUrl) &&
    (isYoutubeUrl(pageUrl) ||
      isInstagramPostUrl(pageUrl) ||
      isXUrl(pageUrl) ||
      isFacebookUrl(pageUrl) ||
      isBilibiliUrl(pageUrl))
  ) {
    const placeholder = makeSitePlaceholder({
      id: tabId,
      url: pageUrl,
      title: titleHint
    });
    if (placeholder) return [placeholder];
  }
  // TikTok with pageUrl: keep CDN items if any, else placeholder
  if (pageUrl && /^https?:/i.test(pageUrl) && isTiktokUrl(pageUrl)) {
    const cdn = (items || []).find(
      (i) =>
        i?.url &&
        /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(i.url)
    );
    if (cdn) return [cdn];
    const placeholder = makeSitePlaceholder({
      id: tabId,
      url: pageUrl,
      title: titleHint
    });
    if (placeholder) return [placeholder];
  }

  if (tabId == null) return items;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || tab?.pendingUrl || pageUrl;
    if (!url || !/^https?:/i.test(url)) return items;
    // Social / hard sites: always page-level yt-dlp item
    // TikTok: prefer captured CDN/page play URL when present (yt-dlp often IP-blocked)
    if (
      isYoutubeUrl(url) ||
      isInstagramPostUrl(url) ||
      isXUrl(url) ||
      isFacebookUrl(url) ||
      isBilibiliUrl(url)
    ) {
      const placeholder = makeSitePlaceholder({
        id: tab.id,
        url,
        title: tab.title || titleHint
      });
      return placeholder ? [placeholder] : items;
    }
    if (isTiktokUrl(url)) {
      const cdn = (items || []).find(
        (i) =>
          i?.url &&
          /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(i.url) &&
          !/tiktok\.com\/@|tiktok\.com\/t\//i.test(i.url)
      );
      if (cdn) {
        return [
          enrichItem(tab.id, {
            ...cdn,
            site: "tiktok",
            isSiteDownload: false,
            pageUrl: url,
            title: cdn.title || tab.title || titleHint
          })
        ];
      }
      const placeholder = makeSitePlaceholder({
        id: tab.id,
        url,
        title: tab.title || titleHint
      });
      return placeholder ? [placeholder] : items;
    }
  } catch (e) {
    console.warn("[UVD] getMediaForTabAsync", e);
    if (pageUrl && needsYtDlpHelper(pageUrl, pageUrl)) {
      const placeholder = makeSitePlaceholder({
        id: tabId,
        url: pageUrl,
        title: titleHint
      });
      if (placeholder) return [placeholder];
    }
  }
  return items;
}

/**
 * Collect browser cookies for a site so yt-dlp can use the logged-in session.
 * Critical for TikTok / Instagram (login walls).
 */
async function collectCookiesForUrl(pageUrl) {
  if (!pageUrl || !chrome.cookies?.getAll) return [];
  try {
    const u = new URL(pageUrl);
    const hosts = new Set([u.hostname, u.hostname.replace(/^www\./, "")]);
    const base = u.hostname.replace(/^www\./, "");
    hosts.add(base);
    hosts.add(`.${base}`);
    if (/tiktok/i.test(base)) {
      [
        "tiktok.com",
        ".tiktok.com",
        "www.tiktok.com",
        "m.tiktok.com",
        "www.tiktokv.com",
        ".tiktokv.com"
      ].forEach((h) => hosts.add(h));
    }
    if (/youtube|youtu\.be/i.test(base)) {
      ["youtube.com", ".youtube.com", "www.youtube.com", ".youtube.co.kr"].forEach((h) =>
        hosts.add(h)
      );
    }
    if (/instagram|instagr\.am/i.test(base)) {
      [
        "instagram.com",
        ".instagram.com",
        "www.instagram.com",
        "cdninstagram.com",
        ".cdninstagram.com"
      ].forEach((h) => hosts.add(h));
    }
    if (/x\.com|twitter\.com|t\.co/i.test(base) || /x\.com|twitter/i.test(pageUrl)) {
      [
        "x.com",
        ".x.com",
        "twitter.com",
        ".twitter.com",
        "www.twitter.com",
        "mobile.twitter.com",
        "api.x.com"
      ].forEach((h) => hosts.add(h));
    }
    if (/facebook|fb\.watch|fb\.com/i.test(base) || /facebook/i.test(pageUrl)) {
      [
        "facebook.com",
        ".facebook.com",
        "www.facebook.com",
        "m.facebook.com",
        "fb.com",
        ".fb.com",
        "fb.watch"
      ].forEach((h) => hosts.add(h));
    }
    if (/bilibili|b23\.tv/i.test(base) || /bilibili/i.test(pageUrl)) {
      [
        "bilibili.com",
        ".bilibili.com",
        "www.bilibili.com",
        "m.bilibili.com",
        "b23.tv",
        ".bilibili.tv"
      ].forEach((h) => hosts.add(h));
    }
    const byKey = new Map();
    for (const host of hosts) {
      try {
        const list = await chrome.cookies.getAll({ domain: host });
        for (const c of list || []) {
          if (!c?.name) continue;
          byKey.set(`${c.domain}|${c.path}|${c.name}`, c);
        }
      } catch {
        /* ignore per-domain */
      }
    }
    try {
      const list = await chrome.cookies.getAll({ url: pageUrl });
      for (const c of list || []) {
        if (!c?.name) continue;
        byKey.set(`${c.domain}|${c.path}|${c.name}`, c);
      }
    } catch {
      /* ignore */
    }
    return [...byKey.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || "",
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expirationDate: c.expirationDate || 0
    }));
  } catch {
    return [];
  }
}

async function getCookieHeaderForUrl(pageUrl) {
  const list = await collectCookiesForUrl(pageUrl);
  if (!list.length) return "";
  // Prefer unique by name (last wins)
  const map = new Map();
  for (const c of list) map.set(c.name, c.value);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Normalize Instagram share URLs for yt-dlp */
function normalizeInstagramUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    // instagr.am → instagram.com
    if (/instagr\.am$/i.test(u.hostname)) {
      u.hostname = "www.instagram.com";
    }
    // /reels/ → /reel/
    u.pathname = u.pathname.replace(/\/reels\//i, "/reel/");
    // drop tracking query/hash
    u.search = "";
    u.hash = "";
    // ensure trailing slash (yt-dlp happier)
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return String(raw || "").trim();
  }
}

/**
 * Collect candidate TikTok media URLs (page JSON + network capture).
 */
async function collectTikTokMediaUrls(tabId, pageUrl) {
  const urls = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || typeof u !== "string" || !u.startsWith("http")) return;
    if (/tiktok\.com\/@|tiktok\.com\/t\//i.test(u) && !isTiktokCdnUrl(u)) return;
    if (!isTiktokCdnUrl(u) && !/mime_type=video|\/video\/tos\//i.test(u)) return;
    const key = u.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(u);
  };

  if (tabId != null) {
    try {
      await ensureContentScripts(tabId);
      const ext = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TIKTOK" }),
        5000,
        "extract"
      );
      for (const u of ext?.urls || []) push(u);
    } catch {
      /* ignore */
    }
    const map = tabMedia.get(tabId);
    if (map) {
      for (const item of map.values()) push(item.url);
    }
  }
  return urls;
}

/**
 * Download one media URL using extension privileges (cookies + referer).
 * SnapTik-class tools ultimately need a direct CDN link — we fetch it here.
 */
async function downloadDirectMediaUrl(tabId, mediaUrl, pageUrl, filename) {
  if (!looksLikeVideoFileUrl(mediaUrl)) {
    throw new Error("영상 파일이 아닌 주소입니다");
  }
  const name = safeDownloadName(filename || `tiktok_${Date.now()}.mp4`, "video/mp4");

  // ONLY save after verifying real video bytes — never chrome.downloads raw URL
  // (that path was saving .js / .bmp "unusable files")
  const blob = await withTabReferer(tabId, async () => {
    const res = await fetch(mediaUrl, {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "video/mp4,video/*,*/*;q=0.8",
        Referer: pageUrl || "https://www.tiktok.com/"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (
      ctype.includes("javascript") ||
      ctype.includes("text/html") ||
      ctype.includes("text/css") ||
      ctype.includes("application/json") ||
      ctype.includes("image/")
    ) {
      throw new Error(`영상이 아닌 응답 (${ctype || "unknown"})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100_000) {
      throw new Error(`파일이 너무 작음 (${Math.round(buf.byteLength / 1024)}KB)`);
    }
    const head = new Uint8Array(buf.slice(0, 16));
    if (!sniffIsVideo(head)) {
      throw new Error("영상 바이너리가 아닙니다 (이미지/기타 파일 제외)");
    }
    return new Blob([buf], { type: ctype.startsWith("video/") ? ctype : "video/mp4" });
  });

  if (!blob || blob.size < 100_000) return null;
  const saved = await downloadBlob(blob, name);
  return { ok: true, ...saved, method: "tiktok-fetch-blob" };
}

/**
 * TikTok: prefer link-based helper (SnapTik style). Avoid scraping CDN covers/images.
 * Page hooks are disabled on TikTok so the site player keeps working.
 */
async function downloadTikTok(
  tabId,
  pageUrl,
  filename,
  preferQuality,
  jobId = null,
  forceOpts = {}
) {
  const jid = jobId || currentJobContext;
  const targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : "";
  if (!targetPage) throw new Error("TikTok 페이지 주소가 없습니다");
  if (!isTiktokUrl(targetPage) && !/vm\.tiktok\.com|vt\.tiktok\.com/i.test(targetPage)) {
    throw new Error("TikTok 영상 링크가 아닙니다");
  }

  emitDownloadProgress(tabId, 8, "TikTok 링크로 받는 중…", "start", jid);

  const helperUp = await YtDlp.available().catch(() => false);
  if (!helperUp) {
    throw new Error(
      "TikTok은 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
    );
  }

  const cookieHeader = await getCookieHeaderForUrl(targetPage);

  // Optional: only use page CDN if it passes strict video checks (never covers/bmp)
  let mediaUrl;
  try {
    const urls = (await collectTikTokMediaUrls(tabId, targetPage)).filter(looksLikeVideoFileUrl);
    mediaUrl = urls[0];
  } catch {
    mediaUrl = undefined;
  }

  try {
    const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
    const nameHint = ytdlpFilenameHint(filename);
    const result = await YtDlp.downloadAndWait(
      {
        url: targetPage,
        pageUrl: targetPage,
        filename: nameHint || undefined,
        title: nameHint || undefined,
        quality: preferQuality || "best",
        site: "tiktok",
        cookieHeader: cookieHeader || undefined,
        // only pass if looks like real video path
        mediaUrl: mediaUrl && looksLikeVideoFileUrl(mediaUrl) ? mediaUrl : undefined,
        ...extra
      },
      (p) => {
        throwIfJobStopped(jid);
        if (p.helperJobId && jid) {
          const job = activeDownloads.get(jid);
          if (job) job.helperJobId = p.helperJobId;
        }
        let message = p.message || "받는 중…";
        if (/\[download\]/i.test(message)) {
          message = `받는 중… ${Math.round(p.percent || 0)}%`;
        }
        if (/TikTok 링크 해석|공개 API|tikwm|직접/i.test(message)) {
          message = message.slice(0, 80);
        }
        if (/IP address is blocked|blocked from accessing/i.test(message)) {
          message = "TikTok 접근이 막혔습니다. 링크 붙여넣기로 다시 시도해 주세요";
        }
        const pct = Math.min(98, Math.max(2, Number(p.percent) || 10));
        emitDownloadProgress(tabId, pct, message, "download", jid);
      },
      15 * 60 * 1000
    );
    emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
    return {
      ok: true,
      method: result.method || "yt-dlp",
      downloadId: null,
      ytdlp: true,
      path: result.path || result.outDir || "",
      outDir: result.outDir || "",
      filename: result.filename || filename,
      size: result.size || 0
    };
  } catch (e) {
    const msg = String(e?.message || e);
    throw new Error(
      /TikTok|재생|링크|막혔|도우미/i.test(msg)
        ? msg
        : `TikTok 다운로드 실패. 공유 링크를 복사해 위 「영상 링크 붙여넣기」에 넣고 받아 주세요. (${msg.slice(0, 60)})`
    );
  }
}

async function downloadViaYtDlp(
  tabId,
  url,
  pageUrl,
  filename,
  preferQuality,
  jobId = null,
  forceOpts = {}
) {
  const jid = jobId || currentJobContext;
  const targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : url;
  const kind = siteKind(url, targetPage);

  // Dedicated TikTok pipeline
  if (kind === "tiktok") {
    return downloadTikTok(tabId, targetPage, filename, preferQuality, jid, forceOpts);
  }

  // Instagram: try captured CDN video first, then yt-dlp + cookies
  if (kind === "instagram") {
    return downloadInstagram(tabId, targetPage, filename, preferQuality, jid, forceOpts);
  }

  const available = await YtDlp.available();
  if (!available) {
    throw new Error(
      "소셜 사이트 받기에는 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
    );
  }

  const labelMap = {
    youtube: "YouTube",
    x: "X",
    facebook: "Facebook",
    bilibili: "Bilibili"
  };
  const label = labelMap[kind] || "영상";
  emitDownloadProgress(tabId, 4, `${label} 준비 중…`, "start", jid);

  const cookieHeader = await getCookieHeaderForUrl(targetPage);
  // X / Facebook / Bilibili often need logged-in session cookies
  let cookiesList;
  if (kind === "x" || kind === "facebook" || kind === "bilibili") {
    cookiesList = await collectCookiesForUrl(targetPage);
    if (cookiesList?.length) {
      emitDownloadProgress(
        tabId,
        5,
        `${label} 받는 중… (쿠키 ${cookiesList.length}개)`,
        "start",
        jid
      );
    }
  }
  const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
  if (extra.audioOnly) {
    emitDownloadProgress(tabId, 5, "오디오만 추출 중…", "start", jid);
  } else if (extra.writeSubs) {
    emitDownloadProgress(tabId, 5, "영상+자막 받는 중…", "start", jid);
  }

  const nameHint = ytdlpFilenameHint(filename);
  const result = await YtDlp.downloadAndWait(
    {
      url: targetPage,
      pageUrl: targetPage,
      // Only force name when readable — otherwise yt-dlp uses real video title
      filename: nameHint || undefined,
      title: nameHint || undefined,
      quality: preferQuality || "best",
      site: kind || undefined,
      cookieHeader: cookieHeader || undefined,
      cookiesList: cookiesList?.length ? cookiesList : undefined,
      ...extra
    },
    (p) => {
      throwIfJobStopped(jid);
      if (p.helperJobId && jid) {
        const job = activeDownloads.get(jid);
        if (job) job.helperJobId = p.helperJobId;
      }
      let message = p.message || "받는 중…";
      // Prefer helper's already-localized message (includes multi-stage text)
      if (/Merging|Merger|합치/i.test(message)) {
        message = "파일 합치는 중… (시간이 걸릴 수 있어요)";
      } else if (/추가 트랙|단계/.test(message)) {
        /* keep */
      } else if (/\[download\]/i.test(message) && !/받는 중/.test(message)) {
        message = `받는 중… ${Math.round(p.percent || 0)}%`;
      } else if (/Destination|Writing|subtitle|마무리/i.test(message) && !/받는 중|합치|트랙/.test(message)) {
        message = "마무리 중…";
      }
      if (/ERROR/i.test(message)) message = message.slice(0, 120);
      // Cap under 99 until job fully completes (avoids "stuck at 99")
      const pct = Math.min(98, Math.max(2, Number(p.percent) || 10));
      emitDownloadProgress(tabId, pct, message, p.status || "download", jid);
    },
    40 * 60 * 1000
  );

  emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
  return {
    ok: true,
    method: "yt-dlp",
    downloadId: null,
    ytdlp: true,
    path: result.path || result.outDir || "",
    outDir: result.outDir || "",
    filename: result.filename || nameHint || filename,
    size: result.size || 0
  };
}

/**
 * Instagram: yt-dlp + browser cookies (login required for many posts).
 * Also try direct CDN mp4 captured while watching.
 */
async function downloadInstagram(
  tabId,
  pageUrl,
  filename,
  preferQuality,
  jobId = null,
  forceOpts = {}
) {
  const jid = jobId || currentJobContext;
  let targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : "";
  targetPage = normalizeInstagramUrl(targetPage);
  if (!targetPage || !isInstagramUrl(targetPage)) {
    throw new Error(
      "Instagram 게시물 링크가 아닙니다. /p/… 또는 /reel/… 주소를 붙여 넣어 주세요"
    );
  }

  emitDownloadProgress(tabId, 5, "Instagram 준비 중…", "start", jid);

  // 1) Direct CDN while viewing (must be real video bytes)
  if (tabId != null) {
    try {
      await ensureContentScripts(tabId);
      await chrome.tabs.sendMessage(tabId, { type: "SCAN_NOW" }).catch(() => {});
      await chrome.tabs
        .sendMessage(tabId, { type: "EXTRACT_INSTAGRAM" })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400));
    const map = tabMedia.get(tabId);
    if (map) {
      const cdns = [...map.values()]
        .map((i) => i.url)
        .filter((u) => isInstagramCdnUrl(u));
      for (const mediaUrl of cdns.slice(0, 5)) {
        try {
          emitDownloadProgress(tabId, 18, "재생 스트림 저장 중…", "download", jid);
          const saved = await downloadDirectMediaUrl(
            tabId,
            mediaUrl,
            targetPage,
            filename
          );
          if (saved?.ok || saved?.downloadId != null) {
            emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
            return {
              ok: true,
              downloadId: saved.downloadId ?? null,
              path: saved.path || "",
              filename: saved.filename || filename,
              size: saved.size || 0,
              method: saved.method || "instagram-cdn",
              ytdlp: false
            };
          }
        } catch (e) {
          console.warn("[UVD] instagram CDN", e);
        }
      }
    }
  }

  // 2) yt-dlp + full browser cookie jar (Netscape file on helper side)
  const helperUp = await YtDlp.available().catch(() => false);
  if (!helperUp) {
    throw new Error(
      "Instagram은 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
    );
  }

  const cookiesList = await collectCookiesForUrl("https://www.instagram.com/");
  const cookieHeader = await getCookieHeaderForUrl("https://www.instagram.com/");
  if (!cookiesList.length) {
    throw new Error(
      "Instagram 로그인 쿠키가 없습니다. Chrome에서 instagram.com 에 로그인한 뒤 다시 시도해 주세요"
    );
  }

  emitDownloadProgress(
    tabId,
    28,
    `Instagram 받는 중… (쿠키 ${cookiesList.length}개)`,
    "download",
    jid
  );

  try {
    const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
    const nameHint = ytdlpFilenameHint(filename);
    const result = await YtDlp.downloadAndWait(
      {
        url: targetPage,
        pageUrl: targetPage,
        filename: nameHint || undefined,
        title: nameHint || undefined,
        quality: preferQuality || "best",
        site: "instagram",
        cookieHeader: cookieHeader || undefined,
        cookiesList,
        ...extra
      },
      (p) => {
        throwIfJobStopped(jid);
        if (p.helperJobId && jid) {
          const job = activeDownloads.get(jid);
          if (job) job.helperJobId = p.helperJobId;
        }
        let message = p.message || "받는 중…";
        if (/\[download\]/i.test(message)) {
          message = `받는 중… ${Math.round(p.percent || 0)}%`;
        }
        if (/login|log in|not logged|empty media|rate-limit|403|400/i.test(message)) {
          message =
            "Instagram 인증 문제 — 브라우저에서 로그인·새로고침 후 링크를 다시 붙여 넣어 주세요";
        }
        const pct = Math.min(98, Math.max(2, Number(p.percent) || 28));
        emitDownloadProgress(tabId, pct, message, "download", jid);
      },
      20 * 60 * 1000
    );
    emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
    return {
      ok: true,
      method: result.method || "yt-dlp",
      downloadId: null,
      ytdlp: true,
      path: result.path || result.outDir || "",
      outDir: result.outDir || "",
      filename: result.filename || filename,
      size: result.size || 0
    };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/login|cookie|empty media|not granting|400|403|rate/i.test(msg)) {
      throw new Error(
        "Instagram 다운로드 실패. ① Chrome에서 로그인 ② 게시물/릴스를 한 번 열기 ③ 공유 링크를 다시 붙여 넣기"
      );
    }
    throw new Error(
      /Instagram|로그인|도우미/i.test(msg)
        ? msg
        : `Instagram 다운로드 실패: ${msg.slice(0, 80)}`
    );
  }
}

function bestNonBlobAlternative(tabId, excludeUrl) {
  const map = tabMedia.get(tabId);
  if (!map) return null;
  const items = [...map.values()].filter(
    (i) => i.url && i.url !== excludeUrl && !i.url.startsWith("blob:") && !Naming.isJunkMedia(i)
  );
  items.sort((a, b) => {
    const hs = (x) => (/\.m3u8/i.test(x.url || "") ? 500 : 0) + Naming.mediaScore(x);
    return hs(b) - hs(a);
  });
  return items[0] || null;
}

// ─── network capture ───────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method && details.method !== "GET" && details.method !== "HEAD") return;
    const headers = details.responseHeaders || [];
    const contentType =
      headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    const contentLength = parseInt(
      headers.find((h) => h.name.toLowerCase() === "content-length")?.value || "0",
      10
    );
    if (!isLikelyMedia(details.url, contentType, contentLength)) return;
    const { type } = classifyMedia(details.url, contentType);
    addMedia(details.tabId, {
      url: details.url,
      type,
      source: "network",
      mime: contentType.split(";")[0].trim(),
      size: contentLength || undefined
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "media" || isLikelyMedia(details.url)) {
      if (/doubleclick|googlesyndication/i.test(details.url)) return;
      const { type } = classifyMedia(details.url);
      addMedia(details.tabId, { url: details.url, type, source: "network" });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] }
);

// ─── tabs ──────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  // Downloads keep running — only detach job from this tab
  detachJobsFromTab(tabId);
  tabMedia.delete(tabId);
  tabMeta.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    try {
      const prev = tabMeta.get(tabId)?.lastUrl || "";
      const next = changeInfo.url;
      const prevKey = tabMeta.get(tabId)?.pageKey || pageIdentityKey(prev);
      const nextKey = pageIdentityKey(next);
      // Also compare full path (non-SPA sites)
      const prevPath = prev ? new URL(prev).origin + new URL(prev).pathname : "";
      const nextPath = new URL(next).origin + new URL(next).pathname;
      const sameVideo =
        prevKey && nextKey ? prevKey === nextKey : prevPath && prevPath === nextPath;

      if (sameVideo) {
        // Same video, only query noise (e.g. t= timestamp) — keep media, update url
        setTabMeta(tabId, { lastUrl: next, pageKey: nextKey || prevKey });
      } else {
        // Different video/page: clear media + stale thumbnail (jobs keep running)
        detachJobsFromTab(tabId);
        clearTabMediaState(tabId, { keepLastUrl: next });
        setTabMeta(tabId, {
          lastUrl: next,
          pageKey: nextKey,
          title: undefined,
          thumbnail: undefined,
          host: (() => {
            try {
              return new URL(next).hostname;
            } catch {
              return undefined;
            }
          })()
        });
      }
      updateSocialBadge(tabId, next);
    } catch {
      detachJobsFromTab(tabId);
      clearTabMediaState(tabId);
      updateBadge(tabId);
    }
  } else if (changeInfo.status === "complete" && tab?.url) {
    setTabMeta(tabId, {
      lastUrl: tab.url,
      pageKey: pageIdentityKey(tab.url),
      title: Naming.cleanPageTitle(tab.title || "") || undefined,
      host: (() => {
        try {
          return new URL(tab.url).hostname;
        } catch {
          return undefined;
        }
      })()
    });
    updateSocialBadge(tabId, tab.url);
  }
  if (changeInfo.title) {
    const t = Naming.cleanPageTitle(changeInfo.title);
    if (t && !Naming.isUglyBase(t)) {
      setTabMeta(tabId, { title: t });
      const map = tabMedia.get(tabId);
      if (map) {
        for (const [url, item] of map) {
          if (!item.title || Naming.isUglyBase(item.title)) {
            map.set(url, {
              ...item,
              title: t,
              pageTitle: t,
              filename: Naming.buildFilename({
                title: t,
                pageTitle: t,
                quality: item.quality,
                type: item.type,
                isHls: item.isHls,
                isFmp4: true
              }),
              displayName: Naming.displayTitle({ title: t, pageTitle: t })
            });
          }
        }
        broadcastUpdate(tabId);
      }
    }
  }
});

// ─── context menus ─────────────────────────────────────────

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "uvd-download-media",
      title: "이 미디어 다운로드",
      contexts: ["video", "audio"]
    });
    chrome.contextMenus.create({
      id: "uvd-download-best",
      title: "이 페이지 영상 다운로드",
      contexts: ["page", "frame"]
    });
    chrome.contextMenus.create({
      id: "uvd-download-link",
      title: "이 링크 영상 다운로드",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "uvd-download-selection",
      title: "선택한 링크로 영상 다운로드",
      contexts: ["selection"]
    });
  });
}
chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);
setupContextMenus();

function sameVideoPage(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const ha = ua.hostname.replace(/^www\./i, "").toLowerCase();
    const hb = ub.hostname.replace(/^www\./i, "").toLowerCase();
    if (ha !== hb) return false;
    const pa = (ua.pathname || "/").replace(/\/+$/, "") || "/";
    const pb = (ub.pathname || "/").replace(/\/+$/, "") || "/";
    return pa === pb;
  } catch {
    return a === b;
  }
}

async function waitTabComplete(tabId, timeoutMs = 45000) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.status === "complete") return;
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    const onUp = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      try {
        chrome.tabs.onUpdated.removeListener(onUp);
      } catch {
        /* ignore */
      }
    }
    chrome.tabs.onUpdated.addListener(onUp);
  });
}

/**
 * Find an open tab for pageUrl, or open one in the background.
 * @returns {Promise<{ tabId: number, opened: boolean }>}
 */
async function findOrOpenTabForPage(pageUrl, preferredTabId) {
  if (preferredTabId != null && preferredTabId >= 0) {
    try {
      const t = await chrome.tabs.get(preferredTabId);
      if (t?.url && sameVideoPage(t.url, pageUrl)) {
        return { tabId: preferredTabId, opened: false };
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t?.id != null && t.url && sameVideoPage(t.url, pageUrl)) {
        return { tabId: t.id, opened: false };
      }
    }
  } catch {
    /* ignore */
  }
  const tab = await chrome.tabs.create({ url: pageUrl, active: false });
  if (tab?.id == null) throw new Error("페이지 탭을 열 수 없습니다");
  emitDownloadProgress(
    tab.id,
    4,
    "영상 페이지 여는 중…",
    "start",
    currentJobContext
  );
  await waitTabComplete(tab.id, 50000);
  // Give player/scripts time to register m3u8 (123av / missav style)
  await new Promise((r) => setTimeout(r, 1500));
  return { tabId: tab.id, opened: true };
}

/**
 * @param {number} tabId
 * @param {string} pageUrl
 * @param {string} [preferQuality]
 * @param {string|null} [jobId]
 * @param {{ mediaMode?: string, preferQuality?: string, mediaUrl?: string, title?: string }} [forceOpts]
 */
async function downloadPageFromUi(
  tabId,
  pageUrl,
  preferQuality = "best",
  jobId = null,
  forceOpts = {}
) {
  const jid = jobId || currentJobContext;
  if (!pageUrl || !/^https?:/i.test(pageUrl)) {
    throw new Error("받을 페이지 주소가 없습니다");
  }
  const kind = siteKind(pageUrl, pageUrl);
  const settings = await UVD.getSettings();
  const mediaMode = forceOpts.mediaMode || settings.mediaMode || "video";
  const quality = forceOpts.preferQuality || preferQuality || "best";

  // Job may already have a locked name from SERIES / popup — always prefer it.
  // Do NOT use the currently focused tab's title when forceOpts.title / job
  // already identify a different video (series / watchlist / multi-queue).
  const jobSnap = jid ? activeDownloads.get(jid) : null;
  let fname = "";
  try {
    fname = lockSaveName({
      filenameHint: jobSnap?.filename || forceOpts.filename || "",
      title:
        forceOpts.title ||
        jobSnap?.title ||
        "",
      pageTitle: forceOpts.title || jobSnap?.title || "",
      quality,
      mediaMode,
      pageUrl,
      seriesKey: jobSnap?.seriesKey || "",
      playlistTitle: jobSnap?.seriesTitle || "",
      seriesIndex: jobSnap?.seriesIndex || 0
    });
    // Only if still empty: use tab title when it matches THIS pageUrl
    if (!fname && tabId != null && tabId >= 0) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url && sameVideoPage(tab.url, pageUrl)) {
          const tabTitle = Naming.cleanPageTitle(tab.title || "") || "";
          fname = lockSaveName({
            title: tabTitle,
            quality,
            mediaMode,
            pageUrl
          });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    fname = "";
  }
  if (jid && fname) {
    const job = activeDownloads.get(jid);
    if (job && (!job.filename || UVD.isGenericSaveName(job.filename))) {
      job.filename = fname;
    }
  }

  // Social sites → dedicated yt-dlp path
  if (kind) {
    return downloadViaYtDlp(
      tabId,
      pageUrl,
      pageUrl,
      fname || undefined,
      quality,
      jid,
      { mediaMode }
    );
  }

  // ── Generic sites (123av, missav, jable, …) ──
  // Need the real page open so content script can sniff m3u8 / cookies work.
  let workTabId = tabId;
  let openedTab = false;
  let best = null;

  const tryScan = async (tid) => {
    if (tid == null || tid < 0) return null;
    try {
      await ensureContentScripts(tid);
    } catch {
      /* ignore */
    }
    try {
      await chrome.tabs.sendMessage(tid, { type: "SCAN_NOW" }).catch(() => {});
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 800));
    const items = await getMediaForTabAsync(tid, { pageUrl });
    return items?.[0] || null;
  };

  if (tabId != null && tabId >= 0) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t?.url && sameVideoPage(t.url, pageUrl)) {
        best = await tryScan(tabId);
        workTabId = tabId;
      }
    } catch {
      /* ignore */
    }
  }

  if (!best?.url) {
    emitDownloadProgress(
      tabId ?? -1,
      5,
      "영상 페이지에서 스트림 찾는 중…",
      "start",
      jid
    );
    const found = await findOrOpenTabForPage(pageUrl, tabId);
    workTabId = found.tabId;
    openedTab = found.opened;
    for (let i = 0; i < 4 && !best?.url; i++) {
      best = await tryScan(workTabId);
      if (!best?.url) await new Promise((r) => setTimeout(r, 900));
    }
  }

  if (!best?.url && forceOpts.mediaUrl && /^https?:/i.test(forceOpts.mediaUrl)) {
    best = {
      url: forceOpts.mediaUrl,
      type: /\.m3u8/i.test(forceOpts.mediaUrl) ? "stream" : "video",
      isHls: /\.m3u8/i.test(forceOpts.mediaUrl),
      pageUrl,
      title: forceOpts.title || "",
      filename: fname
    };
  }

  if (!best?.url) {
    if (openedTab && workTabId != null) {
      try {
        await chrome.tabs.remove(workTabId);
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      "감지된 영상이 없습니다. 해당 페이지를 연 뒤 재생을 한 번 시작하고 다시 「나중」에 추가하거나 받아 주세요"
    );
  }

  // Fill name only from THIS page's scan/title — never from a different focused tab
  if (!fname || UVD.isGenericSaveName(String(fname).replace(/\.[a-z0-9]+$/i, ""))) {
    let pageTitle = best?.title || best?.pageTitle || forceOpts.title || "";
    if ((!pageTitle || Naming.isUglyBase?.(pageTitle)) && workTabId != null) {
      try {
        const t = await chrome.tabs.get(workTabId);
        if (t?.url && sameVideoPage(t.url, pageUrl)) {
          pageTitle = Naming.cleanPageTitle(t.title || "") || pageTitle;
        }
      } catch {
        /* ignore */
      }
    }
    fname =
      lockSaveName({
        filenameHint: best?.filename || "",
        title: pageTitle,
        pageTitle,
        quality,
        mediaMode,
        pageUrl
      }) || fname;
  }
  if (jid && fname) {
    const job = activeDownloads.get(jid);
    if (job) {
      job.filename = fname;
      if (
        !job.title ||
        job.title === "영상" ||
        UVD.isGenericSaveName(job.title)
      ) {
        job.title = String(fname).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
      }
      job.updatedAt = Date.now();
      broadcastJob(job);
    }
  }

  // Bind item meta to locked name so HLS save won't re-title from another page
  const boundBest = {
    ...best,
    pageUrl,
    title: forceOpts.title || best.title || jobSnap?.title || "",
    pageTitle: forceOpts.title || best.pageTitle || best.title || "",
    filename: fname || best.filename
  };

  try {
    return await downloadSmart(
      workTabId,
      best.url,
      fname || best.filename,
      quality,
      mediaMode === "audio" ? "audio" : best.type || "video",
      boundBest,
      { pageUrl, jobId: jid, forceMediaMode: mediaMode }
    );
  } finally {
    if (openedTab && workTabId != null) {
      try {
        await new Promise((r) => setTimeout(r, 400));
        await chrome.tabs.remove(workTabId);
      } catch {
        /* ignore */
      }
    }
  }
}

function updateSocialBadge(tabId, url) {
  if (tabId == null) return;
  try {
    const social = !!(url && needsYtDlpHelper(url, url));
    if (social) {
      chrome.action.setBadgeText({ tabId, text: "↓" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" });
      chrome.action.setTitle({
        tabId,
        title: "이 페이지 영상 다운로드 가능"
      });
    } else {
      // keep media count badge from updateBadge if any
      const map = tabMedia.get(tabId);
      const count = map ? filterDisplayable(map).length : 0;
      chrome.action.setBadgeText({
        tabId,
        text: count > 0 ? String(count) : ""
      });
      chrome.action.setTitle({ tabId, title: "Video Downloader" });
    }
  } catch {
    /* ignore */
  }
}

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    updateSocialBadge(info.tabId, tab?.url);
  } catch {
    /* ignore */
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  if (tabId == null) return;
  try {
    if (info.menuItemId === "uvd-download-media" && info.srcUrl) {
      addMedia(tabId, {
        url: info.srcUrl,
        type: info.mediaType === "audio" ? "audio" : "video",
        source: "context-menu"
      });
      const item = getTabMap(tabId).get(info.srcUrl);
      const fname = resolveFilename(tabId, item || {}, info.srcUrl);
      await runTrackedDownloadAsync(
        {
          tabId,
          title: fname,
          pageUrl: tab.url,
          filename: fname
        },
        () =>
          downloadSmart(tabId, info.srcUrl, fname, "best", item?.type || "video", item, {
            pageUrl: tab.url
          })
      );
      return;
    }

    if (info.menuItemId === "uvd-download-link" && info.linkUrl) {
      await runTrackedDownloadAsync(
        {
          tabId,
          title: info.linkUrl,
          pageUrl: info.linkUrl,
          filename: "video.mp4"
        },
        () => downloadPageFromUi(tabId, info.linkUrl, "best")
      );
      return;
    }

    if (info.menuItemId === "uvd-download-selection" && info.selectionText) {
      const text = String(info.selectionText).trim();
      const m = text.match(/https?:\/\/[^\s]+/i);
      const link = m ? m[0] : text;
      if (!/^https?:\/\//i.test(link)) throw new Error("선택한 텍스트에 링크가 없습니다");
      await runTrackedDownloadAsync(
        { tabId, title: link, pageUrl: link, filename: "video.mp4" },
        () => downloadPageFromUi(tabId, link, "best")
      );
      return;
    }

    if (info.menuItemId === "uvd-download-best") {
      // Social page → dedicated download; else scan media list
      if (tab?.url && needsYtDlpHelper(tab.url, tab.url)) {
        await runTrackedDownloadAsync(
          {
            tabId,
            title: tab.title || tab.url,
            pageUrl: tab.url,
            filename: "video.mp4"
          },
          () => downloadPageFromUi(tabId, tab.url, "best")
        );
        return;
      }
      try {
        await chrome.tabs.sendMessage(tabId, { type: "SCAN_NOW" });
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 800));
      const best = (await getMediaForTabAsync(tabId, { pageUrl: tab?.url }))[0];
      if (!best) throw new Error("감지된 영상이 없습니다");
      await runTrackedDownloadAsync(
        {
          tabId,
          title: best.title || best.filename,
          pageUrl: tab.url,
          filename: best.filename || "video.mp4"
        },
        () =>
          downloadSmart(tabId, best.url, best.filename, "best", best.type, best, {
            pageUrl: tab.url
          })
      );
    }
  } catch (e) {
    console.warn("[UVD] context menu", e);
    try {
      chrome.notifications?.create?.({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "다운로드 실패",
        message: String(e?.message || e).slice(0, 120)
      });
    } catch {
      /* notifications optional */
    }
  }
});

// Keyboard shortcuts (popup closed — runs in service worker)
// Alt+Shift+D 현재 탭 영상
// Alt+Shift+A 오디오만
// Alt+Shift+B 최고 화질
chrome.commands?.onCommand?.addListener(async (command) => {
  const map = {
    "download-current-page": { label: "영상" },
    "download-audio-only": { mediaMode: "audio", preferQuality: "best", label: "오디오" },
    "download-best-quality": { mediaMode: "video", preferQuality: "best", label: "최고 화질" }
  };
  const force = map[command];
  if (!force) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("탭 없음");
    const settings = await UVD.getSettings();
    // Default always highest quality (shortcut B forces best too)
    const quality = force.preferQuality || "best";
    const mediaMode = force.mediaMode || settings.mediaMode || "video";
    const title =
      Naming.cleanPageTitle(tab.title || "") || tab.title || force.label || "영상";
    // Prefer human page title as save name (legacy readable style)
    const fname =
      (await buildSaveFilename({
        title,
        quality: quality === "best" ? "" : quality,
        pageUrl: tab.url,
        mediaMode
      })) || "";
    await runTrackedDownloadAsync(
      {
        tabId: tab.id,
        title,
        pageUrl: tab.url,
        filename: fname,
        mediaMode,
        quality,
        thumbnail: tabMeta.get(tab.id)?.thumbnail || ""
      },
      (jobId) =>
        downloadPageFromUi(tab.id, tab.url, quality, jobId, {
          mediaMode,
          preferQuality: quality
        })
    );
  } catch (e) {
    console.warn("[UVD] command download", command, e);
    try {
      if (chrome.notifications?.create) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "다운로드 실패",
          message: String(e?.message || e).slice(0, 120)
        });
      }
    } catch {
      /* ignore */
    }
  }
});

// ─── downloads ─────────────────────────────────────────────

/** Refcounted keep-alive so concurrent jobs don't kill SW early */
function startKeepAlive() {
  keepAliveRefs += 1;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      try {
        chrome.runtime.getPlatformInfo(() => {});
      } catch {
        /* ignore */
      }
    }, 2000);
  }
  try {
    chrome.alarms.create("uvd-dl-keepalive", { periodInMinutes: 0.5 });
  } catch {
    /* ignore */
  }
  return true;
}

function stopKeepAlive(_token) {
  keepAliveRefs = Math.max(0, keepAliveRefs - 1);
  if (keepAliveRefs === 0) {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    try {
      chrome.alarms.clear("uvd-dl-keepalive");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run a download tied to a durable job. Survives popup close & page leave.
 * @param {object} meta
 * @param {() => Promise<object>} asyncFn
 * @param {(r: object) => void} sendResponse
 */
function settleTrackedJob(jobId, result, err) {
  const job = activeDownloads.get(jobId);
  const msg = String(err?.message || err || "");
  if (job?.pauseRequested || /PAUSED/i.test(msg)) {
    finalizePausedJob(jobId);
    return;
  }
  if (job?.cancelRequested || /CANCELLED|사용자가 취소/i.test(msg)) {
    finishCancelledJob(jobId);
    return;
  }
  if (err) finishDownloadJob(jobId, null, err);
  else finishDownloadJob(jobId, result, null);
}

function runTrackedDownload(meta, asyncFn, sendResponse) {
  const jobId = createDownloadJob(meta);
  const keep = startKeepAlive();
  // Immediate ack so popup can show the new row before work finishes
  try {
    sendResponse({
      ok: true,
      started: true,
      jobId,
      background: true,
      concurrent: [...activeDownloads.values()].filter((j) => j.status === "running").length
    });
  } catch {
    /* ignore — popup may be gone; job still runs */
  }
  Promise.resolve()
    .then(() => withJobContext(jobId, () => asyncFn(jobId)))
    .then((r) => {
      settleTrackedJob(jobId, r, null);
      stopKeepAlive(keep);
    })
    .catch((err) => {
      settleTrackedJob(jobId, null, err);
      stopKeepAlive(keep);
    });
  return true;
}

/** Same as runTrackedDownload but awaitable (context menu / commands) */
async function runTrackedDownloadAsync(meta, asyncFn) {
  const jobId = createDownloadJob(meta);
  const keep = startKeepAlive();
  try {
    const r = await withJobContext(jobId, () => asyncFn(jobId));
    settleTrackedJob(jobId, r, null);
    return r;
  } catch (err) {
    settleTrackedJob(jobId, null, err);
    throw err;
  } finally {
    stopKeepAlive(keep);
  }
}

function startChromeDownload(url, filename) {
  return new Promise((resolve, reject) => {
    // Chrome requires a relative path (optional subfolder) with a valid basename
    let fname = String(filename || "").trim();
    if (!fname || fname.startsWith("/") || fname.includes("..")) {
      fname = safeDownloadName(`영상_${Date.now()}.mp4`);
    }
    // If path has folders, sanitize only the leaf
    if (fname.includes("/") || fname.includes("\\")) {
      const parts = fname.replace(/\\/g, "/").split("/").filter(Boolean);
      const leaf = safeDownloadName(parts.pop() || `영상_${Date.now()}.mp4`);
      const dirs = parts
        .map((p) =>
          String(p)
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
            .trim()
        )
        .filter((p) => p && p !== "." && p !== "..");
      fname = [...dirs, leaf].join("/");
    } else {
      fname = safeDownloadName(fname);
    }
    chrome.downloads.download(
      {
        url,
        filename: fname,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          const err = chrome.runtime.lastError?.message || "다운로드 시작 실패";
          // Retry once with a plain safe name (invalid path / restricted chars)
          if (/invalid|filename|path|name/i.test(err) && fname.includes("/")) {
            chrome.downloads.download(
              {
                url,
                filename: safeDownloadName(fname.split("/").pop()),
                saveAs: false,
                conflictAction: "uniquify"
              },
              (id2) => {
                if (chrome.runtime.lastError || id2 == null) {
                  reject(
                    new Error(
                      chrome.runtime.lastError?.message ||
                        err ||
                        "다운로드 시작 실패"
                    )
                  );
                } else {
                  resolve(id2);
                }
              }
            );
            return;
          }
          reject(new Error(err));
        } else {
          resolve(id);
        }
      }
    );
  });
}

/**
 * Wait until Chrome reports complete.
 * CRITICAL: never treat "in_progress" as success for blob/data URLs —
 * if we stop keepAlive early, SW dies and the download is interrupted.
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @param {{ onProgress?: (p:{bytesReceived:number,totalBytes:number})=>void }} [opts]
 */
function waitDownloadComplete(downloadId, timeoutMs = 180000, opts = {}) {
  const onProgress = opts.onProgress || null;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {
        /* ignore */
      }
      fn(v);
    };

    const reportWrite = (item) => {
      if (!onProgress || !item) return;
      try {
        onProgress({
          bytesReceived: item.bytesReceived || 0,
          totalBytes: item.totalBytes > 0 ? item.totalBytes : item.fileSize || 0
        });
      } catch {
        /* ignore */
      }
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        finish(resolve, { state: "complete", downloadId });
      } else if (delta.state?.current === "interrupted") {
        const code = delta.error?.current || "";
        finish(
          reject,
          new Error(
            code === "USER_CANCELED"
              ? "다운로드가 취소되었습니다"
              : code
                ? `다운로드 중단 (${code})`
                : "다운로드가 중단되었습니다"
          )
        );
      } else if (
        delta.bytesReceived ||
        delta.totalBytes ||
        delta.fileSize
      ) {
        // Live write progress while Chrome flushes the blob
        chrome.downloads
          .search({ id: downloadId })
          .then(([item]) => reportWrite(item))
          .catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const poll = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
        if (item.state === "in_progress") {
          reportWrite(item);
        }
        if (item.state === "complete") {
          finish(resolve, {
            state: "complete",
            downloadId,
            path: item.filename,
            bytesReceived: item.bytesReceived
          });
        } else if (item.state === "interrupted") {
          finish(
            reject,
            new Error(
              item.error
                ? `다운로드 중단 (${item.error})`
                : "다운로드가 중단되었습니다"
            )
          );
        }
        // Do NOT resolve on in_progress — blob URL would die with SW
      } catch {
        /* ignore */
      }
    }, 500);

    const timer = setTimeout(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.state === "complete") {
          finish(resolve, {
            state: "complete",
            downloadId,
            path: item.filename,
            bytesReceived: item.bytesReceived
          });
        } else if (item?.state === "in_progress" && (item.bytesReceived || 0) > 0) {
          // Still writing after long wait — accept only if substantial progress
          // and keep the blob URL alive a bit longer outside this promise.
          finish(resolve, {
            state: "in_progress",
            downloadId,
            path: item.filename,
            bytesReceived: item.bytesReceived,
            partial: true
          });
        } else {
          finish(
            reject,
            new Error("다운로드가 완료되지 않았습니다. chrome://downloads 를 확인해 주세요")
          );
        }
      } catch {
        finish(reject, new Error("다운로드 상태 확인 실패"));
      }
    }, timeoutMs);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader 실패"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Save via service worker blob URL.
 * Keep SW alive and do not revoke until chrome.downloads reports complete.
 * @param {Blob} blob
 * @param {string} name
 * @param {{ onProgress?: Function }} [opts]
 */
async function downloadBlobViaServiceWorker(blob, name, opts = {}) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("이 Chrome 버전에서는 blob 저장을 지원하지 않습니다");
  }
  const objectUrl = URL.createObjectURL(blob);
  // Large files need long wait; never clear keepAlive before this returns
  const timeoutMs = Math.min(45 * 60 * 1000, Math.max(180_000, blob.size / 8));
  const saveStartedAt = Date.now();
  // Blob: downloads often report 0 bytes until complete — pulse time-based progress
  let pulse = null;
  if (opts.onProgress) {
    pulse = setInterval(() => {
      try {
        opts.onProgress({
          bytesReceived: 0,
          totalBytes: 0,
          _elapsed: Date.now() - saveStartedAt,
          _blobSize: blob.size
        });
      } catch {
        /* ignore */
      }
    }, 500);
  }
  try {
    let id;
    try {
      id = await startChromeDownload(objectUrl, await relDownloadPath(name));
    } catch (e1) {
      // Some Chrome builds reject subfolder paths
      try {
        id = await startChromeDownload(objectUrl, name);
      } catch (e2) {
        throw new Error(e2?.message || e1?.message || "다운로드 시작 실패");
      }
    }
    const done = await waitDownloadComplete(id, timeoutMs, {
      onProgress: (p) => {
        opts.onProgress?.({
          bytesReceived: p.bytesReceived || 0,
          totalBytes: p.totalBytes > 0 ? p.totalBytes : blob.size
        });
      }
    });

    // Resolve path from downloads API
    let path = done.path || "";
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item?.filename) path = item.filename;
    } catch {
      /* ignore */
    }

    // Keep URL alive until Chrome finished reading bytes
    const revokeDelay =
      done.state === "complete" ? 30_000 : done.partial ? 15 * 60_000 : 60_000;
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
    }, revokeDelay);

    if (id == null) throw new Error("다운로드 ID 없음");
    return {
      downloadId: id,
      filename: name,
      path,
      state: done.state || "complete",
      size: blob.size,
      partial: !!done.partial
    };
  } catch (e) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    if (pulse) {
      try {
        clearInterval(pulse);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Small-file fallback: data: URL (no offscreen, no IDB).
 */
async function downloadBlobViaDataUrl(blob, name) {
  if (blob.size > 15 * 1024 * 1024) {
    throw new Error("파일이 커서 data URL 저장 불가");
  }
  const dataUrl = await blobToDataUrl(blob);
  let id;
  try {
    id = await startChromeDownload(dataUrl, await relDownloadPath(name));
  } catch {
    id = await startChromeDownload(dataUrl, name);
  }
  const done = await waitDownloadComplete(
    id,
    Math.min(10 * 60 * 1000, Math.max(90_000, blob.size / 8))
  );
  let path = done.path || "";
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item?.filename) path = item.filename;
  } catch {
    /* ignore */
  }
  return {
    downloadId: id,
    filename: name,
    path,
    state: done.state || "complete",
    size: blob.size
  };
}

const IDB_NAME = "uvd-blobs";
const IDB_STORE = "blobs";

function openBlobDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 열기 실패"));
  });
}

async function idbPutBlob(key, blob) {
  const db = await openBlobDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB 저장 실패"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB 중단"));
    });
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

async function idbDeleteBlob(key) {
  try {
    const db = await openBlobDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Fallback: short-lived extension page owns the blob URL (no offscreen API).
 */
async function downloadBlobViaTab(blob, name) {
  const key = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await idbPutBlob(key, blob);

  const pageUrl = chrome.runtime.getURL(
    `src/save.html?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`
  );
  const tab = await chrome.tabs.create({ url: pageUrl, active: false });

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("저장 페이지 시간 초과"));
      }, Math.min(20 * 60 * 1000, Math.max(180_000, blob.size / 8)));

      function onMsg(msg, sender, sendResponse) {
        if (msg?.type !== "SAVE_PAGE_DONE" || msg.key !== key) return false;
        cleanup();
        try {
          sendResponse({ ok: true });
        } catch {
          /* ignore */
        }
        if (msg.ok && msg.downloadId != null) resolve(msg);
        else reject(new Error(msg.error || "저장 페이지 실패"));
        return true;
      }
      function cleanup() {
        clearTimeout(timeout);
        try {
          chrome.runtime.onMessage.removeListener(onMsg);
        } catch {
          /* ignore */
        }
      }
      chrome.runtime.onMessage.addListener(onMsg);
    });

    return {
      downloadId: result.downloadId,
      filename: result.filename || name,
      path: result.path || "",
      state: result.state || "complete",
      size: blob.size
    };
  } finally {
    await idbDeleteBlob(key);
    try {
      if (tab?.id != null) await chrome.tabs.remove(tab.id);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Save blob to Downloads/VideoDownloader/.
 * Prefer SW path (no offscreen). Keep SW alive until Chrome finishes.
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ onProgress?: Function }} [opts]
 */
async function downloadBlob(blob, filename, opts = {}) {
  if (!blob?.size) throw new Error("빈 파일은 저장할 수 없습니다");
  if (blob.size < 100_000) {
    throw new Error(`파일이 너무 작습니다 (${Math.round(blob.size / 1024)}KB)`);
  }

  const name = safeDownloadName(filename || `영상_${Date.now()}.mp4`, blob.type || "video/mp4");
  const keep = startKeepAlive();
  const errors = [];

  try {
    // 1) Service worker blob URL (main path — no offscreen)
    try {
      const saved = await downloadBlobViaServiceWorker(blob, name, opts);
      if (saved.downloadId != null) return saved;
      errors.push("다운로드 ID 없음");
    } catch (e) {
      errors.push(String(e?.message || e));
      console.warn("[UVD] SW blob save failed", e);
    }

    // 2) data URL for smaller files
    if (blob.size <= 15 * 1024 * 1024) {
      try {
        const saved = await downloadBlobViaDataUrl(blob, name);
        if (saved.downloadId != null) return saved;
      } catch (e) {
        errors.push(String(e?.message || e));
      }
    }

    // 3) Hidden extension tab (owns document + blob URL)
    try {
      const saved = await downloadBlobViaTab(blob, name);
      if (saved.downloadId != null) return saved;
    } catch (e) {
      errors.push(String(e?.message || e));
      console.warn("[UVD] tab save failed", e);
    }

    const detail = errors.filter(Boolean).slice(0, 2).join(" / ");
    throw new Error(
      detail
        ? `파일 저장 실패: ${detail}`
        : "파일 저장 실패. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요"
    );
  } finally {
    stopKeepAlive(keep);
  }
}

async function downloadMedia(url, filename) {
  if (!url) throw new Error("받을 주소가 없습니다");
  if (url.startsWith("blob:")) throw new Error("이 형식은 바로 받을 수 없습니다");
  if (/\.m3u8(\?|$|#)/i.test(url) || /\.mpd(\?|$|#)/i.test(url)) {
    throw new Error("스트리밍 영상은 조각을 합쳐야 합니다");
  }
  const name = safeDownloadName(filename || filenameFromUrl(url), "video/mp4");
  let id;
  try {
    id = await startChromeDownload(url, await relDownloadPath(name));
  } catch {
    id = await startChromeDownload(url, name);
  }
  const done = await waitDownloadComplete(id, 60000);
  return {
    downloadId: id,
    filename: name,
    path: done.path,
    state: done.state
  };
}

/**
 * Attach page Referer to extension network requests while fn() runs.
 * Uses a unique DNR rule id so concurrent downloads don't clobber each other.
 * Prefer NOT forcing Origin — many CDNs return 403 when Origin ≠ expected.
 * @param {number|null} tabId
 * @param {() => Promise<any>} fn
 * @param {string} [pageUrlHint] page URL captured at download start
 */
async function withTabReferer(tabId, fn, pageUrlHint = "") {
  let pageUrl = pageUrlHint || "";
  try {
    if (!pageUrl && tabId != null && tabId >= 0) {
      const tab = await chrome.tabs.get(tabId);
      pageUrl = tab.url || "";
    }
  } catch {
    /* ignore */
  }

  const ruleId =
    REFERER_RULE_BASE + ((nextRefererRuleId++ - REFERER_RULE_BASE) % MAX_REFERER_RULES);
  let ruleInstalled = false;

  if (pageUrl && chrome.declarativeNetRequest) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "Referer", operation: "set", value: pageUrl }
                // Do not force Origin — causes Segment HTTP 403 on many CDNs
              ]
            },
            condition: {
              urlFilter: "*",
              resourceTypes: [
                "xmlhttprequest",
                "media",
                "other",
                "sub_frame",
                "image",
                "object"
              ]
            }
          }
        ]
      });
      ruleInstalled = true;
    } catch (e) {
      console.warn("[UVD] DNR", e);
    }
  }

  try {
    return await fn(pageUrl);
  } finally {
    if (ruleInstalled) {
      try {
        await chrome.declarativeNetRequest?.updateSessionRules({
          removeRuleIds: [ruleId]
        });
      } catch {
        /* ignore */
      }
    }
  }
}

async function resolvePageUrl(tabId, fallback) {
  try {
    if (tabId != null && tabId >= 0) {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && /^https?:/i.test(tab.url)) return tab.url;
    }
  } catch {
    /* ignore */
  }
  return fallback || "";
}

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
  const jid = jobId || currentJobContext;
  const key = jid || tabId || -1;
  const pageUrl =
    pageUrlHint ||
    itemHint?.pageUrl ||
    (await resolvePageUrl(tabId, "")) ||
    "";

  // ── Lock save name NOW (before long download). ──
  // Tab title / media map may change if the user navigates or starts another video.
  const jobSnap = jid ? activeDownloads.get(jid) : null;
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
  const result = await HLS.downloadAndMerge(url, {
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
    onProgress: (p) => {
      stopCheck();
      // Absolute percent from phase + segment ratio (honest)
      setProg(p);
    }
  });

  if (!result.size || result.size < 100_000) {
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
  const saved = await downloadBlob(result.blob, name, {
    onProgress: (wp) => {
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
    }
  });
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

async function ensureContentScripts(tabId) {
  try {
    const ping = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" }),
      2500,
      "ping"
    );
    if (ping?.hasDownload) return;
  } catch {
    /* inject */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/hls-downloader.js", "src/page-download.js", "src/content.js"]
    });
  } catch (e) {
    console.warn("[UVD] inject", e);
  }
}

async function pageDownloadAllFrames(tabId, payload) {
  if (tabId == null || tabId < 0) return { ok: false, error: "탭 없음" };
  await ensureContentScripts(tabId);
  try {
    const r = await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "SMART_DOWNLOAD",
        ...payload,
        // So page-side HLS progress binds to the right queue row
        jobId: payload.jobId || currentJobContext || null,
        tabId
      }),
      25 * 60 * 1000,
      "다운로드 시간 초과"
    );
    if (r?.ok) return r;
    return { ok: false, error: r?.error || "페이지 다운로드 실패" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function downloadSmart(tabId, url, filename, preferQuality, mediaType, itemHint, options = {}) {
  if (!url) throw new Error("받을 주소가 없습니다");
  const errors = [];
  const jid = options.jobId || currentJobContext;
  const pageUrl =
    options.pageUrl || itemHint?.pageUrl || (await resolvePageUrl(tabId, ""));

  emitDownloadProgress(tabId, 3, "시작…", "start", jid);

  // YouTube / TikTok → local yt-dlp helper (primary)
  const forceHelper =
    options.preferYtDlp === true ||
    itemHint?.isSiteDownload ||
    itemHint?.site === "youtube" ||
    itemHint?.site === "tiktok" ||
    needsYtDlpHelper(url, pageUrl);

  if (forceHelper) {
    try {
      return await downloadViaYtDlp(
        tabId,
        url,
        pageUrl || url,
        filename,
        preferQuality,
        jid
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

  const hls = isRealHls(workUrl, workType);

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
              jid
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
        jobId: jid
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

    // Each attempt reports its own honest segment progress (with reset on retry)
    const attempts = tryPageFirst
      ? [
          { name: "page", run: () => runPageHls() },
          { name: "sw", run: () => runSwHls(true) }
        ]
      : [
          { name: "sw", run: () => runSwHls(false) },
          { name: "page", run: () => runPageHls() }
        ];

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
  try {
    const saved = await withTimeout(
      withTabReferer(tabId, () => downloadMedia(workUrl, filename)),
      90000,
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

// ─── messages ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handled by dedicated listeners (save page / legacy offscreen)
  if (
    msg?.type === "SAVE_PAGE_DONE" ||
    msg?.type === "OFFSCREEN_SAVE" ||
    msg?.type === "OFFSCREEN_SAVE_IDB" ||
    msg?.type === "OFFSCREEN_CHUNK" ||
    msg?.type === "OFFSCREEN_FINISH"
  ) {
    return false;
  }

  const tabId = msg.tabId ?? sender.tab?.id;

  switch (msg.type) {
    case "HLS_PROGRESS": {
      // Content-script / page-download progress → bind to the active job
      const p = msg.progress || {};
      const jid = p.jobId || msg.jobId || null;
      const tid = tabId ?? msg.tabId ?? sender.tab?.id ?? -1;
      // Drop progress for stopped jobs (prevents pause→running flicker)
      if (jid) {
        const j = activeDownloads.get(jid);
        if (j && jobIsStopping(j)) {
          sendResponse({ ok: true, stopped: true });
          break;
        }
      }
      const percent =
        typeof p.percent === "number"
          ? Math.min(98, Math.max(0, p.percent))
          : hlsPhasePercent(p);
      const phase = p.phase || "download";
      const message =
        p.message ||
        (phase === "merge"
          ? "파일 만드는 중…"
          : phase === "save"
            ? "디스크에 저장 중…"
            : "받는 중…");
      try {
        emitDownloadProgress(tid, percent, message, phase, jid, {
          segmentCurrent: p.current,
          segmentTotal: p.total,
          bytesReceived: p.bytesReceived,
          totalBytes: p.bytesTotal
        });
      } catch {
        /* job cancelled / paused — expected */
      }
      sendResponse({ ok: true });
      break;
    }
    case "PAGE_META": {
      if (tabId != null && msg.pageMeta) {
        const pageUrl = msg.pageMeta.lastUrl || sender.tab?.url || msg.pageUrl || "";
        setTabMeta(tabId, {
          ...msg.pageMeta,
          lastUrl: pageUrl || msg.pageMeta.lastUrl,
          pageKey: pageUrl ? pageIdentityKey(pageUrl) : msg.pageMeta.pageKey
        });
      }
      sendResponse({ ok: true });
      break;
    }
    case "PAGE_MEDIA": {
      if (tabId == null) break;
      const pageUrl = sender.tab?.url || msg.pageUrl || "";
      if (msg.pageMeta) {
        setTabMeta(tabId, {
          ...msg.pageMeta,
          lastUrl: pageUrl || msg.pageMeta.lastUrl,
          pageKey: pageUrl ? pageIdentityKey(pageUrl) : undefined
        });
      } else if (pageUrl) {
        setTabMeta(tabId, { lastUrl: pageUrl, pageKey: pageIdentityKey(pageUrl) });
      }
      for (const item of msg.items || []) {
        addMedia(tabId, {
          ...item,
          source: item.source || "page",
          pageUrl
        });
      }
      sendResponse({ ok: true });
      break;
    }
    case "GET_MEDIA": {
      getMediaForTabAsync(msg.tabId, {
        pageUrl: msg.pageUrl || "",
        title: msg.title || ""
      })
        .then((items) => sendResponse({ items: items || [] }))
        .catch((e) => {
          console.warn("[UVD] GET_MEDIA", e);
          // Last-resort placeholder from message fields
          if (msg.pageUrl && needsYtDlpHelper(msg.pageUrl, msg.pageUrl)) {
            const ph = makeSitePlaceholder({
              id: msg.tabId,
              url: msg.pageUrl,
              title: msg.title || ""
            });
            sendResponse({ items: ph ? [ph] : [] });
          } else {
            sendResponse({ items: getMediaForTab(msg.tabId) });
          }
        });
      return true;
    }
    case "YTDLP_HEALTH": {
      YtDlp.health(!!msg.force)
        .then((h) => sendResponse({ ok: true, ...h }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "LIST_QUALITIES": {
      // Available qualities for current page / stream (YouTube via yt-dlp, HLS via probe)
      const url = msg.url || msg.pageUrl || "";
      const tid = msg.tabId ?? tabId;
      (async () => {
        try {
          if (!url) {
            sendResponse({ ok: false, error: "url 없음", qualities: [] });
            return;
          }

          /** Guess height from URL / NAME / path tokens */
          const heightFromStr = (s) => {
            if (typeof HLS?.heightFromString === "function") {
              return HLS.heightFromString(s) || 0;
            }
            const str = String(s || "");
            let m = str.match(
              /(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)/
            );
            if (m) return parseInt(m[1], 10);
            m = str.match(/[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i);
            if (m) return parseInt(m[1], 10);
            return 0;
          };

          /** Max known player/item height in this tab */
          const tabHintHeight = () => {
            if (tid == null) return 0;
            try {
              let maxH = 0;
              let lab = "";
              for (const it of getTabMap(tid).values()) {
                if (it?.height >= 240 && it.height > maxH) {
                  maxH = it.height;
                  lab = it.quality || qualityLabel(it.height) || "";
                } else if (
                  !maxH &&
                  it?.quality &&
                  !/^(best|all|unknown)$/i.test(String(it.quality))
                ) {
                  lab = it.quality;
                  const hm = String(it.quality).match(/(\d{3,4})/);
                  if (hm) maxH = parseInt(hm[1], 10) || 0;
                }
              }
              return { height: maxH, quality: lab };
            } catch {
              return { height: 0, quality: "" };
            }
          };

          /** Ask content script for <video>.videoHeight */
          const playerHint = async () => {
            if (tid == null || tid < 0) return { height: 0, quality: "" };
            try {
              const r = await chrome.tabs
                .sendMessage(tid, { type: "GET_PLAYER_HEIGHT" })
                .catch(() => null);
              const h = Number(r?.height) || 0;
              const q = String(r?.quality || "").trim();
              return {
                height: h >= 240 ? h : 0,
                quality:
                  q && !/^(best|all|unknown)$/i.test(q)
                    ? q
                    : qualityLabel(h) || ""
              };
            } catch {
              return { height: 0, quality: "" };
            }
          };

          // HLS master / media playlist
          if (/\.m3u8(\?|$|#)/i.test(url) || msg.mediaType === "stream") {
            try {
              const info = await withTabReferer(tid, () => HLS.probe(url));
              // Height from scanned item / message (player videoHeight)
              const itemHintH = Number(msg.itemHeight) || 0;
              const itemHintQ = String(msg.itemQuality || "").trim();
              const urlH = heightFromStr(url);
              const tabH = tabHintHeight();

              if (info?.kind === "master" && info.variants?.length) {
                const seen = new Set();
                const qualities = [];
                const order = [
                  "4K",
                  "1440p",
                  "1080p",
                  "720p",
                  "480p",
                  "360p",
                  "240p"
                ];
                const byLabel = new Map();
                // Infer height from bandwidth when RESOLUTION missing
                const heightFromBw = (bw) => {
                  const b = Number(bw) || 0;
                  if (b >= 8_000_000) return 2160;
                  if (b >= 4_000_000) return 1440;
                  if (b >= 2_000_000) return 1080;
                  if (b >= 1_000_000) return 720;
                  if (b >= 500_000) return 480;
                  if (b >= 250_000) return 360;
                  if (b > 0) return 240;
                  return 0;
                };
                for (const v of info.variants) {
                  let h = v.height || 0;
                  if (!h) {
                    h =
                      heightFromStr(v.name) ||
                      heightFromStr(v.url) ||
                      heightFromBw(v.estimateBandwidth || v.bandwidth);
                  }
                  const lab =
                    (v.quality && v.quality !== "unknown" && v.quality) ||
                    qualityLabel(h) ||
                    (h ? `${h}p` : null);
                  if (!lab || lab === "unknown") continue;
                  const estBw = v.estimateBandwidth || v.bandwidth || 0;
                  if (!byLabel.has(lab) || (byLabel.get(lab).height || 0) < h) {
                    byLabel.set(lab, {
                      id: lab,
                      label: lab,
                      height: h,
                      estimateBandwidth: estBw
                    });
                  }
                }
                let duration = 0;
                let estimatedSize = 0;
                try {
                  const mediaInfo = await withTabReferer(tid, () =>
                    HLS.probe(info.variants[0].url)
                  );
                  if (mediaInfo?.duration >= 1) duration = mediaInfo.duration;
                } catch {
                  /* ignore */
                }
                for (const [lab, q] of byLabel) {
                  const bw = q.estimateBandwidth || 0;
                  if (bw > 0 && duration >= 1) {
                    q.estimatedSize = Math.round((bw / 8) * duration);
                    q.approx = true;
                    const mb = q.estimatedSize / (1024 * 1024);
                    const sizeStr =
                      mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
                    q.label = `${lab} · ${sizeStr}`;
                  }
                }
                // Multiple variants → "최고" + each; single → only that chip (popup collapses)
                if (byLabel.size > 1) {
                  qualities.push({ id: "best", label: "최고" });
                }
                for (const lab of order) {
                  if (byLabel.has(lab) && !seen.has(lab)) {
                    qualities.push(byLabel.get(lab));
                    seen.add(lab);
                  }
                }
                for (const [lab, q] of byLabel) {
                  if (!seen.has(lab)) qualities.push(q);
                }
                const best =
                  byLabel.get(qualities.find((q) => q.id !== "best")?.id) ||
                  info.variants[0];
                const bw =
                  best?.estimateBandwidth ||
                  best?.bandwidth ||
                  info.variants[0]?.estimateBandwidth ||
                  0;
                if (bw > 0 && duration >= 1) {
                  estimatedSize = Math.round((bw / 8) * duration);
                  const bestChip = qualities.find((q) => q.id === "best");
                  if (bestChip) {
                    bestChip.estimatedSize = estimatedSize;
                    bestChip.height = best?.height || bestChip.height;
                    bestChip.approx = true;
                    const mb = estimatedSize / (1024 * 1024);
                    const sizeStr =
                      mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
                    bestChip.label = `최고 · ${sizeStr}`;
                  }
                }
                if (qualities.length) {
                  sendResponse({
                    ok: true,
                    qualities,
                    source: "hls",
                    duration: duration || 0,
                    estimatedSize: estimatedSize || 0
                  });
                  return;
                }
              }
              if (info?.kind === "media") {
                // Single media playlist — resolve concrete height for the chip
                let h =
                  itemHintH ||
                  urlH ||
                  Number(info.inferredHeight) ||
                  tabH.height ||
                  0;
                let lab =
                  (itemHintQ &&
                    !/^(best|all|unknown)$/i.test(itemHintQ) &&
                    itemHintQ) ||
                  qualityLabel(h) ||
                  tabH.quality ||
                  null;

                // Sample segment paths often encode quality when playlist name does not
                if (!lab && Array.isArray(info.sampleUrls)) {
                  for (const su of info.sampleUrls) {
                    const sh = heightFromStr(su);
                    if (sh >= 240) {
                      h = sh;
                      lab = qualityLabel(h);
                      break;
                    }
                  }
                }

                // Exact item in tab store
                if (!lab && tid != null) {
                  try {
                    const it = getTabMap(tid).get(url);
                    if (it?.height >= 240) {
                      h = it.height;
                      lab = qualityLabel(h);
                    } else if (
                      it?.quality &&
                      !/^(best|all|unknown)$/i.test(it.quality)
                    ) {
                      lab = it.quality;
                    }
                  } catch {
                    /* ignore */
                  }
                }

                // Live player dimensions (123av after play)
                if (!lab) {
                  const ph = await playerHint();
                  if (ph.height >= 240) {
                    h = ph.height;
                    lab = ph.quality || qualityLabel(h);
                  } else if (ph.quality) {
                    lab = ph.quality;
                  }
                }

                // Sibling master playlist may list RESOLUTION (…/playlist.m3u8 ↔ master)
                if (!lab) {
                  const candidates = [];
                  try {
                    const u = new URL(url);
                    const base = u.href.replace(/[^/]+$/, "");
                    for (const name of [
                      "master.m3u8",
                      "playlist.m3u8",
                      "index.m3u8",
                      "hls.m3u8"
                    ]) {
                      const cand = base + name;
                      if (cand !== url && !candidates.includes(cand)) {
                        candidates.push(cand);
                      }
                    }
                    // Parent dir master (…/720p/index.m3u8 → …/playlist.m3u8)
                    const parent = base.replace(/\/[^/]+\/$/, "/");
                    if (parent && parent !== base) {
                      for (const name of ["master.m3u8", "playlist.m3u8"]) {
                        const cand = parent + name;
                        if (!candidates.includes(cand)) candidates.push(cand);
                      }
                    }
                  } catch {
                    /* ignore */
                  }
                  for (const cand of candidates.slice(0, 4)) {
                    try {
                      const mi = await withTabReferer(tid, () => HLS.probe(cand));
                      if (mi?.kind === "master" && mi.variants?.length) {
                        const tops = mi.variants
                          .map((v) => v.height || heightFromStr(v.url) || 0)
                          .filter((x) => x >= 240);
                        if (tops.length) {
                          h = Math.max(...tops);
                          lab = qualityLabel(h);
                          break;
                        }
                        // Match current media URL to a variant
                        const match = mi.variants.find(
                          (v) =>
                            v.url === url ||
                            String(v.url).includes(
                              url.split("/").slice(-2).join("/")
                            )
                        );
                        if (match) {
                          h =
                            match.height ||
                            heightFromStr(match.url) ||
                            heightFromStr(match.name) ||
                            0;
                          if (h >= 240) {
                            lab = qualityLabel(h);
                            break;
                          }
                        }
                      }
                    } catch {
                      /* try next */
                    }
                  }
                }

                const duration = info.duration >= 1 ? info.duration : 0;
                if (lab) {
                  // Persist height on tab item so next open keeps it
                  if (tid != null && h >= 240) {
                    try {
                      const map = getTabMap(tid);
                      const cur = map.get(url);
                      if (cur && !(cur.height >= 240)) {
                        map.set(url, {
                          ...cur,
                          height: h,
                          quality: lab
                        });
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                  sendResponse({
                    ok: true,
                    qualities: [
                      {
                        id: lab,
                        label: lab,
                        height: h || undefined
                      }
                    ],
                    source: "hls-media",
                    duration,
                    estimatedSize: 0
                  });
                  return;
                }
                // Unknown height — still only one option; UI will show 최고
                sendResponse({
                  ok: true,
                  qualities: [{ id: "best", label: "최고" }],
                  source: "hls-media",
                  duration,
                  estimatedSize: 0
                });
                return;
              }
            } catch {
              /* fall through to ytdlp / empty */
            }
          }

          // YouTube / TikTok / hard sites
          if (needsYtDlpHelper(url, url) || msg.forceYtDlp) {
            const cookieHeader = await getCookieHeaderForUrl(url);
            const cookiesList = await collectCookiesForUrl(url);
            const data = await YtDlp.listFormats(url, {
              cookieHeader: cookieHeader || undefined,
              cookiesList: cookiesList?.length ? cookiesList : undefined,
              site: siteKind(url, url) || undefined
            });
            sendResponse({
              ok: true,
              qualities: data.qualities || [],
              heights: data.heights || [],
              title: data.title || "",
              duration: data.duration || 0,
              estimatedSize: data.estimatedSize || 0,
              thumbnail: data.thumbnail || "",
              source: "yt-dlp"
            });
            return;
          }

          // Unknown — only "best"
          sendResponse({
            ok: true,
            qualities: [{ id: "best", label: "최고" }],
            source: "default",
            duration: 0,
            estimatedSize: 0
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: String(e?.message || e),
            qualities: [{ id: "best", label: "최고" }]
          });
        }
      })();
      return true;
    }
    case "PROBE_PAGE_META": {
      // Scrape og:image / title + existence for product-code series (123av etc.)
      // Prefer content-script same-site fetch (cookies + less bot-like).
      (async () => {
        try {
          const url = String(msg.url || msg.pageUrl || "").trim();
          const expectedKey = String(msg.expectedKey || msg.key || "").trim();
          if (!url || !/^https?:/i.test(url)) {
            sendResponse({ ok: false, exists: false, error: "url 없음" });
            return;
          }
          // 1) Active tab content script when same host
          const probeTabId = tabId;
          if (probeTabId != null && probeTabId >= 0) {
            try {
              const tab = await chrome.tabs.get(probeTabId).catch(() => null);
              if (tab?.url) {
                const th = new URL(tab.url).hostname.replace(/^www\./, "");
                const uh = new URL(url).hostname.replace(/^www\./, "");
                if (
                  th &&
                  uh &&
                  (th === uh || th.endsWith("." + uh) || uh.endsWith("." + th))
                ) {
                  const r = await chrome.tabs
                    .sendMessage(probeTabId, {
                      type: "PROBE_PAGE_META",
                      url,
                      expectedKey,
                      key: expectedKey
                    })
                    .catch(() => null);
                  // Trust content result even when exists:false (don't fall through
                  // and falsely re-mark as ok via weak background scrape)
                  if (r && (r.ok || r.exists === false || r.error)) {
                    sendResponse({
                      ...r,
                      source: r.source || "content"
                    });
                    return;
                  }
                }
              }
            } catch {
              /* fall through */
            }
          }
          // 2) Background fetch fallback
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12000);
          let res;
          try {
            res = await fetch(url, {
              method: "GET",
              signal: ctrl.signal,
              credentials: "omit",
              redirect: "follow",
              headers: { Accept: "text/html,application/xhtml+xml" }
            });
          } finally {
            clearTimeout(timer);
          }
          const finalUrl = res.url || url;
          const status = res.status;
          if (!res.ok) {
            sendResponse({
              ok: false,
              exists: false,
              status,
              url,
              finalUrl,
              error: `HTTP ${status}`
            });
            return;
          }
          const html = await res.text();
          const pickMeta = (...pats) => {
            for (const re of pats) {
              const m = html.match(re);
              if (m?.[1]) return m[1].trim();
            }
            return "";
          };
          let thumb =
            pickMeta(
              /property=["']og:image(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i,
              /content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url|:url)?["']/i,
              /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
              /content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i,
              /rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
              /<video[^>]+poster=["']([^"']+)["']/i
            ) || "";
          if (!thumb) {
            const imgs = [
              ...html.matchAll(
                /<img[^>]+(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["'][^>]+src=["']([^"']+)["']/gi
              ),
              ...html.matchAll(
                /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["']/gi
              )
            ];
            for (const m of imgs) {
              const u = m[1];
              if (
                u &&
                !/\.svg(\?|$)/i.test(u) &&
                !/sprite|icon|logo|avatar|1x1|pixel/i.test(u)
              ) {
                thumb = u;
                break;
              }
            }
          }
          let title =
            pickMeta(
              /property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
              /content=["']([^"']+)["'][^>]*property=["']og:title["']/i,
              /<title[^>]*>([^<]{2,200})<\/title>/i
            ) || "";
          const dec = (s) =>
            String(s || "")
              .replace(/&amp;/g, "&")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'");
          thumb = dec(thumb);
          title = dec(title);
          if (thumb.startsWith("//")) {
            try {
              thumb = new URL(url).protocol + thumb;
            } catch {
              thumb = "https:" + thumb;
            }
          }
          if (thumb.startsWith("/")) {
            try {
              thumb = new URL(thumb, finalUrl || url).href;
            } catch {
              thumb = "";
            }
          }
          if (thumb && !/^https?:/i.test(thumb)) {
            try {
              thumb = new URL(thumb, finalUrl || url).href;
            } catch {
              thumb = "";
            }
          }
          const bodySample = html.slice(0, 8000);
          const blocked =
            /just a moment|cf-browser-verification|attention required|checking your browser|enable javascript|access denied|captcha/i.test(
              title + " " + bodySample
            );
          const notFound =
            /not\s*found|404|페이지를\s*찾을|존재하지\s*않|no\s*results?|검색\s*결과\s*없|video\s*not\s*found|deleted|removed/i.test(
              title + " " + bodySample
            );
          const isSearch =
            /\/search/i.test(finalUrl) ||
            /[?&](q|keyword|query|search)=/i.test(finalUrl);
          const keyU = expectedKey.toUpperCase();
          const keyLoose = keyU.replace(/[-_\s]/g, "");
          const hay = `${title} ${finalUrl}`
            .toUpperCase()
            .replace(/[-_\s]/g, "");
          const keyInPage =
            !expectedKey ||
            (keyLoose.length >= 4 && hay.includes(keyLoose));
          const looksVideoPath =
            /\/(v|video|watch|dm\d*\/v|en\/v|ja\/v)\//i.test(finalUrl);
          let exists = !blocked && !notFound && !isSearch;
          if (exists && expectedKey && !keyInPage) {
            exists = looksVideoPath && !!thumb;
          }
          if (exists && expectedKey && keyLoose.length >= 5 && !keyInPage && !thumb) {
            exists = false;
          }
          sendResponse({
            ok: true,
            exists,
            status,
            url,
            finalUrl,
            thumbnail: thumb || "",
            title: title || "",
            keyInPage,
            isSearch,
            notFound,
            source: "background-fetch"
          });
        } catch (e) {
          sendResponse({
            ok: false,
            exists: false,
            error: String(e?.message || e || "probe failed")
          });
        }
      })();
      return true;
    }
    case "FETCH_THUMB": {
      // Privileged fetch → data URL (popup <img> often blocked by CDN/hotlink)
      (async () => {
        try {
          const url = String(msg.url || "").trim();
          if (!url) {
            sendResponse({ ok: false, error: "url 없음" });
            return;
          }
          if (url.startsWith("data:image/")) {
            sendResponse({ ok: true, dataUrl: url });
            return;
          }
          if (!/^https?:/i.test(url)) {
            sendResponse({ ok: false, error: "bad url" });
            return;
          }
          // Prefer page-context fetch when a same-site tab is available (123av CDN)
          const thumbTabId = tabId;
          if (thumbTabId != null && thumbTabId >= 0) {
            try {
              const tab = await chrome.tabs.get(thumbTabId).catch(() => null);
              if (tab?.url) {
                const th = new URL(tab.url).hostname.replace(/^www\./, "");
                let uh = "";
                try {
                  uh = new URL(url).hostname.replace(/^www\./, "");
                } catch {
                  uh = "";
                }
                // Same registrable-ish host or known related CDN under page site
                const sameSite =
                  th &&
                  uh &&
                  (th === uh ||
                    uh.endsWith(th) ||
                    th.endsWith(uh) ||
                    /123av|missav|jable|njav|netflav|surrit|javcdn|javplayer/i.test(
                      uh
                    ));
                if (sameSite) {
                  const r = await chrome.tabs
                    .sendMessage(thumbTabId, {
                      type: "FETCH_THUMB_PAGE",
                      url
                    })
                    .catch(() => null);
                  if (r?.ok && r.dataUrl) {
                    sendResponse({ ok: true, dataUrl: r.dataUrl, source: "page" });
                    return;
                  }
                }
              }
            } catch {
              /* fall through */
            }
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 10000);
          let res;
          try {
            res = await fetch(url, {
              method: "GET",
              signal: ctrl.signal,
              credentials: "omit",
              redirect: "follow",
              cache: "force-cache"
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            return;
          }
          const ctype = (res.headers.get("content-type") || "").toLowerCase();
          if (ctype && !ctype.startsWith("image/") && !ctype.includes("octet-stream")) {
            sendResponse({ ok: false, error: "not image" });
            return;
          }
          const buf = await res.arrayBuffer();
          if (!buf || buf.byteLength < 80 || buf.byteLength > 2_500_000) {
            sendResponse({ ok: false, error: "size" });
            return;
          }
          const bytes = new Uint8Array(buf);
          // Tiny 1×1 / tracking pixels
          if (buf.byteLength < 200 && ctype.includes("gif")) {
            sendResponse({ ok: false, error: "tiny" });
            return;
          }
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(
              null,
              bytes.subarray(i, i + chunk)
            );
          }
          const mime =
            ctype && ctype.startsWith("image/")
              ? ctype.split(";")[0]
              : "image/jpeg";
          const dataUrl = `data:${mime};base64,${btoa(binary)}`;
          sendResponse({ ok: true, dataUrl, bytes: buf.byteLength });
        } catch (e) {
          sendResponse({
            ok: false,
            error: String(e?.message || e || "fetch failed")
          });
        }
      })();
      return true;
    }
    case "LIST_PLAYLIST": {
      const pageUrl = msg.pageUrl || msg.url || "";
      if (!pageUrl || !/^https?:/i.test(pageUrl)) {
        sendResponse({ ok: false, error: "재생목록 주소가 없습니다", entries: [] });
        break;
      }
      (async () => {
        try {
          const up = await YtDlp.available().catch(() => false);
          if (!up) {
            sendResponse({
              ok: false,
              error: "로컬 도우미가 필요합니다",
              entries: []
            });
            return;
          }
          const cookieHeader = await getCookieHeaderForUrl(pageUrl);
          const cookiesList = await collectCookiesForUrl(pageUrl);
          const data = await YtDlp.listPlaylist(pageUrl, {
            cookieHeader: cookieHeader || undefined,
            cookiesList: cookiesList?.length ? cookiesList : undefined,
            max: msg.max || 200
          });
          sendResponse({
            ok: true,
            title: data.title || "재생목록",
            count: data.count || (data.entries || []).length,
            playlistCount: data.playlistCount || data.count || 0,
            entries: data.entries || [],
            url: pageUrl
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: String(e?.message || e),
            entries: []
          });
        }
      })();
      return true;
    }
    case "DOWNLOAD_PLAYLIST": {
      // Expand playlist to video URLs and start concurrent jobs
      const pageUrl = msg.pageUrl || msg.url || "";
      const tid = msg.tabId ?? tabId;
      const preferQuality = msg.preferQuality || "best";
      const maxN = Math.min(200, Math.max(1, Number(msg.max) || 50));
      (async () => {
        try {
          let entries = Array.isArray(msg.entries) ? msg.entries : [];
          if (!entries.length && pageUrl) {
            const cookieHeader = await getCookieHeaderForUrl(pageUrl);
            const cookiesList = await collectCookiesForUrl(pageUrl);
            const data = await YtDlp.listPlaylist(pageUrl, {
              cookieHeader: cookieHeader || undefined,
              cookiesList: cookiesList?.length ? cookiesList : undefined,
              max: maxN
            });
            entries = data.entries || [];
          }
          const urls = entries
            .map((e) => e.url || e.webpage_url || "")
            .filter((u) => /^https?:/i.test(u))
            .slice(0, maxN);
          if (!urls.length) {
            sendResponse({ ok: false, error: "재생목록에 받을 영상이 없습니다" });
            return;
          }
          const settings = await UVD.getSettings();
          const started = [];
          const plTitle = msg.title || "재생목록";
          let plSeriesId = msg.seriesId || "";
          if (!plSeriesId && pageUrl) {
            try {
              plSeriesId = `series:pl:${new URL(pageUrl).searchParams.get("list") || UVD.normalizeUrlKey(pageUrl)}`;
            } catch {
              plSeriesId = `series:pl:${Date.now()}`;
            }
          }
          const startOne = async (i) => {
            const videoUrl = urls[i];
            const entry = entries[i] || {};
            const title =
              entry.title ||
              `${plTitle} (${i + 1}/${urls.length})`;
            const sKey = entry.id || entry.key || "";
            const fname = await buildSaveFilename({
              title,
              quality: preferQuality,
              pageUrl: videoUrl,
              mediaMode: settings.mediaMode,
              playlistTitle: plTitle,
              seriesKey: sKey,
              seriesIndex: i + 1,
              seriesTotal: urls.length
            });
            const jobId = createDownloadJob({
              tabId: tid,
              title,
              pageUrl: videoUrl,
              filename: fname || "",
              mediaMode: settings.mediaMode,
              quality: preferQuality,
              thumbnail: entry.thumbnail || "",
              seriesId: plSeriesId,
              seriesKey: sKey,
              seriesIndex: i + 1,
              seriesTitle: plTitle,
              tags: ["series", "playlist", plSeriesId, sKey].filter(Boolean)
            });
            const keep = startKeepAlive();
            started.push({ jobId, url: videoUrl, title });
            withJobContext(jobId, () =>
              downloadViaYtDlp(
                tid,
                videoUrl,
                videoUrl,
                fname || undefined,
                preferQuality,
                jobId,
                { mediaMode: settings.mediaMode }
              )
            )
              .then((r) => {
                settleTrackedJob(jobId, r, null);
                stopKeepAlive(keep);
              })
              .catch((err) => {
                settleTrackedJob(jobId, null, err);
                stopKeepAlive(keep);
              });
          };
          for (let i = 0; i < urls.length; i++) {
            if (started.length >= MAX_CONCURRENT_STARTS_BG()) {
              break;
            }
            await startOne(i);
          }
          // Remaining videos beyond concurrent: fire more after a delay chain
          if (urls.length > started.length) {
            (async () => {
              for (let i = started.length; i < urls.length; i++) {
                while (
                  [...activeDownloads.values()].filter((j) => j.status === "running")
                    .length >= MAX_CONCURRENT_STARTS_BG()
                ) {
                  await new Promise((r) => setTimeout(r, 800));
                }
                await startOne(i);
              }
            })().catch(() => {});
          }
          sendResponse({
            ok: true,
            started: true,
            count: urls.length,
            concurrent: started.length,
            jobIds: started.map((x) => x.jobId),
            title: plTitle
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
    case "DOWNLOAD_PAGE": {
      // Download by page URL — social via yt-dlp, others open+scan (123av etc.)
      const tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || msg.url;
      if (!pageUrl) {
        sendResponse({ ok: false, error: "페이지 주소가 없습니다" });
        break;
      }
      if (!/^https?:\/\//i.test(pageUrl)) {
        sendResponse({ ok: false, error: "http(s) 링크만 가능합니다" });
        break;
      }
      (async () => {
        const settings = await UVD.getSettings();
        const displayTitle =
          (msg.title &&
            !UVD.isGenericSaveName(msg.title) &&
            (Naming.cleanPageTitle?.(msg.title) || msg.title)) ||
          "";
        const fname = lockSaveName({
          filenameHint: msg.filename || "",
          title: displayTitle || msg.title || "",
          pageTitle: displayTitle || msg.title || "",
          quality: msg.preferQuality,
          mediaMode: settings.mediaMode,
          pageUrl
        });
        const jobTitle =
          displayTitle ||
          (fname ? String(fname).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "") : "") ||
          "영상";
        runTrackedDownload(
          {
            tabId: tid,
            title: jobTitle,
            pageUrl,
            filename: fname || "",
            mediaMode: settings.mediaMode,
            quality: msg.preferQuality || "best"
          },
          async (jobId) => {
            const r = await downloadPageFromUi(
              tid,
              pageUrl,
              msg.preferQuality || "best",
              jobId,
              {
                mediaMode: settings.mediaMode,
                mediaUrl: msg.mediaUrl || "",
                title: msg.title || jobTitle,
                filename: fname || ""
              }
            );
            if (r?.ok === false) {
              throw new Error(r.error || "다운로드 실패");
            }
            return { ...r, filename: r.filename || fname };
          },
          sendResponse
        );
      })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_SETTINGS": {
      UVD.getSettings()
        .then((s) => sendResponse({ ok: true, settings: s }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "SET_SETTINGS": {
      UVD.setSettings(msg.settings || msg.patch || {})
        .then(async (s) => {
          try {
            await updateDownloadBadge();
          } catch {
            /* ignore */
          }
          sendResponse({ ok: true, settings: s });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_HISTORY": {
      UVD.getHistory()
        .then((history) => sendResponse({ ok: true, history }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "QUERY_LIBRARY": {
      UVD.queryLibrary(msg.query || msg.opts || {})
        .then((items) => sendResponse({ ok: true, items }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), items: [] }));
      return true;
    }
    case "UPDATE_HISTORY_ITEM": {
      UVD.updateHistoryItem(msg.id, msg.patch || {})
        .then((history) => sendResponse({ ok: true, history }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_SITE_PACKS": {
      UVD.getSitePacks()
        .then((packs) => sendResponse({ ok: true, packs }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "SET_SITE_PACKS": {
      UVD.setSitePacks(msg.packs || [])
        .then((packs) => sendResponse({ ok: true, packs }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "SERIES_COMPLETE": {
      // Queue selected entries (from UI preview) or auto-discover
      (async () => {
        try {
          const settings = await UVD.getSettings();
          const title = msg.title || "";
          const pageUrl = msg.pageUrl || msg.url || "";
          const count = Math.min(
            20,
            Math.max(1, Number(msg.count) || settings.seriesCompleteCount || 5)
          );
          const preferQuality = msg.preferQuality || "best";
          const explicit = Array.isArray(msg.entries)
            ? msg.entries.filter((e) => e && /^https?:/i.test(e.url || ""))
            : [];
          const forceMode = msg.mode || null;
          const info = UVD.extractSeriesInfo(title);
          const results = { mode: null, queued: 0, items: [] };

          const resolveSeriesId = () => {
            if (msg.seriesId) return String(msg.seriesId);
            if (forceMode === "product_code" || (!forceMode && info && !(
              UVD.isPlaylistOnlyUrl(pageUrl) || UVD.isWatchInPlaylistUrl(pageUrl)
            ))) {
              return `series:code:${info?.prefix || info?.key || "series"}`;
            }
            try {
              const list =
                new URL(pageUrl).searchParams.get("list") ||
                UVD.normalizeUrlKey(pageUrl) ||
                "unknown";
              return `series:pl:${list}`;
            } catch {
              return `series:${Date.now()}`;
            }
          };
          const seriesId = resolveSeriesId();
          const seriesTitle = msg.seriesTitle || title || "";

          const startPlaylistJobs = async (entries, plTitle) => {
            const started = [];
            const total = entries.length;
            for (let i = 0; i < entries.length; i++) {
              while (
                [...activeDownloads.values()].filter((j) => j.status === "running")
                  .length >= MAX_CONCURRENT_STARTS_BG()
              ) {
                await new Promise((r) => setTimeout(r, 600));
              }
              const entry = entries[i] || {};
              const videoUrl = entry.url;
              if (!videoUrl) continue;
              const t =
                entry.title ||
                `${plTitle || "시리즈"} (${i + 1}/${entries.length})`;
              const sIdx = entry.seriesIndex || i + 1;
              const sKey = entry.key || entry.id || entry.seriesKey || "";
              const fname = await buildSaveFilename({
                title: t,
                quality: preferQuality,
                pageUrl: videoUrl,
                mediaMode: settings.mediaMode,
                playlistTitle: plTitle || seriesTitle || "",
                seriesKey: sKey,
                seriesIndex: sIdx,
                seriesTotal: total
              });
              const jobId = createDownloadJob({
                tabId: msg.tabId ?? -1,
                title: t,
                pageUrl: videoUrl,
                filename: fname || "",
                mediaMode: settings.mediaMode,
                quality: preferQuality,
                thumbnail: entry.thumbnail || "",
                seriesId,
                seriesKey: sKey,
                seriesIndex: sIdx,
                seriesTitle: plTitle || seriesTitle || "",
                tags: ["series", "playlist", seriesId, sKey].filter(Boolean)
              });
              const keep = startKeepAlive();
              started.push(jobId);
              withJobContext(jobId, () =>
                downloadViaYtDlp(
                  msg.tabId ?? -1,
                  videoUrl,
                  videoUrl,
                  fname || undefined,
                  preferQuality,
                  jobId,
                  { mediaMode: settings.mediaMode }
                )
              )
                .then((r) => {
                  settleTrackedJob(jobId, r, null);
                  stopKeepAlive(keep);
                })
                .catch((err) => {
                  settleTrackedJob(jobId, null, err);
                  stopKeepAlive(keep);
                });
            }
            return started;
          };

          // Prefer explicit UI selection (user checked items in preview)
          if (explicit.length) {
            const asPlaylist =
              forceMode === "playlist" ||
              (!forceMode &&
                (UVD.isPlaylistOnlyUrl(pageUrl) ||
                  UVD.isWatchInPlaylistUrl(pageUrl)));
            if (asPlaylist) {
              results.mode = "playlist";
              results.seriesId = seriesId;
              results.items = explicit;
              const jobIds = await startPlaylistJobs(
                explicit,
                msg.seriesTitle || title
              );
              results.queued = jobIds.length;
              results.jobIds = jobIds;
              sendResponse({ ok: true, ...results });
              return;
            }
            // product codes → watchlist with exact selected URLs/titles
            results.mode = "product_code";
            results.seriesId = seriesId;
            for (const e of explicit) {
              await UVD.addWatchlist({
                url: e.url,
                pageUrl: e.url,
                title: e.title || e.key || "시리즈",
                quality: preferQuality,
                site: UVD.siteFromUrl(pageUrl) || UVD.siteFromUrl(e.url) || "",
                tags: ["series", info?.prefix, e.key, seriesId].filter(Boolean)
              });
              results.items.push(e);
              results.queued += 1;
            }
            sendResponse({ ok: true, ...results });
            return;
          }

          // 1) Playlist remainder (no explicit list)
          if (
            UVD.isPlaylistOnlyUrl(pageUrl) ||
            UVD.isWatchInPlaylistUrl(pageUrl)
          ) {
            let listUrl = pageUrl;
            if (UVD.isWatchInPlaylistUrl(pageUrl)) {
              try {
                const u = new URL(pageUrl);
                const listId = u.searchParams.get("list");
                if (listId) {
                  listUrl = `https://www.youtube.com/playlist?list=${listId}`;
                }
              } catch {
                /* ignore */
              }
            }
            const cookieHeader = await getCookieHeaderForUrl(listUrl);
            const cookiesList = await collectCookiesForUrl(listUrl);
            const data = await YtDlp.listPlaylist(listUrl, {
              cookieHeader: cookieHeader || undefined,
              cookiesList: cookiesList?.length ? cookiesList : undefined,
              max: 200
            });
            let entries = data.entries || [];
            const curKey = UVD.normalizeUrlKey(pageUrl);
            entries = entries.filter(
              (e) => UVD.normalizeUrlKey(e.url || "") !== curKey
            );
            if (UVD.isWatchInPlaylistUrl(pageUrl)) {
              try {
                const vid = new URL(pageUrl).searchParams.get("v");
                const idx = entries.findIndex(
                  (e) => e.id === vid || (e.url || "").includes(vid)
                );
                if (idx >= 0) entries = entries.slice(idx + 1);
              } catch {
                /* ignore */
              }
            }
            entries = entries.slice(0, count);
            results.mode = "playlist";
            results.seriesId = seriesId;
            results.items = entries;
            if (entries.length) {
              const jobIds = await startPlaylistJobs(
                entries,
                data.title || title
              );
              results.queued = jobIds.length;
              results.jobIds = jobIds;
            }
            sendResponse({ ok: true, ...results });
            return;
          }

          // 2) Product code series → watchlist
          if (info) {
            const nexts = UVD.nextSeriesKeys(info, count);
            let host = "";
            try {
              host = new URL(pageUrl).origin;
            } catch {
              host = "";
            }
            for (const n of nexts) {
              let nextUrl = "";
              if (pageUrl && info.key) {
                nextUrl = pageUrl.replace(
                  new RegExp(
                    info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
                    "i"
                  ),
                  n.key
                );
                if (nextUrl === pageUrl) {
                  nextUrl = pageUrl.replace(
                    new RegExp(`${info.prefix}[-_]?${info.num}`, "i"),
                    n.key
                  );
                }
              }
              if (!nextUrl || nextUrl === pageUrl) {
                if (host) {
                  nextUrl = `${host}/search?q=${encodeURIComponent(n.key)}`;
                } else {
                  nextUrl = `https://www.google.com/search?q=${encodeURIComponent(
                    n.key + " video"
                  )}`;
                }
              }
              await UVD.addWatchlist({
                url: nextUrl,
                pageUrl: nextUrl,
                title: n.label,
                quality: preferQuality,
                site: UVD.siteFromUrl(pageUrl) || "",
                tags: ["series", info.prefix, n.key, seriesId].filter(Boolean)
              });
              results.items.push({ key: n.key, url: nextUrl, title: n.label });
              results.queued += 1;
            }
            results.mode = "product_code";
            results.seriesId = seriesId;
            sendResponse({ ok: true, ...results });
            return;
          }

          sendResponse({
            ok: false,
            error:
              "시리즈 코드를 찾지 못했습니다. 재생목록 페이지이거나 제목에 SSIS-001 같은 품번이 있으면 동작합니다",
            ...results
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
    case "CLEAR_HISTORY": {
      UVD.clearHistory()
        .then(() => sendResponse({ ok: true, history: [] }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_RECENT_DONE": {
      UVD.getRecentDone(msg.limit || 3)
        .then((items) => sendResponse({ ok: true, items }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_WATCHLIST": {
      UVD.getWatchlist()
        .then((watchlist) => sendResponse({ ok: true, watchlist }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "ADD_WATCHLIST": {
      UVD.addWatchlist(msg.item || msg)
        .then((watchlist) => sendResponse({ ok: true, watchlist }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "REMOVE_WATCHLIST": {
      const rid = msg.id || msg.url || "";
      UVD.removeWatchlist(rid)
        .then(async (watchlist) => {
          if (rid) {
            try {
              await chrome.alarms.clear(`uvd-watch-${rid}`);
            } catch {
              /* ignore */
            }
          }
          sendResponse({ ok: true, watchlist });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "CLEAR_WATCHLIST": {
      UVD.clearWatchlist()
        .then(async () => {
          try {
            const all = await chrome.alarms.getAll();
            for (const a of all) {
              if (a.name.startsWith("uvd-watch-")) {
                await chrome.alarms.clear(a.name);
              }
            }
          } catch {
            /* ignore */
          }
          sendResponse({ ok: true, watchlist: [] });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "REORDER_WATCHLIST": {
      UVD.reorderWatchlist(msg.ids || msg.orderedIds || [])
        .then((watchlist) => sendResponse({ ok: true, watchlist }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "UPDATE_WATCHLIST_ITEM": {
      (async () => {
        const id = msg.id || "";
        const patch = msg.patch || {};
        const watchlist = await UVD.updateWatchlistItem(id, patch);
        // Schedule deferred download via chrome.alarms
        const alarmName = `uvd-watch-${id}`;
        try {
          await chrome.alarms.clear(alarmName);
        } catch {
          /* ignore */
        }
        const when = Number(patch.scheduleAt || 0);
        if (when > Date.now() + 15_000) {
          try {
            await chrome.alarms.create(alarmName, { when });
          } catch (e) {
            console.warn("[UVD] schedule alarm", e);
          }
        }
        sendResponse({ ok: true, watchlist });
      })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "CANCEL_DOWNLOAD": {
      cancelDownloadJob(msg.jobId || msg.id || "")
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "PAUSE_DOWNLOAD": {
      pauseDownloadJob(msg.jobId || msg.id || "")
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "RESUME_DOWNLOAD": {
      resumeDownloadJob(msg.jobId || msg.id || "")
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "REFRESH_BADGE": {
      updateDownloadBadge()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;
    }
    case "DOWNLOAD_HELPER_STARTER": {
      // Drop a double-clickable .command into Downloads for macOS users
      (async () => {
        try {
          const script = `#!/bin/bash
# Universal Video Downloader — local yt-dlp helper
# Double-click this file (or: chmod +x 후 실행)
set -e
PORT=8787
if curl -s --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
  osascript -e 'display notification "이미 실행 중입니다" with title "UVD Helper"' 2>/dev/null || true
  echo "Already running on :$PORT"
  exit 0
fi
if ! command -v yt-dlp >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then brew install yt-dlp
  elif command -v pip3 >/dev/null 2>&1; then pip3 install -U yt-dlp
  fi
fi
LOG_DIR="$HOME/Library/Logs/uvd-helper"
mkdir -p "$LOG_DIR" "$HOME/Downloads/VideoDownloader"
# Prefer repo helper if found next to common clone paths
for CAND in \\
  "$HOME/video-downloader-extension/helper/yt_dlp_server.py" \\
  "$HOME/Downloads/video-downloader-extension/helper/yt_dlp_server.py" \\
  "$HOME/Desktop/video-downloader-extension/helper/yt_dlp_server.py"
do
  if [ -f "$CAND" ]; then
    nohup /usr/bin/python3 "$CAND" >>"$LOG_DIR/uvd-helper.log" 2>>"$LOG_DIR/uvd-helper.err.log" &
    sleep 1
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok"'; then
      osascript -e 'display notification "도우미가 시작되었습니다" with title "UVD Helper"' 2>/dev/null || true
      echo "OK :$PORT"
      exit 0
    fi
  fi
done
# Fallback: tell user to run from extension folder
osascript -e 'display dialog "helper/yt_dlp_server.py 경로를 찾지 못했습니다.\\n확장 프로그램 폴더의 helper/start_background.command 를 실행해 주세요." buttons {"OK"}' 2>/dev/null || true
exit 1
`;
          const dataUrl =
            "data:application/x-sh;charset=utf-8," + encodeURIComponent(script);
          const downloadId = await new Promise((resolve, reject) => {
            chrome.downloads.download(
              {
                url: dataUrl,
                filename: "UVD-도우미-시작.command",
                saveAs: false,
                conflictAction: "uniquify"
              },
              (id) => {
                if (chrome.runtime.lastError || id == null) {
                  reject(
                    new Error(
                      chrome.runtime.lastError?.message || "다운로드 실패"
                    )
                  );
                } else resolve(id);
              }
            );
          });
          sendResponse({
            ok: true,
            downloadId,
            hint: "다운로드 폴더의 UVD-도우미-시작.command 를 더블클릭하세요 (처음엔 실행 권한 필요할 수 있음)"
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
    case "SHOW_DOWNLOAD": {
      (async () => {
        try {
          if (msg.downloadId != null) {
            chrome.downloads.show(msg.downloadId);
            sendResponse({ ok: true });
            return;
          }
          if (msg.path && typeof msg.path === "string") {
            // Search chrome downloads by filename
            const name = msg.path.split(/[/\\]/).pop();
            const items = await chrome.downloads.search({
              filenameRegex: name ? name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : undefined,
              limit: 5,
              orderBy: ["-startTime"]
            });
            if (items?.[0]?.id != null) {
              chrome.downloads.show(items[0].id);
              sendResponse({ ok: true });
              return;
            }
            chrome.downloads.showDefaultFolder?.();
            sendResponse({ ok: true, fallback: true });
            return;
          }
          chrome.downloads.showDefaultFolder?.();
          sendResponse({ ok: true, fallback: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
    case "OPEN_URL": {
      const u = msg.url;
      if (u && /^https?:/i.test(u)) {
        chrome.tabs.create({ url: u }).catch(() => {});
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "bad url" });
      }
      break;
    }
    case "DOWNLOAD_BATCH": {
      // Multi-link paste: start each URL as its own job
      const urls = Array.isArray(msg.urls)
        ? msg.urls
        : UVD.parseUrlsFromText(msg.text || "");
      const unique = [...new Set(urls.filter((u) => /^https?:/i.test(u)))];
      if (!unique.length) {
        sendResponse({ ok: false, error: "유효한 링크가 없습니다" });
        break;
      }
      const tid = msg.tabId ?? tabId;
      const preferQuality = msg.preferQuality || "best";
      (async () => {
        const settings = await UVD.getSettings();
        const started = [];
        for (const pageUrl of unique.slice(0, MAX_CONCURRENT_STARTS_BG())) {
          const fname = await buildSaveFilename({
            title: msg.title || UVD.siteFromUrl(pageUrl) || "영상",
            quality: preferQuality,
            pageUrl,
            mediaMode: settings.mediaMode
          });
          // fire each as tracked job without waiting on popup
          const jobId = createDownloadJob({
            tabId: tid,
            title: fname,
            pageUrl,
            filename: fname,
            mediaMode: settings.mediaMode,
            quality: preferQuality
          });
          const keep = startKeepAlive();
          started.push(jobId);
          withJobContext(jobId, () =>
            downloadPageFromUi(tid, pageUrl, preferQuality, jobId)
          )
            .then((r) => {
              finishDownloadJob(jobId, r, null);
              stopKeepAlive(keep);
            })
            .catch((err) => {
              finishDownloadJob(jobId, null, err);
              stopKeepAlive(keep);
            });
        }
        sendResponse({
          ok: true,
          started: true,
          count: started.length,
          jobIds: started,
          total: unique.length,
          truncated: unique.length > started.length
        });
      })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_ACTIVE_DOWNLOADS": {
      sendResponse({ ok: true, jobs: listActiveDownloads() });
      break;
    }
    case "GET_DOWNLOAD_PROGRESS": {
      const jobs = listActiveDownloads();
      const running = jobs.find((j) => j.status === "running") || jobs[0] || null;
      const prog = hlsProgress.get(-1) || (msg.tabId != null ? hlsProgress.get(msg.tabId) : null);
      sendResponse({
        ok: true,
        jobs,
        job: running,
        progress: prog || null
      });
      break;
    }
    case "CLEAR_MEDIA": {
      if (msg.tabId != null) {
        tabMedia.delete(msg.tabId);
        updateBadge(msg.tabId);
      }
      sendResponse({ ok: true });
      break;
    }
    case "PING":
      sendResponse({ ok: true, version: "1.21.0" });
      break;
    case "DOWNLOAD_CURRENT_PAGE": {
      const tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || msg.url;
      (async () => {
        const settings = await UVD.getSettings();
        const displayTitle =
          (msg.title &&
            !UVD.isGenericSaveName(msg.title) &&
            (Naming.cleanPageTitle?.(msg.title) || msg.title)) ||
          "";
        const fname = lockSaveName({
          filenameHint: msg.filename || "",
          title: displayTitle || msg.title || "",
          pageTitle: displayTitle || msg.title || "",
          quality: msg.preferQuality,
          mediaMode: settings.mediaMode,
          pageUrl
        });
        const jobTitle =
          displayTitle ||
          (fname ? String(fname).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "") : "") ||
          "영상";
        runTrackedDownload(
          {
            tabId: tid,
            title: jobTitle,
            pageUrl,
            filename: fname || "",
            mediaMode: settings.mediaMode,
            quality: msg.preferQuality || "best"
          },
          async (jobId) => {
            // Uses job-locked title/filename — not whatever tab is focused later
            const r = await downloadPageFromUi(
              tid,
              pageUrl,
              msg.preferQuality || "best",
              jobId,
              {
                mediaMode: settings.mediaMode,
                title: msg.title || jobTitle,
                filename: fname || ""
              }
            );
            return { ...r, filename: r?.filename || fname };
          },
          sendResponse
        );
      })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "PROBE_HLS": {
      const tid = msg.tabId ?? tabId;
      const url = msg.url;
      if (url && tid != null) {
        probedUrls.delete(url);
        maybeProbeHls(tid, url)
          .then(() => sendResponse({ ok: true, item: getTabMap(tid).get(url) || null }))
          .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
        return true;
      }
      sendResponse({ ok: false, error: "no url" });
      break;
    }
    case "DOWNLOAD":
    case "DOWNLOAD_HLS": {
      const url = msg.url;
      let tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || url;
      const item = tid != null ? getTabMap(tid).get(url) : null;
      // Bind title/filename to THIS request only — ignore later tab navigation
      const boundTitle =
        Naming.cleanPageTitle?.(msg.title || item?.title || item?.pageTitle || "") ||
        msg.title ||
        item?.title ||
        item?.pageTitle ||
        "";
      const fname = lockSaveName({
        filenameHint: msg.filename || item?.filename || "",
        title: boundTitle,
        pageTitle: boundTitle,
        quality: msg.preferQuality || item?.quality || "",
        mediaMode: "video",
        pageUrl: pageUrl || item?.pageUrl || url
      });
      const mediaType =
        msg.mediaType ||
        item?.type ||
        (isHlsUrl(url) || msg.type === "DOWNLOAD_HLS" ? "stream" : "video");

      const preferYtDlp =
        msg.preferYtDlp === true ||
        item?.isSiteDownload ||
        needsYtDlpHelper(url, pageUrl || item?.pageUrl);

      const niceTitle =
        boundTitle ||
        (fname ? String(fname).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "") : "") ||
        "영상";

      // Snapshot item fields so long downloads don't pick up another video's meta
      const boundItem = {
        ...(item || {}),
        url,
        type: mediaType,
        isHls: isHlsUrl(url) || mediaType === "stream",
        pageUrl: pageUrl || item?.pageUrl || url,
        title: boundTitle || item?.title,
        pageTitle: boundTitle || item?.pageTitle,
        filename: fname || item?.filename,
        quality: msg.preferQuality || item?.quality
      };

      return runTrackedDownload(
        {
          tabId: tid,
          title: niceTitle,
          pageUrl: pageUrl || item?.pageUrl || url,
          mediaUrl: url || "",
          filename: fname,
          quality: msg.preferQuality || "best"
        },
        async (jobId) => {
          let workTab = tid;
          let opened = false;
          // For HLS from watchlist: open the original page so Referer/cookies work (123av etc.)
          if (
            msg.openPageIfNeeded &&
            pageUrl &&
            /^https?:/i.test(pageUrl) &&
            (isHlsUrl(url) || mediaType === "stream")
          ) {
            try {
              const found = await findOrOpenTabForPage(pageUrl, tid);
              workTab = found.tabId;
              opened = found.opened;
            } catch {
              /* continue with original tab */
            }
          }
          try {
            const r = await downloadSmart(
              workTab,
              url,
              fname,
              msg.preferQuality || "best",
              mediaType,
              boundItem,
              {
                pageUrl,
                preferYtDlp,
                jobId
              }
            );
            if (r?.method === "yt-dlp" || r?.ytdlp) {
              return { ...r, filename: r.filename || fname };
            }
            if (r == null || r.downloadId == null) {
              throw new Error(
                r?.error ||
                  "파일이 저장되지 않았습니다. chrome://downloads 를 확인해 주세요"
              );
            }
            return { ...r, filename: r.filename || fname };
          } finally {
            if (opened && workTab != null) {
              try {
                await new Promise((r) => setTimeout(r, 400));
                await chrome.tabs.remove(workTab);
              } catch {
                /* ignore */
              }
            }
          }
        },
        sendResponse
      );
    }
    case "VIDEO_CHUNK": {
      try {
        const { id, index, totalChunks, totalBytes, chunk, filename, mime } = msg;
        if (!id || chunk == null) {
          sendResponse({ ok: false, error: "저장 데이터 오류" });
          break;
        }
        let ass = videoAssemblies.get(id);
        if (!ass) {
          ass = {
            chunks: new Map(),
            totalChunks: totalChunks || 1,
            totalBytes: totalBytes || 0,
            filename: filename || `영상_${Date.now()}.mp4`,
            mime: mime || "video/mp4"
          };
          videoAssemblies.set(id, ass);
        }
        const u8 =
          chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : chunk instanceof Uint8Array
              ? chunk
              : new Uint8Array(chunk);
        ass.chunks.set(index, u8);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
      break;
    }
    case "VIDEO_CHUNK_FINISH": {
      const { id, filename, mime } = msg;
      const ass = videoAssemblies.get(id);
      if (!ass) {
        sendResponse({ ok: false, error: "조립 데이터 없음" });
        break;
      }
      (async () => {
        try {
          const ordered = [];
          for (let i = 0; i < ass.totalChunks; i++) {
            const c = ass.chunks.get(i);
            if (!c) throw new Error(`청크 누락 ${i}`);
            ordered.push(c);
          }
          let total = 0;
          for (const c of ordered) total += c.byteLength;
          if (total < 100_000) throw new Error("파일이 너무 작습니다");
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of ordered) {
            merged.set(c, off);
            off += c.byteLength;
          }
          const blob = new Blob([merged], { type: mime || "video/mp4" });
          const saved = await downloadBlob(blob, filename || ass.filename);
          videoAssemblies.delete(id);
          sendResponse({
            ok: true,
            downloadId: saved.downloadId,
            filename: saved.filename,
            path: saved.path,
            size: total
          });
        } catch (e) {
          videoAssemblies.delete(id);
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    default:
      break;
  }
  return false;
});

chrome.alarms.create("keepalive", { periodInMinutes: 4.5 });

/** Deferred watchlist downloads: alarm name `uvd-watch-{id}` */
async function runScheduledWatchItem(watchId) {
  const list = await UVD.getWatchlist();
  const item = list.find((x) => x.id === watchId);
  if (!item) return;
  const pageUrl = item.pageUrl || item.url || "";
  if (!/^https?:/i.test(pageUrl)) {
    await UVD.removeWatchlist(watchId);
    return;
  }
  const keep = startKeepAlive();
  try {
    await runTrackedDownloadAsync(
      {
        tabId: -1,
        title: item.title || "예약 다운로드",
        pageUrl,
        mediaUrl: item.mediaUrl || "",
        filename: "",
        quality: item.quality || "best"
      },
      (jobId) =>
        downloadPageFromUi(-1, pageUrl, item.quality || "best", jobId, {
          mediaUrl: item.mediaUrl || "",
          title: item.title || ""
        })
    );
  } catch (e) {
    console.warn("[UVD] scheduled watch download", watchId, e);
  } finally {
    stopKeepAlive(keep);
    try {
      await UVD.removeWatchlist(watchId);
    } catch {
      /* ignore */
    }
    try {
      await chrome.alarms.clear(`uvd-watch-${watchId}`);
    } catch {
      /* ignore */
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name) return;
  if (alarm.name === "keepalive" || alarm.name === "uvd-dl-keepalive") return;
  if (alarm.name.startsWith("uvd-watch-")) {
    const id = alarm.name.slice("uvd-watch-".length);
    runScheduledWatchItem(id).catch(() => {});
  }
});

console.log("[VideoDownloader] ready v1.23.3");
