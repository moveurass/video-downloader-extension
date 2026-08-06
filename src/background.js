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
  mediaMode
} = {}) {
  const s = await UVD.getSettings();
  const mode = mediaMode || s.mediaMode || "video";
  const cleanTitle = UVD.isGenericSaveName(title) ? "" : title || "";
  // Always legacy readable names (title + optional _quality)
  const base = UVD.applyFilenameTemplate("legacy", {
    title: cleanTitle,
    quality: quality || "",
    site: UVD.siteFromUrl(pageUrl || ""),
    mediaMode: mode
  });
  if (!base || UVD.isGenericSaveName(base)) return "";
  const ext =
    mode === "audio" || mediaType === "audio" ? ".mp3" : ".mp4";
  return safeDownloadName(
    base.endsWith(ext) ? base : base + ext,
    mode === "audio" ? "audio/mp3" : "video/mp4"
  );
}

/** Only pass a forced name to yt-dlp when it's a real human title */
function ytdlpFilenameHint(filename, title) {
  const candidates = [filename, title].filter(Boolean);
  for (const c of candidates) {
    const base = String(c).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
    if (base && !UVD.isGenericSaveName(base) && base.length >= 2) {
      return safeDownloadName(
        /\.[a-z0-9]{2,5}$/i.test(c) ? c : `${base}.mp4`,
        "video/mp4"
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
    yesPlaylist: UVD.isPlaylistUrl(pageUrl),
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
  filename,
  mediaMode,
  quality,
  thumbnail
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

  const job = {
    id,
    tabId: tabId != null ? tabId : -1,
    title: niceTitle,
    pageUrl: pageUrl || "",
    filename: filename || "",
    mediaMode: mediaMode || "video",
    quality: quality || "",
    thumbnail: thumb || "",
    status: "running",
    percent: 2,
    message: niceTitle !== "영상" ? `받는 중 · ${niceTitle.slice(0, 40)}` : "백그라운드에서 받는 중…",
    phase: "start",
    error: null,
    errorCode: null,
    result: null,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  activeDownloads.set(id, job);
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
  if (job.status !== "running" && patch.status === "running") {
    // ignore late progress after finish
    return job;
  }
  const next = { ...patch };
  // Strict monotonic percent while running.
  // Method retries (page HLS → SW HLS), playlist re-parse, and content-script
  // progress without floors used to make the bar jump up/down.
  if (job.status === "running" && typeof next.percent === "number") {
    const prevP = typeof job.percent === "number" ? job.percent : 0;
    next.percent = Math.max(prevP, Math.min(100, next.percent));
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

function updateDownloadBadge() {
  const n = [...activeDownloads.values()].filter((j) => j.status === "running").length;
  try {
    if (n > 0) {
      chrome.action.setBadgeText({ text: String(n) });
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      chrome.action.setTitle({
        title: `받는 중 ${n}개 · 페이지를 이동해도 계속됩니다`
      });
    } else {
      // Clear global badge; per-tab badges refreshed on next tab event
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
function emitDownloadProgress(tabId, percent, message, phase = "download", jobId = null) {
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
  const status =
    phase === "done" ? "done" : phase === "error" ? "error" : "running";
  // Don't mark done/error here — finishDownloadJob owns terminal states
  if (status === "running") {
    // Floor against current job % so retries never publish a lower value
    const floor = typeof job.percent === "number" ? job.percent : 0;
    const pct =
      typeof percent === "number" ? Math.max(floor, Math.min(100, percent)) : floor;
    updateDownloadJob(job.id, {
      percent: pct,
      message,
      phase,
      status: "running"
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
  let name = String(filename || `영상_${Date.now()}`);
  name = name
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[♥❤💕💗💖💘⭐✨]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.ts$/i, ".mp4")
    .replace(/\.m3u8$/i, ".mp4")
    .trim();
  if (!name || name.length < 2) name = `영상_${Date.now()}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    name += mime.includes("audio") ? ".mp3" : ".mp4";
  } else if (/\.ts$/i.test(name)) {
    name = name.replace(/\.ts$/i, ".mp4");
  }
  if (name.length > 100) {
    const m = name.match(/(\.[a-z0-9]{2,5})$/i);
    const ext = m ? m[1] : ".mp4";
    name = name.slice(0, 100 - ext.length).trim() + ext;
  }
  return name;
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

    // Generic: origin + path + significant query keys
    const keep = [];
    for (const k of ["v", "id", "video_id", "vid", "clip", "watch"]) {
      const val = u.searchParams.get(k);
      if (val) keep.push(`${k}=${val}`);
    }
    keep.sort();
    return `${host}${path}${keep.length ? "?" + keep.join("&") : ""}`;
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

  const tabTitle = meta?.title || "";
  let title = "";
  for (const c of [item.title, item.pageTitle, tabTitle]) {
    if (!c) continue;
    const cleaned = Naming.cleanPageTitle(c) || c;
    if (cleaned && !Naming.isUglyBase(cleaned)) {
      title = cleaned;
      const tt = Naming.cleanPageTitle(tabTitle);
      if (tt && !Naming.isUglyBase(tt) && tt.length > title.length + 5) title = tt;
      break;
    }
  }
  if (!title && tabTitle) title = Naming.cleanPageTitle(tabTitle) || tabTitle;
  if (title && Naming.isUglyBase(title)) title = Naming.cleanPageTitle(tabTitle) || "";

  const host = meta?.host || item.host || "";
  // Only inherit tab thumbnail if it belongs to the same page identity
  const itemPage = item.pageUrl || item.url || meta?.lastUrl || "";
  const samePage =
    !meta?.pageKey ||
    !itemPage ||
    pageIdentityKey(itemPage) === meta.pageKey ||
    pageIdentityKey(meta.lastUrl || "") === meta.pageKey;
  const thumbnail =
    item.thumbnail ||
    (samePage && meta?.thumbnail ? meta.thumbnail : undefined) ||
    undefined;
  const existingRaw = (item.filename || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const existingOk =
    existingRaw && !Naming.isUglyBase(existingRaw) ? item.filename : "";

  const filename = Naming.buildFilename({
    title,
    pageTitle: meta?.title || item.pageTitle || "",
    quality,
    type: item.type || "video",
    isHls,
    isFmp4: true,
    host,
    existing: existingOk
  });
  const displayName = Naming.displayTitle({
    title,
    pageTitle: meta?.title || item.pageTitle || "",
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
    pageTitle: item.pageTitle || meta?.title || undefined,
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
        out[k] = v;
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
      const updated = enrichItem(tabId, {
        ...cur,
        isHls: true,
        type: "stream",
        format: "MP4",
        duration: dur >= 1 ? dur : undefined,
        segmentCount: info.segmentCount,
        encrypted: info.encrypted,
        isFmp4: true
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
        emitDownloadProgress(tabId, Math.max(10, p.percent || 10), message, "download", jid);
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
      let message = p.message || "받는 중…";
      if (/\[download\]/i.test(message)) message = `받는 중… ${Math.round(p.percent || 0)}%`;
      if (/Merging|Merger/i.test(message)) message = "파일 합치는 중…";
      if (/Destination|Writing|subtitle/i.test(message)) message = "저장 중…";
      if (/ERROR/i.test(message)) message = message.slice(0, 120);
      emitDownloadProgress(tabId, p.percent || 10, message, p.status || "download", jid);
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
        let message = p.message || "받는 중…";
        if (/\[download\]/i.test(message)) {
          message = `받는 중… ${Math.round(p.percent || 0)}%`;
        }
        if (/login|log in|not logged|empty media|rate-limit|403|400/i.test(message)) {
          message =
            "Instagram 인증 문제 — 브라우저에서 로그인·새로고침 후 링크를 다시 붙여 넣어 주세요";
        }
        emitDownloadProgress(tabId, Math.max(28, p.percent || 28), message, "download", jid);
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

  // Prefer tab title / meta (readable). Never force YouTube_id style names.
  let fname = "";
  try {
    const meta = tabId != null ? tabMeta.get(tabId) : null;
    let tabTitle = meta?.title || forceOpts.title || "";
    if (!tabTitle && tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabTitle = Naming.cleanPageTitle(tab?.title || "") || "";
      } catch {
        /* ignore */
      }
    }
    fname = await buildSaveFilename({
      title: tabTitle || forceOpts.title || "",
      quality,
      pageUrl,
      mediaMode
    });
  } catch {
    fname = "";
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

  if ((!fname || UVD.isGenericSaveName(fname)) && workTabId != null) {
    try {
      const t = await chrome.tabs.get(workTabId);
      const tt = Naming.cleanPageTitle(t?.title || "");
      if (tt) {
        fname =
          (await buildSaveFilename({
            title: tt,
            quality,
            pageUrl,
            mediaMode
          })) || fname;
      }
    } catch {
      /* ignore */
    }
  }

  try {
    return await downloadSmart(
      workTabId,
      best.url,
      best.filename || fname,
      quality,
      mediaMode === "audio" ? "audio" : best.type || "video",
      best,
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
      finishDownloadJob(jobId, r, null);
      stopKeepAlive(keep);
    })
    .catch((err) => {
      finishDownloadJob(jobId, null, err);
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
    finishDownloadJob(jobId, r, null);
    return r;
  } catch (err) {
    finishDownloadJob(jobId, null, err);
    throw err;
  } finally {
    stopKeepAlive(keep);
  }
}

function startChromeDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          reject(new Error(chrome.runtime.lastError?.message || "다운로드 시작 실패"));
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
 */
function waitDownloadComplete(downloadId, timeoutMs = 180000) {
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
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const poll = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
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
 */
async function downloadBlobViaServiceWorker(blob, name) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("이 Chrome 버전에서는 blob 저장을 지원하지 않습니다");
  }
  const objectUrl = URL.createObjectURL(blob);
  // Large files need long wait; never clear keepAlive before this returns
  const timeoutMs = Math.min(45 * 60 * 1000, Math.max(180_000, blob.size / 8));
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
    const done = await waitDownloadComplete(id, timeoutMs);

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
 */
async function downloadBlob(blob, filename) {
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
      const saved = await downloadBlobViaServiceWorker(blob, name);
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

  // Floor so a second HLS attempt (after page-HLS fail) doesn't drop the bar
  const jobFloor = () => {
    if (!jid) return 0;
    const j = activeDownloads.get(jid);
    return typeof j?.percent === "number" ? j.percent : 0;
  };

  const setProg = (p) => {
    const floor = jobFloor();
    const raw =
      typeof p.percent === "number" && p.percent > 0 ? p.percent : 10;
    const percent = Math.max(floor, Math.min(99, raw));
    const progress = { ...p, percent, jobId: jid || undefined, global: true };
    hlsProgress.set(key, progress);
    if (jid) hlsProgress.set(jid, progress);
    emitDownloadProgress(
      tabId,
      percent,
      p.message || "받는 중…",
      p.phase || "download",
      jid
    );
  };

  setProg({
    phase: "start",
    message: "준비 중…",
    percent: Math.max(2, jobFloor())
  });

  const result = await HLS.downloadAndMerge(url, {
    preferQuality: preferQuality || "best",
    pageUrl,
    referer: pageUrl,
    requestInit: {
      credentials: "include",
      cache: "no-store",
      headers: pageUrl ? { Referer: pageUrl } : {}
    },
    allowPartial: true,
    onProgress: (p) => {
      const floor = jobFloor();
      // Map segment progress into [floor .. 93] so retries continue upward
      const span = Math.max(10, 93 - floor);
      let percent = Math.max(floor, 3);
      let message = "준비 중…";
      if (p.phase === "segments" && p.total) {
        percent = Math.round(floor + (p.current / p.total) * span);
        message = p.message || `받는 중… ${percent}%`;
      } else if (p.phase === "merge") {
        percent = Math.max(floor, 94);
        message = "파일 만드는 중…";
      } else if (p.phase === "playlist" || p.phase === "init") {
        percent = Math.max(floor, Math.min(floor + 2, 8));
        message = p.message || "준비 중…";
      }
      setProg({ ...p, percent, message });
    }
  });

  if (!result.size || result.size < 100_000) {
    throw new Error(`파일이 너무 작습니다 (${Math.round((result.size || 0) / 1024)}KB)`);
  }

  const baseItem = itemHint || (tabId != null ? getTabMap(tabId).get(url) : null) || {};
  let name = Naming.buildFilename({
    title: baseItem.title || baseItem.pageTitle || filenameHint,
    pageTitle: baseItem.pageTitle,
    quality: result.quality || baseItem.quality || preferQuality,
    type: "video",
    isHls: true,
    isFmp4: true,
    host: baseItem.host,
    existing: filenameHint || baseItem.filename
  });
  name = safeDownloadName(name, "video/mp4");

  setProg({ phase: "save", message: "저장 중…", percent: 96 });
  const saved = await downloadBlob(result.blob, name);
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
  if (url.startsWith("blob:") || (!isRealHls(url, mediaType) && tabId != null)) {
    const alt = bestNonBlobAlternative(tabId, url);
    if (alt?.url && (alt.isHls || isRealHls(alt.url, alt.type))) {
      workUrl = alt.url;
      workType = "stream";
      workItem = alt;
      filename = filename || alt.filename || filename;
      emitDownloadProgress(tabId, 5, "스트림으로 전환…", "download", jid);
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
    const tryPageFirst =
      /surrit|javplayer|missav|njav|jable|avgle|hanime|hls|cdn|123av|thisav|netflav|supjav|spankbang/i.test(
        workUrl + (pageUrl || "")
      );

    const runSwHls = async () => {
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
      const keep = jid ? activeDownloads.get(jid)?.percent || 8 : 8;
      emitDownloadProgress(
        tabId,
        Math.max(8, keep),
        "페이지에서 조각 받는 중…",
        "download",
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

    const order = tryPageFirst
      ? [runPageHls, runSwHls]
      : [runSwHls, runPageHls];

    for (let i = 0; i < order.length; i++) {
      try {
        const result = await order[i]();
        emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return result;
      } catch (e) {
        const msg = friendlyFetchError(e);
        errors.push(msg);
        // Keep current % (do not drop to 10) when switching methods
        const keepPct = jid
          ? activeDownloads.get(jid)?.percent || 10
          : 10;
        if (i + 1 < order.length && /403|401|접근 거부|Segment HTTP/i.test(msg)) {
          emitDownloadProgress(
            tabId,
            keepPct,
            "접근 제한 — 다른 방법으로 재시도…",
            "download",
            jid
          );
          continue;
        }
        if (i + 1 < order.length) {
          emitDownloadProgress(
            tabId,
            keepPct,
            "다른 방법으로 시도…",
            "download",
            jid
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
          // HLS master playlist — variants from HLS module
          if (/\.m3u8(\?|$|#)/i.test(url) || msg.mediaType === "stream") {
            try {
              const info = await withTabReferer(tid, () => HLS.probe(url));
              if (info?.kind === "master" && info.variants?.length) {
                const seen = new Set();
                const qualities = [{ id: "best", label: "최고" }];
                const order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"];
                const byLabel = new Map();
                for (const v of info.variants) {
                  const lab =
                    v.quality && v.quality !== "unknown"
                      ? v.quality
                      : qualityLabel(v.height) || (v.height ? `${v.height}p` : null);
                  if (!lab || lab === "unknown") continue;
                  const h = v.height || 0;
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
                // Media playlist duration if already known on tab item
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
                // Enrich chip labels with approx size: "1080p · 180MB"
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
                for (const lab of order) {
                  if (byLabel.has(lab) && !seen.has(lab)) {
                    qualities.push(byLabel.get(lab));
                    seen.add(lab);
                  }
                }
                for (const [lab, q] of byLabel) {
                  if (!seen.has(lab)) qualities.push(q);
                }
                const best = byLabel.get(qualities[1]?.id) || info.variants[0];
                const bw =
                  best?.estimateBandwidth ||
                  best?.bandwidth ||
                  info.variants[0]?.estimateBandwidth ||
                  0;
                if (bw > 0 && duration >= 1) {
                  estimatedSize = Math.round((bw / 8) * duration);
                  if (qualities[0]) {
                    qualities[0].estimatedSize = estimatedSize;
                    qualities[0].approx = true;
                    const mb = estimatedSize / (1024 * 1024);
                    const sizeStr =
                      mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
                    qualities[0].label = `최고 · ${sizeStr}`;
                  }
                }
                sendResponse({
                  ok: true,
                  qualities,
                  source: "hls",
                  duration: duration || 0,
                  estimatedSize: estimatedSize || 0
                });
                return;
              }
              if (info?.kind === "media") {
                sendResponse({
                  ok: true,
                  qualities: [{ id: "best", label: "최고" }],
                  source: "hls",
                  duration: info.duration >= 1 ? info.duration : 0,
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
        let fname = msg.filename || "";
        if (UVD.isGenericSaveName(fname)) fname = "";
        if (!fname) {
          fname =
            (await buildSaveFilename({
              title: msg.title || "",
              quality: msg.preferQuality,
              pageUrl,
              mediaMode: settings.mediaMode
            })) || "";
        }
        const displayTitle =
          (msg.title && !UVD.isGenericSaveName(msg.title) && msg.title) ||
          fname ||
          "영상";
        runTrackedDownload(
          {
            tabId: tid,
            title: displayTitle,
            pageUrl,
            filename: fname || displayTitle,
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
                title: msg.title || displayTitle
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
        .then((s) => sendResponse({ ok: true, settings: s }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "GET_HISTORY": {
      UVD.getHistory()
        .then((history) => sendResponse({ ok: true, history }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
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
      UVD.removeWatchlist(msg.id || msg.url || "")
        .then((watchlist) => sendResponse({ ok: true, watchlist }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    case "CLEAR_WATCHLIST": {
      UVD.clearWatchlist()
        .then(() => sendResponse({ ok: true, watchlist: [] }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
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
      sendResponse({ ok: true, version: "1.18.2" });
      break;
    case "DOWNLOAD_CURRENT_PAGE": {
      const tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || msg.url;
      (async () => {
        const settings = await UVD.getSettings();
        let fname = msg.filename || "";
        if (UVD.isGenericSaveName(fname)) fname = "";
        if (!fname) {
          fname =
            (await buildSaveFilename({
              title: msg.title || "",
              quality: msg.preferQuality,
              pageUrl,
              mediaMode: settings.mediaMode
            })) || "";
        }
        const displayTitle =
          (msg.title && !UVD.isGenericSaveName(msg.title) && msg.title) ||
          fname ||
          "영상";
        runTrackedDownload(
          {
            tabId: tid,
            title: displayTitle,
            pageUrl,
            filename: fname || displayTitle,
            mediaMode: settings.mediaMode,
            quality: msg.preferQuality || "best"
          },
          async (jobId) => {
            // Resolves human title from tab / yt-dlp (not YouTube_id)
            const r = await downloadPageFromUi(
              tid,
              pageUrl,
              msg.preferQuality || "best",
              jobId
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
      const fname = safeDownloadName(
        msg.filename ||
          resolveFilename(
            tid,
            { ...item, ...msg, url, isHls: msg.type === "DOWNLOAD_HLS" || isHlsUrl(url) },
            url
          ),
        "video/mp4"
      );
      const mediaType =
        msg.mediaType ||
        item?.type ||
        (isHlsUrl(url) || msg.type === "DOWNLOAD_HLS" ? "stream" : "video");

      const preferYtDlp =
        msg.preferYtDlp === true ||
        item?.isSiteDownload ||
        needsYtDlpHelper(url, pageUrl || item?.pageUrl);

      return runTrackedDownload(
        {
          tabId: tid,
          title: msg.title || item?.title || fname,
          pageUrl: pageUrl || item?.pageUrl || url,
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
              item || {
                url,
                type: mediaType,
                isHls: isHlsUrl(url),
                pageUrl,
                title: msg.title
              },
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
chrome.alarms.onAlarm.addListener(() => {});

console.log("[VideoDownloader] ready v1.13.0");
