/**
 * Popup: one best video + download. YouTube/TikTok via local helper.
 */

let currentTabId = null;
let currentTabUrl = null;
let allItems = [];
/** @deprecated use queue — true only while ANY job is running */
let downloading = false;
let helperOk = false;
/** Selected download quality id (best | 4K | 1080p | …) */
let selectedQuality = "best";
/** Only qualities that exist for the current video */
let availableQualities = [
  { id: "best", label: "최고" },
  { id: "4K", label: "4K" },
  { id: "1080p", label: "1080p" },
  { id: "720p", label: "720p" },
  { id: "480p", label: "480p" }
];
let qualitiesLoading = false;
/** Background job ids tracked by this popup session */
let trackedJobIds = new Set();
/** Avoid double toast for the same completed job */
let toastedJobIds = new Set();
/** True after we already restored UI from an in-flight job */
let restoredBackgroundJob = false;
/** Local mirror of active download jobs for multi-queue UI @type {Map<string, object>} */
const uiJobs = new Map();
/** Max concurrent starts from this popup (SW can still hold more) */
const MAX_CONCURRENT_STARTS = 6;
let queuePollTimer = null;
/** @type {object} */
let uvdSettings = { ...(globalThis.UVD?.DEFAULT_SETTINGS || {}) };
/** @type {Array<object>} */
let historyItems = [];
/** @type {Array<object>} */
let watchlistItems = [];
/** @type {Array<object>} */
let recentItems = [];
let activeTabName = "main";

/** @type {{ url: string, title: string, entries: Array, playlistCount: number } | null} */
let playlistInfo = null;
let playlistLoading = false;
/** Playlist download progress tracking for UI */
let playlistDl = { active: false, total: 0, done: 0, jobIds: new Set() };

/** Series complete pending payload */
let seriesPending = null;
/** Last series run id for batch failure retry */
let lastSeriesRun = null; // { seriesId, title, mode }
/** Default range for series preview: 3 | 5 | 10 | 'all' */
let seriesRangePref = "5";
/** Library filter state */
let libFilter = { q: "", status: "done", site: "", series: "" };
/** Cached site packs for settings */
let sitePacksCache = [];

const $ = (sel) => document.querySelector(sel);
const listEl = $("#list");
const emptyEl = $("#empty");
const pageHost = $("#pageHost");
const progressEl = $("#progress");
const progressFill = $("#progressFill");
const progressText = $("#progressText");
const helperBar = $("#helperBar");
const helperDot = $("#helperDot");
const helperText = $("#helperText");
const dlQueueEl = $("#dlQueue");
const dlQueueList = $("#dlQueueList");
const dlQueueTitle = $("#dlQueueTitle");
const dlQueueSub = $("#dlQueueSub");
const dlQueueBadge = $("#dlQueueBadge");
/** Queue list filter: all | running | done | error */
let dlQueueFilter = "all";

function isYoutubeUrl(url) {
  if (!url || typeof url !== "string") return false;
  // Match even if URL parsing fails (partial strings)
  if (/youtu\.be\//i.test(url) || /youtube\.com/i.test(url) || /youtube-nocookie\.com/i.test(url)) {
    return true;
  }
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return (
      h === "youtu.be" ||
      h === "youtube.com" ||
      h.endsWith(".youtube.com") ||
      h.includes("youtube-nocookie")
    );
  } catch {
    return false;
  }
}

function isTiktokUrl(url) {
  if (!url || typeof url !== "string") return false;
  // Page / share links only — not CDN image hosts
  if (/tiktokcdn|byteicdn|ibyteimg/i.test(url)) return false;
  if (/vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) return true;
  if (/tiktok\.com\/@[\w.-]+\/video\/\d+/i.test(url)) return true;
  if (/tiktok\.com\/t\//i.test(url)) return true;
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return (
      h === "tiktok.com" ||
      h.endsWith(".tiktok.com") ||
      h === "m.tiktok.com"
    );
  } catch {
    return /tiktok\.com/i.test(url);
  }
}

/** Instagram host (any page on the site) */
function isInstagramHost(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return h === "instagram.com" || h.endsWith(".instagram.com") || h === "instagr.am";
  } catch {
    return /instagram\.com|instagr\.am/i.test(url);
  }
}

/** Instagram post/reel/TV only — not home or profile */
function isInstagramPostUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (/cdninstagram|fbcdn\.net/i.test(url) && !/instagram\.com\//i.test(url)) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "instagr.am") return u.pathname.length > 2;
    if (h === "instagram.com" || h.endsWith(".instagram.com")) {
      return /\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(u.pathname);
    }
  } catch {
    /* fall through */
  }
  return /instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(url);
}

function isInstagramUrl(url) {
  // Downloadable Instagram = post/reel only (not homepage/profile)
  return isInstagramPostUrl(url);
}

function isXUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (/t\.co\//i.test(url)) return true;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h === "x.com" || h.endsWith(".x.com") || h === "twitter.com" || h.endsWith(".twitter.com")) {
      return /\/status\/\d+/i.test(u.pathname) || /\/i\/status\/\d+/i.test(u.pathname);
    }
  } catch {
    /* fall through */
  }
  return /(?:x|twitter)\.com\/.+\/status\/\d+/i.test(url);
}

function isFacebookUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (/fb\.watch\//i.test(url)) return true;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h.includes("facebook.com") || h === "fb.com" || h.endsWith(".fb.com")) {
      return (
        /\/(watch|reel|reels|videos|share)/i.test(u.pathname) ||
        u.searchParams.has("v") ||
        /\/posts\//i.test(u.pathname)
      );
    }
  } catch {
    /* fall through */
  }
  return /facebook\.com\/(watch|reel|videos)|fb\.watch\//i.test(url);
}

function isBilibiliUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (/b23\.tv\//i.test(url)) return true;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (h.includes("bilibili.com") || h.includes("bilibili.tv")) {
      return /\/video\/(BV|av)/i.test(u.pathname) || /\/(bangumi|play)\//i.test(u.pathname);
    }
  } catch {
    /* fall through */
  }
  return /bilibili\.com\/video\//i.test(url);
}

function isSitePage(url) {
  return isDownloadableSiteVideo(url);
}

/** Only real video pages — not home/profile/feed */
function isDownloadableSiteVideo(url) {
  if (!url) return false;
  if (isYoutubeUrl(url)) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./i, "") === "youtu.be" && u.pathname.length > 1) return true;
      if (u.searchParams.get("v")) return true;
      if (/\/(shorts|live|embed|clip)\/[\w-]+/i.test(u.pathname)) return true;
      if (/\/watch/i.test(u.pathname)) return true;
      if (/[?&]v=/i.test(url)) return true;
      // home / results / feed — not a single video
      const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
      if (path === "/" || /^\/(results|feed|shorts)$/i.test(path)) return false;
      return false;
    } catch {
      return /[?&]v=|\/shorts\/[\w-]+|youtu\.be\/[\w-]+/i.test(url);
    }
  }
  if (isTiktokUrl(url) || /tiktok\.com/i.test(url)) {
    if (/vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) return true;
    return /\/@[\w.-]+\/video\/\d+|\/video\/\d+|\/t\//i.test(url);
  }
  if (isInstagramHost(url) || /instagram\.com|instagr\.am/i.test(url)) {
    return isInstagramPostUrl(url);
  }
  if (isXUrl(url)) return true;
  if (isFacebookUrl(url)) return true;
  if (isBilibiliUrl(url)) return true;
  return false;
}

function siteLabel(url, item) {
  const u = url || item?.url || item?.pageUrl;
  if (item?.site === "youtube" || isYoutubeUrl(u)) return "YouTube";
  if (item?.site === "tiktok" || isTiktokUrl(u)) return "TikTok";
  if (item?.site === "instagram" || isInstagramUrl(u)) return "Instagram";
  if (item?.site === "x" || isXUrl(u)) return "X";
  if (item?.site === "facebook" || isFacebookUrl(u)) return "Facebook";
  if (item?.site === "bilibili" || isBilibiliUrl(u)) return "Bilibili";
  return null;
}

function siteKindFromUrl(pageUrl) {
  if (isYoutubeUrl(pageUrl)) return "youtube";
  if (isTiktokUrl(pageUrl)) return "tiktok";
  if (isInstagramUrl(pageUrl)) return "instagram";
  if (isXUrl(pageUrl)) return "x";
  if (isFacebookUrl(pageUrl)) return "facebook";
  if (isBilibiliUrl(pageUrl)) return "bilibili";
  return null;
}

/** Always-available card for YT/TT/IG when background has no media */
function buildLocalSiteItem(tab) {
  const pageUrl = tab?.url || currentTabUrl || "";
  if (!pageUrl || !isSitePage(pageUrl)) return null;
  const kind = siteKindFromUrl(pageUrl);
  if (!kind) return null;
  let title = String(tab?.title || "")
    .replace(/^\(\d{1,4}\)\s*/, "")
    .replace(/\s*[-–—|]\s*YouTube\s*$/i, "")
    .replace(/\s*[-–—|]\s*TikTok\s*$/i, "")
    .replace(/\s*[-–—|]\s*Instagram\s*$/i, "")
    .replace(/\s*[-–—|]\s*X\s*$/i, "")
    .replace(/\s*[-–—|]\s*Twitter\s*$/i, "")
    .replace(/\s*[-–—|]\s*Facebook\s*$/i, "")
    .replace(/\s*[-–—|]\s*bilibili\s*$/i, "")
    .replace(/\s*[-–—|].*$/, "")
    .replace(/^\(\d{1,4}\)\s*/, "")
    .trim();
  const defaults = {
    youtube: "YouTube 영상",
    tiktok: "TikTok 영상",
    instagram: "Instagram 영상",
    x: "X 영상",
    facebook: "Facebook 영상",
    bilibili: "Bilibili 영상"
  };
  if (
    !title ||
    /^(youtube|tiktok|instagram|x|twitter|facebook|bilibili)$/i.test(title)
  ) {
    title = defaults[kind] || "영상";
  }
  const safeBase = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const labelMap = {
    youtube: "YouTube",
    tiktok: "TikTok",
    instagram: "Instagram",
    x: "X",
    facebook: "Facebook",
    bilibili: "Bilibili"
  };
  const label = labelMap[kind] || "영상";
  return {
    url: pageUrl,
    pageUrl,
    type: "stream",
    isHls: false,
    isSiteDownload: true,
    site: kind,
    source: kind,
    title,
    pageTitle: title,
    displayName: title,
    filename: `${safeBase || label}.mp4`,
    quality: "",
    format: "MP4",
    host: (() => {
      try {
        return new URL(pageUrl).hostname;
      } catch {
        return kind;
      }
    })()
  };
}

let helperPollTimer = null;

/** Last known helper outDir (from /health) for settings display */
let helperOutDirCache = "";
let helperWasOk = null;

function stopHelperPoll() {
  if (helperPollTimer) {
    clearInterval(helperPollTimer);
    helperPollTimer = null;
  }
}

/** Keep polling while popup is open so helper reconnect is picked up without reload */
function startHelperPoll(intervalMs = 2800) {
  if (helperPollTimer) return;
  helperPollTimer = setInterval(() => {
    refreshHelperStatus(true).catch(() => {});
  }, intervalMs);
}

function updateHelperOutDirUi(outDir) {
  if (outDir) helperOutDirCache = String(outDir);
  const el = $("#setHelperOutDir");
  if (!el) return;
  el.textContent = helperOutDirCache
    ? helperOutDirCache
    : helperOk
      ? "연결됨 (경로 미보고)"
      : "도우미 꺼짐 — 실행 후 여기에 표시됩니다";
}

async function refreshHelperStatus(force = false) {
  if (!helperBar) return;
  const need =
    isSitePage(currentTabUrl) ||
    allItems.some((i) => i.isSiteDownload || i.site) ||
    !!$("#linkInput")?.value ||
    helperBar.classList.contains("warn") ||
    helperWasOk === false;
  const fixBtn = $("#btnHelperFix");
  const startBtn = $("#btnHelperStart");
  const recheckBtn = $("#btnHelperRecheck");
  if (!need && helperOk) {
    helperBar.classList.add("hidden");
    fixBtn?.classList.add("hidden");
    startBtn?.classList.add("hidden");
    recheckBtn?.classList.add("hidden");
    // Slow poll so reconnect / disconnect still surfaces
    if (!helperPollTimer) startHelperPoll(8000);
    return;
  }
  helperBar.classList.remove("hidden");
  helperBar.classList.remove("ok", "warn");
  if (helperText && !force) helperText.textContent = "도우미 확인 중…";
  try {
    const h = await chrome.runtime.sendMessage({ type: "YTDLP_HEALTH", force });
    const nowOk = !!(h?.ok && h?.ytdlp);
    if (h?.outDir) helperOutDirCache = String(h.outDir);
    updateHelperOutDirUi(helperOutDirCache);
    // Reconnected while popup open
    if (helperWasOk === false && nowOk) {
      toast("도우미 연결됨 — YouTube 등 받기 가능", "ok");
    }
    helperWasOk = nowOk;
    helperOk = nowOk;
    if (helperOk) {
      helperBar.classList.add("ok");
      if (helperText) {
        const pathHint = h.outDir
          ? ` · ${String(h.outDir).replace(/\/$/, "").split(/[/\\]/).slice(-2).join("/")}`
          : "";
        helperText.textContent = `도우미 준비됨${
          h.ytdlpVersion ? ` · yt-dlp ${h.ytdlpVersion}` : ""
        }${pathHint}`;
      }
      fixBtn?.classList.add("hidden");
      startBtn?.classList.add("hidden");
      recheckBtn?.classList.add("hidden");
      // Stay on slow poll to notice if helper dies
      stopHelperPoll();
      startHelperPoll(8000);
    } else {
      helperBar.classList.add("warn");
      if (helperText) {
        helperText.textContent = "도우미 꺼짐 — 실행 파일 저장 후 더블클릭 (자동 재확인 중)";
      }
      fixBtn?.classList.remove("hidden");
      startBtn?.classList.remove("hidden");
      recheckBtn?.classList.remove("hidden");
      stopHelperPoll();
      startHelperPoll(2800);
    }
  } catch {
    const was = helperOk;
    helperOk = false;
    helperWasOk = false;
    helperBar.classList.add("warn");
    if (helperText) {
      helperText.textContent = "도우미 꺼짐 — 실행 파일 저장 후 더블클릭 (자동 재확인 중)";
    }
    fixBtn?.classList.remove("hidden");
    startBtn?.classList.remove("hidden");
    recheckBtn?.classList.remove("hidden");
    updateHelperOutDirUi("");
    stopHelperPoll();
    startHelperPoll(2800);
    if (was) toast("도우미 연결이 끊겼습니다", "error");
  }
}

function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return null;
  bytes = Number(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(sec) {
  // Hide junk like 0:00 from tiny/invalid values
  if (sec == null || !Number.isFinite(Number(sec)) || Number(sec) < 1) return null;
  sec = Number(sec);
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Always MP4 for video — no .ts jargon for users */
function formatKind(item) {
  if (item.type === "audio" || (item.mime || "").startsWith("audio/")) {
    return { label: "오디오", ext: ".mp3" };
  }
  return { label: "MP4 동영상", ext: ".mp4" };
}

/** Estimate stream size from average bitrate × duration (rough only) */
function estimateSize(item) {
  if (item.size && item.size > 0) return { bytes: item.size, approx: false };
  if (item.estimatedSize && item.estimatedSize > 0) {
    return { bytes: item.estimatedSize, approx: true };
  }
  const dur = Number(item.duration) || 0;
  // Prefer average bitrate; peak BANDWIDTH alone is often ~2× real file size
  const avgBw = Number(item.estimateBandwidth) || 0;
  const peakBw = Number(item.bandwidth) || 0;
  const bw = avgBw || (peakBw ? Math.round(peakBw * 0.55) : 0);
  if (bw > 0 && dur >= 1) {
    return { bytes: Math.round((bw / 8) * dur), approx: true };
  }
  // rough fallback: segments × ~220KB (2–6s HLS pieces)
  if (item.segmentCount && item.segmentCount > 5) {
    return { bytes: item.segmentCount * 220_000, approx: true };
  }
  return null;
}

/** Size estimate for currently selected quality chip */
function estimateForSelectedQuality(item) {
  const q = availableQualities.find((x) => x.id === selectedQuality);
  if (q?.estimatedSize > 0) {
    return { bytes: q.estimatedSize, approx: q.approx !== false };
  }
  // Scale rough estimate by height vs best when only overall size known
  if (item.estimatedSize > 0 && q?.height && item._bestHeight) {
    const ratio = Math.min(1.2, Math.max(0.25, (q.height / item._bestHeight) ** 1.4));
    return { bytes: Math.round(item.estimatedSize * ratio), approx: true };
  }
  return estimateSize(item);
}

function estimateBarHtml(item, loading = false) {
  if (loading) {
    return `<div class="estimate-bar loading">
      <span class="est-item"><span class="est-k">미리보기</span><span class="est-v">용량·길이 확인 중…</span></span>
    </div>`;
  }
  const dur = formatDuration(item.duration);
  const est = estimateForSelectedQuality(item);
  const sizeText = est
    ? est.approx
      ? `약 ${formatSize(est.bytes)}`
      : formatSize(est.bytes)
    : null;
  const qLabel =
    selectedQuality === "best" ? "최고" : selectedQuality || item.quality || "";
  const parts = [];
  if (sizeText) {
    parts.push(
      `<span class="est-item"><span class="est-k">용량</span><span class="est-v">${escapeHtml(
        sizeText
      )}</span></span>`
    );
  }
  if (dur) {
    parts.push(
      `<span class="est-item"><span class="est-k">길이</span><span class="est-v">${escapeHtml(
        dur
      )}</span></span>`
    );
  }
  if (qLabel) {
    parts.push(
      `<span class="est-item"><span class="est-k">화질</span><span class="est-v">${escapeHtml(
        qLabel
      )}</span></span>`
    );
  }
  if (!parts.length) {
    return `<div class="estimate-bar loading">
      <span class="est-item"><span class="est-k">미리보기</span><span class="est-v">받기 후 용량 확정</span></span>
    </div>`;
  }
  return `<div class="estimate-bar">${parts.join("")}</div>`;
}

function metaRowsHtml(item) {
  const site = siteLabel(currentTabUrl, item);
  const dur = formatDuration(item.duration);
  const est = estimateForSelectedQuality(item);
  const sizeText = est
    ? est.approx
      ? `약 ${formatSize(est.bytes)}`
      : formatSize(est.bytes)
    : site
      ? "받기 후 확정"
      : "다운로드 후 확정";
  const quality = item.quality || null;
  const res =
    item.width && item.height ? `${item.width}×${item.height}` : null;
  const pick =
    selectedQuality === "best"
      ? "최고 (가능한 최대)"
      : selectedQuality;
  const qualityText = site
    ? pick
    : [pick, quality, res].filter(Boolean).join(" · ") || pick;
  const lengthText = dur || "—";

  const rows = [
    ["사이트", site || "일반"],
    ["형식", site ? "MKV/MP4" : "MP4"],
    ["선택 화질", qualityText],
    ["길이", lengthText],
    ["용량", sizeText]
  ];

  return rows
    .map(
      ([k, v]) =>
        `<div class="meta-row"><span class="meta-k">${escapeHtml(k)}</span><span class="meta-v">${escapeHtml(v)}</span></div>`
    )
    .join("");
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function isHlsItem(item) {
  const url = item?.url || "";
  if (/\.m3u8(\?|$|#)/i.test(url)) return true;
  if (/m3u8/i.test(url) && (item.isHls || item.type === "stream")) return true;
  return false;
}

function isUglyName(name) {
  const b = String(name || "")
    .replace(/\.(mp4|webm|ts|m3u8|mp3)$/i, "")
    .replace(/\s*\(\d+p|4K\)\s*/gi, "")
    .trim();
  if (!b || b.length < 2) return true;
  if (/javplayer|surrit|cloudfront|player/i.test(b)) return true;
  if (/^(www\.)?[a-z0-9-]+\.(com|cc|net|tv|io|me)$/i.test(b)) return true;
  if (/\.(com|cc|net|tv)\b/i.test(b) && b.length < 28 && !/[가-힣]/.test(b)) return true;
  if (/\d+x\d+/i.test(b)) return true;
  if (/^\d+[_-]\d+/i.test(b)) return true;
  if (/^(영상|동영상|video|media|audio|다운로드|가능)$/i.test(b)) return true;
  if (/^[a-f0-9]{12,}$/i.test(b)) return true;
  return false;
}

/**
 * Clean page title → scannable name
 * Prefer Naming (strips Uncensored-Leaked, site brands, puts CODE first)
 * e.g. "SNOS-309 -Uncensored-Leaked — 제목 - 123AV" → "SNOS-309 제목"
 */
function cleanTitleText(raw) {
  if (!raw) return "";
  if (typeof Naming !== "undefined" && Naming.cleanPageTitle) {
    return Naming.cleanPageTitle(raw) || "";
  }
  let t = String(raw);
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  t = t.replace(/^\(\d{1,4}\)\s*/, "").replace(/^\[\d{1,4}\]\s*/, "");
  t = t
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[♥❤💕💗💖💘⭐✨♡]/g, "");
  // leak / marketing tags (may be glued: Uncensored-Leaked_720p)
  t = t.replace(/[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi, " ");
  t = t.replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ");
  t = t.replace(
    /\s*[\-|–—|·•:]\s*(YouTube|123AV|123av|MissAV|Jable|Netflix|Twitch|Bilibili).*$/i,
    ""
  );
  t = t
    .replace(/[\u2010-\u2015\u2212|·•]+/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\.(m3u8|mp4|webm|ts|mp3|mkv)$/i, "")
    .replace(/다운로드\s*가능/g, "")
    .replace(/\s*[\(\[]\s*\d{3,4}\s*p\s*[\)\]]/gi, "")
    .replace(/\s+\d{3,4}p\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function siteLabel() {
  try {
    if (pageHost?.textContent && pageHost.textContent !== "—") {
      return pageHost.textContent.replace(/^www\./, "");
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 목록 제목 — 무슨 영상인지 바로 알 수 있게
 * 예: "SSIS-001 이복 여동생이 귀에 키스하는 이야기"
 */
function displayName(item) {
  const pageUrl = item.pageUrl || currentTabUrl || "";
  const candidates = [
    item.title,
    item.pageTitle,
    item.displayName,
    item.filename
  ];
  // Prefer title bound to this page (same product code)
  let best = "";
  for (const c of candidates) {
    let cleaned = cleanTitleText(c);
    if (!cleaned || isUglyName(cleaned) || cleaned.length < 2) continue;
    if (typeof Naming !== "undefined" && Naming.bindTitleToPage && pageUrl) {
      cleaned = Naming.bindTitleToPage(pageUrl, cleaned) || cleaned;
    }
    if (cleaned.length > best.length) best = cleaned;
  }
  if (!best && pageUrl && typeof Naming !== "undefined") {
    best = Naming.extractProductCode?.(pageUrl) || "";
  }
  if (!best) best = "영상";
  if (best.length > 70) best = best.slice(0, 68).trim() + "…";
  return best;
}

/**
 * 저장 파일명 — 품번 + 짧은 제목 + 화질 (잡태그 제거)
 * 예: "SSIS-001 이복 여동생 이야기_720p.mp4"
 * 제목을 모를 때는 빈 문자열 → yt-dlp가 실제 제목(유니코드·공백 유지) 사용
 */
function downloadFilename(item) {
  const pageUrl = item.pageUrl || currentTabUrl || "";
  const urlCode =
    (typeof Naming !== "undefined" &&
      Naming.extractProductCode?.(pageUrl || item.title || "")) ||
    "";

  // Only accept titles that match this page's product code (prevents wrong-video names)
  let title = "";
  for (const c of [item.title, item.pageTitle, item.displayName, item.filename]) {
    let cleaned = cleanTitleText(c);
    if (!cleaned || isUglyName(cleaned) || UVD.isGenericSaveName(cleaned)) continue;
    if (typeof Naming !== "undefined" && Naming.bindTitleToPage && pageUrl) {
      cleaned = Naming.bindTitleToPage(pageUrl, cleaned) || cleaned;
    }
    const cCode =
      (typeof Naming !== "undefined" && Naming.extractProductCode?.(cleaned)) ||
      "";
    if (urlCode && cCode && cCode.toUpperCase() !== urlCode.toUpperCase()) {
      continue; // different video — skip
    }
    if (cleaned.length > title.length) title = cleaned;
  }
  if (urlCode && !title) title = urlCode;
  if (
    urlCode &&
    title &&
    !title.toUpperCase().includes(urlCode.toUpperCase())
  ) {
    title = `${urlCode} ${title}`.trim();
  }

  let quality = "";
  if (selectedQuality && !/^(best|all)$/i.test(selectedQuality)) {
    quality = selectedQuality;
  } else if (
    item.quality &&
    item.quality !== "unknown" &&
    !/^(best|all|unknown|highest)$/i.test(item.quality)
  ) {
    quality = item.quality;
  }

  const mediaMode = uvdSettings.mediaMode || "video";
  const isAudio = mediaMode === "audio" || item.type === "audio";

  // Prefer shared Naming builder (CODE first, strip leak tags)
  if (typeof Naming !== "undefined" && Naming.buildFilename) {
    if (!title || UVD.isGenericSaveName(title)) return "";
    return Naming.buildFilename({
      title,
      pageTitle: title,
      quality,
      type: isAudio ? "audio" : "video",
      pageUrl,
      existing: item.filename || ""
    });
  }

  // Fallback if Naming not loaded
  let base = UVD.applyFilenameTemplate("legacy", {
    title,
    quality,
    site: UVD.siteFromUrl(pageUrl || item.url || ""),
    mediaMode
  });
  if (!base) {
    if (title && !UVD.isGenericSaveName(title)) {
      base = title
        .replace(/[<>:"/\\|?*]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70);
      if (quality && !base.includes(quality)) base += `_${quality}`;
    }
  }
  const ext = isAudio ? ".mp3" : ".mp4";
  if (!base) return "";
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

/** Fallback only when we truly cannot probe — never invent 4K/1080p */
const FALLBACK_QUALITY_CHIPS = [{ id: "best", label: "최고" }];

function heightToQualityId(h) {
  const n = Number(h) || 0;
  if (n >= 2160) return "4K";
  if (n >= 1440) return "1440p";
  if (n >= 1080) return "1080p";
  if (n >= 720) return "720p";
  if (n >= 480) return "480p";
  if (n >= 360) return "360p";
  if (n >= 240) return "240p";
  return "";
}

/** Build a single concrete quality chip (not "best") from height/size info */
function concreteQualityChip(q) {
  if (!q) return null;
  let id = String(q.id || "");
  if (!id || id === "best" || /^(best|all|unknown)$/i.test(id)) {
    id = heightToQualityId(q.height) || "";
  }
  if (!id) return null;
  const sizeStr = q.estimatedSize > 0 ? formatMb(q.estimatedSize) : "";
  const codec = q.codec || "";
  const parts = [id];
  if (sizeStr) parts.push(sizeStr);
  if (codec) parts.push(codec);
  return {
    ...q,
    id,
    label: parts.join(" · "),
    height: q.height || 0
  };
}

/**
 * Keep only qualities that were actually probed for this video.
 * Do NOT pad with a fixed 4K/1080p/720p list — those may not exist.
 * When only ONE real height exists, show that chip (e.g. 720p) — not "최고".
 */
function ensureQualityChoices(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .filter(
      (q) =>
        q &&
        q.id &&
        !/unsupported|error|fail|http/i.test(String(q.label || "")) &&
        !/unsupported|error/i.test(String(q.id))
    )
    .map((q) => ({
      ...q,
      label: q.label || q.id
    }));

  // Dedupe by id, keep first (usually "best" then high→low)
  const seen = new Set();
  const unique = [];
  for (const q of cleaned) {
    const id = String(q.id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(q);
  }

  const bestEntry = unique.find((q) => q.id === "best");
  const real = unique.filter((q) => q.id !== "best");

  // Only one concrete quality → show that chip alone (e.g. "720p · 180MB")
  if (real.length === 1) {
    const only = concreteQualityChip(real[0]) || real[0];
    return [only];
  }

  // Only "best" but it carries a height → show as that height chip
  if (real.length === 0 && bestEntry) {
    const concrete = concreteQualityChip(bestEntry);
    if (concrete) return [concrete];
    return [{ ...bestEntry, label: bestEntry.label || "최고" }];
  }

  // Multiple real heights → optional "최고" first, then each height
  if (real.length > 1) {
    const out = [];
    if (bestEntry) {
      out.push({
        ...bestEntry,
        label: bestEntry.label || "최고"
      });
    } else {
      const top = real[0];
      out.push({
        id: "best",
        label: top.estimatedSize
          ? `최고 · ${formatMb(top.estimatedSize)}`
          : "최고",
        height: top.height,
        estimatedSize: top.estimatedSize,
        codec: top.codec,
        approx: top.approx
      });
    }
    for (const q of real) out.push(q);
    return out;
  }

  if (unique.length) return unique;
  // Probe failed / not ready
  return FALLBACK_QUALITY_CHIPS.map((s) => ({ ...s }));
}

function formatMb(bytes) {
  const mb = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(mb) || mb <= 0) return "";
  return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
}

function qualityPickerHtml() {
  if (qualitiesLoading) {
    return `
      <div class="quality-picker" id="qualityPicker">
        <span class="quality-label">화질 선택</span>
        <p class="quality-hint">이 영상에서 받을 수 있는 화질 확인 중…</p>
        <div class="quality-chips" role="group" aria-label="화질 선택">
          <button type="button" class="q-chip active" data-quality="best" disabled>최고</button>
        </div>
      </div>`;
  }
  const opts = ensureQualityChoices(availableQualities);
  // Ensure selection is still valid (single chip → auto-select that quality id)
  if (!opts.some((q) => q.id === selectedQuality)) {
    selectedQuality = opts[0]?.id || "best";
  }
  const singleConcrete =
    opts.length === 1 && opts[0].id !== "best";
  // Bare "최고" only — resolution unknown (common on 123av before play)
  const bareBestOnly =
    opts.length === 1 &&
    (opts[0].id === "best" || /^최고/.test(String(opts[0].label || ""))) &&
    !(Number(opts[0].height) >= 240);
  return `
    <div class="quality-picker" id="qualityPicker">
      <span class="quality-label">화질 선택${
        singleConcrete
          ? ` <span class="quality-hint-inline">이 영상 화질</span>`
          : opts.length > 1
            ? ` <span class="quality-hint-inline">실제 가능 화질만 표시</span>`
            : bareBestOnly
              ? ` <span class="quality-hint-inline">화질 미확인</span>`
              : ""
      }</span>
      ${
        bareBestOnly
          ? `<p class="quality-hint quality-hint-warn">화질을 특정하지 못했습니다. 페이지에서 <strong>재생</strong>한 뒤 「다시 확인」을 누르세요.</p>`
          : ""
      }
      <div class="quality-chips" role="group" aria-label="화질 선택">
        ${opts
          .map((q) => {
            const chip = formatQualityChipLabel(q);
            const tip = [
              q.id,
              q.height ? `${q.height}p` : "",
              q.codec || "",
              q.estimatedSize
                ? `약 ${(q.estimatedSize / 1024 / 1024).toFixed(1)}MB`
                : ""
            ]
              .filter(Boolean)
              .join(" · ");
            return `<button type="button" class="q-chip${
              selectedQuality === q.id ? " active" : ""
            }" data-quality="${escapeAttr(q.id)}" title="${escapeAttr(
              tip
            )}">${escapeHtml(chip)}</button>`;
          })
          .join("")}
        ${
          bareBestOnly
            ? `<button type="button" class="q-chip q-chip-action" id="btnReprobeQuality" title="플레이어 해상도·스트림 다시 확인">다시 확인</button>`
            : ""
        }
      </div>
    </div>`;
}

/** Chip text: "1080p · 180MB · h264" (already often in q.label from helper) */
function formatQualityChipLabel(q) {
  if (!q) return "최고";
  // Prefer short id-style on crowded chips; keep rich label if not too long
  const rich = q.label && (q.label.includes("·") || q.label.includes("MB"));
  if (rich && String(q.label).length <= 22) return q.label;
  // Compact: "1080p" or "1080p · 180MB" — never show "최고" when id is a real height
  let id = q.id || q.label || "최고";
  if (id === "best") {
    const fromH = heightToQualityId(q.height);
    id = fromH || "최고";
  }
  if (q.estimatedSize > 0) {
    const sizeStr = formatMb(q.estimatedSize);
    return sizeStr ? `${id} · ${sizeStr}` : id;
  }
  if (q.codec && id !== "최고") return `${id} · ${q.codec}`;
  return id;
}

function qualityIdFromHeight(h) {
  return heightToQualityId(h) || "";
}

/** Guess height from m3u8/CDN URL path tokens (…/720/…, …_720p.m3u8) */
function qualityFromMediaUrl(url) {
  const s = String(url || "");
  const m =
    s.match(/(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)/i) ||
    s.match(/[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i) ||
    s.match(
      /[?&](?:quality|res|resolution|h|height)=?(2160|1440|1080|720|480|360|240)\b/i
    );
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const id = qualityIdFromHeight(h);
  if (!id) return null;
  return { id, label: id, height: h };
}

/** Ask content script for <video>.videoHeight (after play on 123av etc.) */
async function fetchPlayerHeight(tabId) {
  if (tabId == null || tabId < 0) return null;
  try {
    const r = await chrome.tabs
      .sendMessage(tabId, { type: "GET_PLAYER_HEIGHT" })
      .catch(() => null);
    const h = Number(r?.height) || 0;
    if (h < 240) return null;
    const id =
      (r?.quality && !/^(best|all|unknown)$/i.test(String(r.quality))
        ? r.quality
        : null) || qualityIdFromHeight(h);
    if (!id) return null;
    return { id, label: id, height: h };
  } catch {
    return null;
  }
}

/** True when list is only a bare "best/최고" with no real height */
function isOnlyBareBest(list) {
  const opts = ensureQualityChoices(list);
  if (opts.length !== 1) return false;
  const q = opts[0];
  if (q.id !== "best" && !/^최고/.test(String(q.label || ""))) return false;
  return !(q.height >= 240);
}

async function loadAvailableQualities(item) {
  qualitiesLoading = true;
  // While probing: only "최고" — never show fake 4K/1080p list
  availableQualities = FALLBACK_QUALITY_CHIPS.map((s) => ({ ...s }));
  const pageUrl = currentTabUrl || item?.pageUrl || item?.url || "";
  const mediaUrl = item?.url || pageUrl;
  const isHls =
    item?.isHls ||
    item?.type === "stream" ||
    /\.m3u8(\?|$|#)/i.test(mediaUrl || "");
  const isDirectMedia = /\.(mp4|webm|mkv|m4v)(\?|$|#)/i.test(mediaUrl || "");
  // Social single-video pages OR captured HLS/mp4 on generic sites (123av etc.)
  const canProbe =
    isDownloadableSiteVideo(mediaUrl) ||
    isDownloadableSiteVideo(pageUrl) ||
    isHls ||
    isDirectMedia ||
    !!(item?.url && /^https?:/i.test(item.url));

  // Seed from already-known media height / quality / URL / title / live player
  const seedFromItem = [];
  if (item?.quality && !/^(best|all|unknown)$/i.test(String(item.quality))) {
    seedFromItem.push({
      id: item.quality,
      label: item.quality,
      height: item.height || 0
    });
  } else if (item?.height >= 240) {
    const lab = qualityIdFromHeight(item.height);
    if (lab) seedFromItem.push({ id: lab, label: lab, height: item.height });
  } else {
    const fromUrl = qualityFromMediaUrl(mediaUrl);
    if (fromUrl) seedFromItem.push(fromUrl);
  }
  // Title often embeds quality on 123av: "SSIS-001 … 720p"
  if (!seedFromItem.length) {
    const titleBlob = [
      item?.title,
      item?.pageTitle,
      item?.displayName,
      typeof document !== "undefined" ? document.title : ""
    ]
      .filter(Boolean)
      .join(" ");
    const tm = String(titleBlob).match(
      /(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP]\b/
    );
    if (tm) {
      const h = parseInt(tm[1], 10);
      const id = qualityIdFromHeight(h);
      if (id) seedFromItem.push({ id, label: id, height: h });
    }
  }
  // Player may already know height even when item does not
  if (!seedFromItem.length) {
    const ph = await fetchPlayerHeight(currentTabId);
    if (ph) seedFromItem.push(ph);
  }

  // Homepage with no media — cannot list formats
  if (!canProbe) {
    availableQualities = ensureQualityChoices(
      seedFromItem.length ? seedFromItem : FALLBACK_QUALITY_CHIPS
    );
    applySiteDefaultQuality(pageUrl || mediaUrl);
    qualitiesLoading = false;
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "LIST_QUALITIES",
      url: mediaUrl,
      pageUrl,
      tabId: currentTabId,
      mediaType: item?.type || (isHls ? "stream" : undefined),
      // Pass known height so single media playlists can show e.g. 720p not "최고"
      itemHeight: item?.height || seedFromItem[0]?.height || 0,
      itemQuality: item?.quality || seedFromItem[0]?.id || "",
      forceYtDlp: !!(item?.isSiteDownload || isDownloadableSiteVideo(pageUrl))
    });
    if (res?.ok && res.qualities?.length) {
      // Real probed list only (HLS variants / yt-dlp heights)
      availableQualities = ensureQualityChoices(res.qualities);
    } else if (seedFromItem.length) {
      availableQualities = ensureQualityChoices(seedFromItem);
    } else {
      availableQualities = ensureQualityChoices(FALLBACK_QUALITY_CHIPS);
    }

    // Still only bare "최고"? Recover height from player / seed
    if (isOnlyBareBest(availableQualities)) {
      let recovered = seedFromItem[0] || null;
      if (!recovered) recovered = await fetchPlayerHeight(currentTabId);
      if (recovered) {
        availableQualities = ensureQualityChoices([recovered]);
      }
    }

    // Apply duration / size / title / thumb preview onto the card item
    if (res?.ok && allItems[0]) {
      const patch = { ...allItems[0] };
      if (res.duration >= 1) patch.duration = res.duration;
      if (res.estimatedSize > 0) {
        patch.estimatedSize = res.estimatedSize;
        patch._sizeApprox = true;
      }
      if (res.title && (!patch.title || /^(YouTube|TikTok|Instagram)/i.test(patch.title))) {
        patch.title = res.title;
        patch.pageTitle = res.title;
        patch.displayName = res.title;
      }
      if (res.thumbnail && !patch.thumbnail) patch.thumbnail = res.thumbnail;
      const bestQ = availableQualities.find((q) => q.id === "best") || availableQualities[0];
      if (bestQ?.height) {
        patch._bestHeight = bestQ.height;
        if (!(patch.height >= 240)) {
          patch.height = bestQ.height;
          patch.quality = bestQ.id !== "best" ? bestQ.id : qualityIdFromHeight(bestQ.height);
        }
      }
      // Per-quality sizes already on chips; also stash on item for "best"
      if (bestQ?.estimatedSize) {
        patch.estimatedSize = bestQ.estimatedSize;
        patch._sizeApprox = true;
      }
      allItems[0] = patch;
    }
  } catch {
    if (seedFromItem.length) {
      availableQualities = ensureQualityChoices(seedFromItem);
    } else {
      const ph = await fetchPlayerHeight(currentTabId);
      availableQualities = ensureQualityChoices(
        ph ? [ph] : FALLBACK_QUALITY_CHIPS
      );
    }
  }
  applySiteDefaultQuality(pageUrl || mediaUrl);
  if (!availableQualities.some((q) => q.id === selectedQuality)) {
    selectedQuality = availableQualities[0]?.id || "best";
  }
  qualitiesLoading = false;
  // Keep global bar in sync if no card is showing chips
  const hasCard = !!(allItems[0] && isSitePage(currentTabUrl));
  syncGlobalQualityBox(hasCard);
}

/**
 * Auto-select quality when chips load.
 * Single concrete quality → select that id (e.g. 720p).
 * Multiple → prefer 최고 if present.
 */
function applySiteDefaultQuality(pageUrl) {
  const opts = ensureQualityChoices(availableQualities);
  availableQualities = opts;
  // Only one real height → select it (not "best")
  if (opts.length === 1) {
    selectedQuality = opts[0].id;
    return;
  }
  if (opts.some((q) => q.id === "best")) {
    selectedQuality = "best";
    return;
  }
  const pref = UVD.qualityForSite(uvdSettings, pageUrl || currentTabUrl || "");
  if (pref && opts.some((q) => q.id === pref)) {
    selectedQuality = pref;
    return;
  }
  selectedQuality = opts[0]?.id || "best";
}

/**
 * Sync global quality bar (link-paste path).
 * Hide when the video card already shows chips (avoid double pickers).
 */
function syncGlobalQualityBox(hasCardPicker = false) {
  const box = $("#qualityBox");
  const root = $("#globalQualityChips");
  if (!box || !root) return;

  if (hasCardPicker) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  const opts = ensureQualityChoices(availableQualities);
  if (!opts.some((q) => q.id === selectedQuality)) {
    selectedQuality = opts[0]?.id || "best";
  }
  root.innerHTML = opts
    .map((q) => {
      const chip = formatQualityChipLabel(q);
      return `<button type="button" class="q-chip${
        selectedQuality === q.id ? " active" : ""
      }" data-quality="${escapeAttr(q.id)}" ${
        qualitiesLoading ? "disabled" : ""
      }>${escapeHtml(chip)}</button>`;
    })
    .join("");

  root.querySelectorAll(".q-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      selectedQuality = btn.getAttribute("data-quality") || "best";
      syncGlobalQualityBox(false);
    });
  });
}

function thumbHtml(item) {
  const src = item.thumbnail;
  if (src) {
    return `<img class="thumb-img" src="${escapeAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<span class="thumb-fallback">🎬</span>`;
}

function runningJobCount() {
  let n = 0;
  for (const j of uiJobs.values()) {
    if (j.status === "running") n += 1;
  }
  return n;
}

function canStartAnotherDownload() {
  return runningJobCount() < MAX_CONCURRENT_STARTS;
}

/**
 * Human-readable name for a queue row — what file is being saved.
 * Prefers real title → filename → site host, never bare "영상" if we can do better.
 */
function jobDisplayInfo(job) {
  const pathName = (p) => {
    if (!p) return "";
    const s = String(p).split(/[/\\]/).pop() || "";
    return s.replace(/\.(mp4|webm|mkv|mp3|m4a|ts)$/i, "").trim();
  };

  let file =
    pathName(job?.result?.filename) ||
    pathName(job?.result?.path) ||
    pathName(job?.filename) ||
    pathName(job?.path) ||
    "";

  let title = "";
  for (const c of [job?.title, job?.pageTitle, job?.displayName, file]) {
    const cleaned = cleanTitleText(c);
    if (
      cleaned &&
      !isUglyName(cleaned) &&
      !(typeof UVD !== "undefined" && UVD.isGenericSaveName?.(cleaned)) &&
      cleaned.length > title.length
    ) {
      title = cleaned;
    }
  }

  if (!title && file && !(typeof UVD !== "undefined" && UVD.isGenericSaveName?.(file))) {
    title = file;
  }

  if (!title && job?.pageUrl) {
    const site = siteLabel(job.pageUrl, job);
    try {
      const u = new URL(job.pageUrl);
      const host = u.hostname.replace(/^www\./, "");
      title = site ? `${site} 영상` : host;
    } catch {
      title = site || "영상";
    }
  }
  if (!title) title = "영상";

  // Show final file name if different from title
  let fileLabel = "";
  if (file && file !== title && !title.includes(file.slice(0, 20))) {
    fileLabel = file.length > 48 ? file.slice(0, 46) + "…" : file;
    const ext =
      (job?.result?.filename || job?.filename || "").match(
        /\.(mp4|webm|mkv|mp3|m4a)$/i
      )?.[0] || "";
    if (ext && !fileLabel.endsWith(ext)) fileLabel += ext;
  } else if (file && file === title) {
    const ext =
      (job?.result?.filename || job?.filename || "").match(
        /\.(mp4|webm|mkv|mp3|m4a)$/i
      )?.[0] || ".mp4";
    fileLabel = `${file.length > 40 ? file.slice(0, 38) + "…" : file}${
      file.endsWith(ext) ? "" : ext
    }`;
  }

  const quality =
    job?.quality && !/^(best|all|unknown)$/i.test(String(job.quality))
      ? String(job.quality)
      : "";
  const site = siteLabel(job?.pageUrl, job) || "";

  return { title, fileLabel, quality, site };
}

function shortJobTitle(job) {
  const { title } = jobDisplayInfo(job);
  if (title.length > 48) return title.slice(0, 46) + "…";
  return title;
}

/** Rough ETA from startedAt + percent (best-effort). */
function jobEtaLabel(job) {
  if (!job || job.status !== "running") return "";
  const pct = Number(job.percent) || 0;
  const started = Number(job.startedAt) || 0;
  if (pct < 3 || !started) return "";
  const elapsed = Date.now() - started;
  if (elapsed < 4000) return "";
  const totalEst = elapsed / (pct / 100);
  const remain = Math.max(0, totalEst - elapsed);
  if (!Number.isFinite(remain) || remain > 6 * 60 * 60 * 1000) return "";
  const sec = Math.round(remain / 1000);
  if (sec < 60) return `약 ${sec}초`;
  const min = Math.round(sec / 60);
  if (min < 60) return `약 ${min}분`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return `약 ${hr}시간${m ? ` ${m}분` : ""}`;
}

function jobPhaseLabel(job) {
  const st = job?.status || "running";
  if (st === "done") return "완료";
  if (st === "error") return "실패";
  if (st === "cancelled") return "취소";
  if (st === "paused") return "일시정지";
  const phase = String(job?.phase || "");
  const msg = String(job?.message || "");
  if (phase === "merge" || /만들|합치|Merg/i.test(msg)) return "합치는 중";
  if (phase === "save" || /^저장/i.test(msg)) return "저장 중";
  if (/시작|준비|해석|목록/i.test(msg)) return "준비 중";
  return "받는 중";
}

function cleanJobMessage(msg, phase) {
  // Keep user-visible detail for long phases (disk write / merge / segments)
  // so "99% stuck" is explained as "writing 800MB" not a silent hang.
  let text = String(msg || "").trim();
  if (phase === "error" || /ERROR|실패|error/i.test(text)) {
    const clean = text.replace(/^Error:\s*/i, "").trim();
    return clean.length > 56 ? clean.slice(0, 54) + "…" : clean || "실패";
  }
  // Disk write — preserve MB / elapsed so it doesn't look frozen at 99%
  if (
    phase === "save" ||
    /디스크|쓰는 중|저장 중|Destination|Merging into/i.test(text)
  ) {
    if (/디스크|쓰는 중|MB|약 \d/.test(text)) {
      return text.length > 52 ? text.slice(0, 50) + "…" : text;
    }
    const dest = text.match(
      /(?:Destination|Merging into|to:\s*)(.+\.(?:mp4|mkv|webm|mp3))/i
    );
    if (dest) {
      const name = dest[1].split(/[/\\]/).pop();
      return `저장 중 · ${name.length > 28 ? name.slice(0, 26) + "…" : name}`;
    }
    return "디스크에 저장 중…";
  }
  if (phase === "merge" || /만들|합치|Merg|ffmpeg/i.test(text)) {
    if (/\d+\s*\/\s*\d+/.test(text) || /MB|KB|GB/.test(text)) {
      return text.length > 48 ? text.slice(0, 46) + "…" : text;
    }
    return "파일 만드는 중…";
  }
  // Size progress: "받는 중… 125MB / 약 800MB"
  if (
    /받는 중…\s*[\d.]+(KB|MB|GB)/i.test(text) ||
    /[\d.]+\s*(KB|MB|GB)\s*\/\s*약/i.test(text) ||
    /추가 트랙/.test(text)
  ) {
    return text.length > 48 ? text.slice(0, 46) + "…" : text;
  }
  if (
    !text ||
    /조각|세그먼트|\[download\]|ETA|at\s+\d|% of|MiB|KiB/i.test(text) ||
    /받는 중|다운로드/i.test(text)
  ) {
    // Keep "받는 중… 45%" or size text if present
    if (
      /받는 중…\s*\d/.test(text) ||
      /전체 \d/.test(text) ||
      /(KB|MB|GB)/i.test(text)
    ) {
      return text.length > 48 ? text.slice(0, 46) + "…" : text;
    }
    return "받는 중…";
  }
  if (/시작|준비|해석|목록|쿠키|연결/i.test(text)) return "준비 중…";
  if (text.length > 40) return "받는 중…";
  return text;
}

function syncDownloadingFlag() {
  downloading = runningJobCount() > 0;
}

function ensureQueuePoll() {
  if (queuePollTimer) return;
  queuePollTimer = setInterval(() => {
    if (runningJobCount() === 0) {
      clearInterval(queuePollTimer);
      queuePollTimer = null;
      return;
    }
    refreshJobsFromBackground();
  }, 900);
}

/** Monotonic order so rows never jump when status changes */
let queueOrderSeq = 0;

async function refreshJobsFromBackground() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
    const jobs = res?.jobs || [];
    let structureChanged = false;
    let progressOnly = false;
    for (const j of jobs) {
      if (!j?.id) continue;
      trackedJobIds.add(j.id);
      const prev = uiJobs.get(j.id);
      // Never let a still-running SW tick undo a local pause/cancel click
      if (
        prev &&
        (prev.status === "paused" || prev.status === "cancelled") &&
        j.status === "running"
      ) {
        continue;
      }
      const prevPct = Math.round(prev?.percent || 0);
      const nextPct = Math.round(
        typeof j.percent === "number" ? j.percent : prevPct
      );
      const statusChanged = !prev || prev.status !== j.status;
      const progressChanged =
        prev &&
        (prevPct !== nextPct ||
          (prev.message || "") !== (j.message || "") ||
          (prev.phase || "") !== (j.phase || ""));
      if (statusChanged || !prev) {
        upsertUiJob(j, { toast: false, forceStructure: true });
        structureChanged = true;
      } else if (progressChanged) {
        upsertUiJob(j, { toast: false, progressOnly: true });
        progressOnly = true;
      } else {
        // Merge quietly without re-render
        uiJobs.set(j.id, {
          ...prev,
          ...j,
          percent: Math.max(prevPct, nextPct),
          queueOrder: prev.queueOrder
        });
      }
    }
    // Drop very old *done* jobs not in SW — never auto-drop errors (user needs buttons)
    const now = Date.now();
    for (const [id, j] of uiJobs) {
      if (j.status === "running" || j.status === "paused") continue;
      if (j.status === "error" || j.status === "cancelled") continue;
      if (j.pinned) continue;
      if (!jobs.some((x) => x.id === id) && now - (j.updatedAt || 0) > 60_000) {
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

/** Throttle progress-only patches (never rebuild whole list) */
let queuePatchTimer = null;
let queuePatchDirty = false;
function scheduleQueuePatch() {
  queuePatchDirty = true;
  if (queuePatchTimer) return;
  queuePatchTimer = setTimeout(() => {
    queuePatchTimer = null;
    if (!queuePatchDirty) return;
    queuePatchDirty = false;
    patchQueueProgress();
  }, 350);
}

/** Full rebuild only when jobs added/removed/status/actions change */
let queueFullTimer = null;
function scheduleQueueFullRender() {
  if (queueFullTimer) return;
  queueFullTimer = setTimeout(() => {
    queueFullTimer = null;
    renderDownloadQueue(true);
  }, 80);
}

function upsertUiJob(job, opts = {}) {
  if (!job?.id && !job?.jobId) return;
  const id = job.id || job.jobId;
  const prev = uiJobs.get(id) || {};
  const status =
    job.status ||
    (job.phase === "done"
      ? "done"
      : job.phase === "error"
        ? "error"
        : prev.status || "running");

  // Strict monotonic % while running (page HLS retry / playlist re-parse / mixed events)
  let percent =
    typeof job.percent === "number"
      ? job.percent
      : typeof prev.percent === "number"
        ? prev.percent
        : 0;
  if (
    status === "running" &&
    prev.status === "running" &&
    typeof prev.percent === "number"
  ) {
    percent = Math.max(prev.percent, typeof job.percent === "number" ? job.percent : 0);
  }
  if (status === "done") percent = 100;
  percent = Math.max(0, Math.min(100, percent));

  // Stabilize noisy progress messages → phase buckets only
  const rawMsg = job.message || prev.message || "";
  const phase = job.phase || prev.phase || "";
  const stableMsg =
    status === "running" || status === "paused"
      ? cleanJobMessage(rawMsg, phase)
      : status === "error" || status === "cancelled"
        ? cleanJobMessage(job.error || rawMsg || "실패", "error")
        : rawMsg;

  // Prefer richer title/filename from new event, keep previous if empty/generic
  const pickTitle = (...cands) => {
    for (const c of cands) {
      const t = String(c || "").trim();
      if (!t) continue;
      if (typeof UVD !== "undefined" && UVD.isGenericSaveName?.(t)) continue;
      if (/^(영상|동영상|video)$/i.test(t)) continue;
      return t;
    }
    return cands.find((c) => String(c || "").trim()) || "영상";
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
    filename:
      job.filename ||
      prev.filename ||
      resultName ||
      "",
    quality: job.quality || prev.quality || "",
    pageUrl: job.pageUrl || prev.pageUrl || "",
    speedBps:
      typeof job.speedBps === "number" && job.speedBps > 0
        ? job.speedBps
        : prev.speedBps || 0,
    speedLabel: job.speedLabel || prev.speedLabel || "",
    error: job.error || (status === "error" ? job.message : prev.error) || null,
    result: job.result || prev.result || null,
    updatedAt: job.updatedAt || Date.now(),
    startedAt: job.startedAt || prev.startedAt || Date.now(),
    queueOrder,
    // Errors stay until user dismisses
    pinned: status === "error" || status === "cancelled" ? true : !!prev.pinned
  };
  if (next.speedBps && !next.speedLabel) {
    next.speedLabel = UVD.formatSpeed(next.speedBps);
  }
  // After finish, adopt real saved name into title/filename for display
  if (status === "done" && resultName) {
    next.filename = resultName;
    if (
      !next.title ||
      next.title === "영상" ||
      (typeof UVD !== "undefined" && UVD.isGenericSaveName?.(next.title))
    ) {
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

  // Skip no-op progress updates
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

  if (structureNeeded) {
    scheduleQueueFullRender();
  } else if (opts.progressOnly || status === "running" || status === "paused") {
    scheduleQueuePatch();
  } else {
    scheduleQueueFullRender();
  }

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
  // Auto-remove *done* only — errors stay until dismiss (so buttons stay clickable)
  if (status === "done" && !next.pinned) {
    const keepMs = uiJobs.size >= 2 ? 50_000 : 25_000;
    setTimeout(() => {
      const cur = uiJobs.get(id);
      if (cur && cur.status === "done" && !cur.pinned) {
        uiJobs.delete(id);
        renderDownloadQueue(true);
      }
    }, keepMs);
  }
}

/** Stable list order — never re-sort by status (prevents error rows jumping). */
function sortedUiJobs() {
  return [...uiJobs.values()].sort((a, b) => {
    const oa = a.queueOrder ?? a.startedAt ?? 0;
    const ob = b.queueOrder ?? b.startedAt ?? 0;
    return oa - ob;
  });
}

function updateQueueHeader(jobs) {
  const running = jobs.filter((j) => j.status === "running");
  const paused = jobs.filter((j) => j.status === "paused");
  const done = jobs.filter((j) => j.status === "done");
  const errored = jobs.filter(
    (j) => j.status === "error" || j.status === "cancelled"
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
    const n = running.length || errored.length || done.length;
    dlQueueBadge.textContent = String(n);
    dlQueueBadge.classList.remove("hidden", "done", "error");
    if (!running.length && done.length && !errored.length) {
      dlQueueBadge.classList.add("done");
    }
    if (!running.length && errored.length) {
      dlQueueBadge.classList.add("error");
    }
  }

  const filtEl = $("#dlQueueFilters");
  if (filtEl) {
    if (jobs.length >= 2) {
      filtEl.classList.remove("hidden");
      filtEl.querySelectorAll(".dl-qf").forEach((btn) => {
        const f = btn.getAttribute("data-qf") || "all";
        btn.classList.toggle("active", f === dlQueueFilter);
        let n = jobs.length;
        if (f === "running") n = running.length + paused.length;
        else if (f === "done") n = done.length;
        else if (f === "error") n = errored.length;
        const base =
          f === "all"
            ? "전체"
            : f === "running"
              ? "받는 중"
              : f === "done"
                ? "완료"
                : "실패";
        btn.textContent = n ? `${base} ${n}` : base;
      });
    } else {
      filtEl.classList.add("hidden");
    }
  }

  if (dlQueueSub) {
    // Header stays light — per-file % lives on each row only
    if (errored.length && !running.length) {
      dlQueueSub.textContent = `실패 ${errored.length}개 · 아래에서 다시 받기 / 닫기`;
      dlQueueSub.title = errored.map((j) => shortJobTitle(j)).join("\n");
    } else if (running.length > 1) {
      dlQueueSub.textContent = `${running.length}개 동시 받는 중 · 각 파일 진행률은 아래 참고`;
      dlQueueSub.title = running.map((j) => shortJobTitle(j)).join("\n");
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

/**
 * Update % / bar / phase text without replacing DOM (no flicker, buttons stay).
 */
function patchQueueProgress() {
  if (!dlQueueEl || !dlQueueList) return;
  const jobs = sortedUiJobs();
  if (!jobs.length) {
    renderDownloadQueue(true);
    return;
  }
  updateQueueHeader(jobs);

  for (const j of jobs) {
    const safeId = String(j.id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = dlQueueList.querySelector(`.dl-job[data-job-id="${safeId}"]`);
    if (!row) continue;
    const st = j.status || "running";
    // Structure-level status change → full rebuild needed
    if (
      (st === "running" && !row.classList.contains("is-running")) ||
      (st === "paused" && !row.classList.contains("is-paused")) ||
      (st === "done" && !row.classList.contains("is-done")) ||
      ((st === "error" || st === "cancelled") && !row.classList.contains("is-error"))
    ) {
      renderDownloadQueue(true);
      return;
    }
    if (st !== "running" && st !== "paused") continue;

    const pct = Math.min(100, Math.max(0, Math.round(j.percent || 0)));
    const phase = jobPhaseLabel(j);
    const msg = cleanJobMessage(j.message, j.phase);
    const eta = jobEtaLabel(j);
    const speed =
      st === "running" && (j.speedLabel || j.speedBps)
        ? j.speedLabel || UVD.formatSpeed(j.speedBps)
        : "";

    const pctEl = row.querySelector(".dl-job-pct");
    if (pctEl && st === "running") pctEl.textContent = `${pct}%`;
    if (pctEl && st === "paused") pctEl.textContent = "정지";

    const phaseEl = row.querySelector(".dl-job-phase");
    if (phaseEl) phaseEl.textContent = phase;

    const msgEl = row.querySelector(".dl-job-msg");
    if (msgEl && msgEl.textContent !== msg) msgEl.textContent = msg;

    const fill = row.querySelector(".dl-job-fill");
    if (fill) fill.style.width = `${pct}%`;

    const metaLine = row.querySelector(".dl-job-meta-line");
    if (metaLine) {
      const info = jobDisplayInfo(j);
      const bits = [info.site, info.quality, phase, speed, eta].filter(Boolean);
      // Only rewrite chips if content set changed
      const key = bits.join("|");
      if (metaLine.dataset.bits !== key) {
        metaLine.dataset.bits = key;
        metaLine.innerHTML = bits
          .map((t) => `<span class="dl-job-chip">${escapeHtml(t)}</span>`)
          .join("");
      }
    }
  }
  syncDownloadingFlag();
  if (playlistDl.jobIds.size) updatePlaylistProgressUi();
}

function renderDownloadQueue(_force = false) {
  if (!dlQueueEl || !dlQueueList) return;
  // Stable order by queueOrder (first-seen) — rows never reshuffle
  const jobs = sortedUiJobs();
  const running = jobs.filter((j) => j.status === "running");
  const paused = jobs.filter((j) => j.status === "paused");
  const done = jobs.filter((j) => j.status === "done");
  const errored = jobs.filter(
    (j) => j.status === "error" || j.status === "cancelled"
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
      (j) => j.status === "running" || j.status === "paused"
    );
  } else if (dlQueueFilter === "done") {
    visible = jobs.filter((j) => j.status === "done");
  } else if (dlQueueFilter === "error") {
    visible = jobs.filter(
      (j) => j.status === "error" || j.status === "cancelled"
    );
  }

  const indexOf = new Map(jobs.map((j, i) => [j.id, i + 1]));

  // Preserve scroll position across rebuild
  const prevScroll = dlQueueList.scrollTop;

  dlQueueList.innerHTML = visible.length
    ? visible
        .map((j) => {
          const st = j.status || "running";
          const pct = Math.min(100, Math.max(0, Math.round(j.percent || 0)));
          const num = indexOf.get(j.id) || 1;
          const icon =
            st === "done"
              ? "✓"
              : st === "error" || st === "cancelled"
                ? "!"
                : st === "paused"
                  ? "❚❚"
                  : "↓";
          const phase = jobPhaseLabel(j);
          const pctLabel =
            st === "done"
              ? "완료"
              : st === "error"
                ? "실패"
                : st === "cancelled"
                  ? "취소"
                  : st === "paused"
                    ? "정지"
                    : `${pct}%`;
          const info = jobDisplayInfo(j);
          const msg =
            st === "error" || st === "cancelled"
              ? cleanJobMessage(j.error || j.message || "실패", "error")
              : st === "paused"
                ? "일시정지됨"
                : cleanJobMessage(j.message, j.phase);
          const errMeta =
            st === "error"
              ? UVD.classifyError(j.error || j.message || "")
              : null;
          let actionsHtml = "";
          if (st === "running") {
            actionsHtml = `<div class="dl-job-actions">
          <button type="button" class="btn" data-act="pause" data-job="${escapeAttr(
            j.id
          )}">일시정지</button>
          <button type="button" class="btn danger" data-act="cancel" data-job="${escapeAttr(
            j.id
          )}">취소</button>
        </div>`;
          } else if (st === "paused") {
            actionsHtml = `<div class="dl-job-actions">
          <button type="button" class="btn" data-act="resume" data-job="${escapeAttr(
            j.id
          )}">다시 시작</button>
          <button type="button" class="btn danger" data-act="cancel" data-job="${escapeAttr(
            j.id
          )}">취소</button>
        </div>`;
          } else if (st === "error") {
            actionsHtml =
              recoveryActionsHtml(errMeta, j.pageUrl, j) +
              `<div class="dl-job-actions">
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(
                  j.id
                )}">닫기</button>
              </div>`;
          } else if (st === "cancelled") {
            actionsHtml = `<div class="dl-job-actions">
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(
                  j.id
                )}">닫기</button>
              </div>`;
          } else if (st === "done") {
            actionsHtml = `<div class="dl-job-actions">
                <button type="button" class="btn" data-act="show" data-path="${escapeAttr(
                  j.result?.path || ""
                )}" data-did="${escapeAttr(
                  j.result?.downloadId ?? ""
                )}">폴더</button>
                <button type="button" class="btn ghost" data-act="dismiss" data-job="${escapeAttr(
                  j.id
                )}">닫기</button>
              </div>`;
          }
          const errLine =
            st === "error" && errMeta
              ? `<div class="dl-job-err-box"><div class="dl-job-err"><strong>${escapeHtml(
                  errMeta.label
                )}</strong> — ${escapeHtml(errMeta.hint)}</div></div>`
              : "";
          const eta = jobEtaLabel(j);
          const speed =
            st === "running" && (j.speedLabel || j.speedBps)
              ? j.speedLabel || UVD.formatSpeed(j.speedBps)
              : "";
          const metaBits = [
            info.site,
            info.quality,
            phase,
            speed,
            eta
          ].filter(Boolean);
          const metaLine = metaBits.length
            ? `<div class="dl-job-meta-line" data-bits="${escapeAttr(
                metaBits.join("|")
              )}">${metaBits
                .map(
                  (t) =>
                    `<span class="dl-job-chip">${escapeHtml(t)}</span>`
                )
                .join("")}</div>`
            : "";
          const fileHtml = info.fileLabel
            ? `<div class="dl-job-file" title="${escapeAttr(
                info.fileLabel
              )}">📄 ${escapeHtml(info.fileLabel)}</div>`
            : "";
          const tip = [info.title, info.fileLabel, j.pageUrl]
            .filter(Boolean)
            .join("\n");
          const titleShort =
            info.title.length > 52
              ? info.title.slice(0, 50) + "…"
              : info.title;
          return `
        <div class="dl-job ${st === "done" ? "is-done" : ""} ${
          st === "error" || st === "cancelled" ? "is-error is-sticky" : ""
        } ${st === "running" ? "is-running" : ""} ${
          st === "paused" ? "is-paused" : ""
        }" data-job-id="${escapeAttr(j.id)}" data-status="${escapeAttr(st)}">
          <div class="dl-job-top">
            <span class="dl-job-num" title="큐 순서">#${num}</span>
            <span class="dl-job-status ${escapeAttr(st)}" aria-hidden="true">${icon}</span>
            <div class="dl-job-meta">
              <div class="dl-job-title" title="${escapeAttr(tip)}">${escapeHtml(
                titleShort
              )}</div>
              ${fileHtml}
              ${metaLine}
              <div class="dl-job-msg">${escapeHtml(msg)}</div>
              ${errLine}
            </div>
            <div class="dl-job-right">
              <span class="dl-job-pct">${escapeHtml(pctLabel)}</span>
              ${
                st === "running"
                  ? `<span class="dl-job-phase">${escapeHtml(phase)}</span>`
                  : ""
              }
            </div>
          </div>
          <div class="dl-job-bar">
            <div class="dl-job-fill" style="width:${
              st === "error" || st === "cancelled" ? 100 : pct
            }%"></div>
          </div>
          ${actionsHtml}
        </div>`;
        })
        .join("")
    : `<div class="dl-queue-empty">이 필터에 항목이 없습니다</div>`;

  dlQueueList.scrollTop = prevScroll;

  // Filter clicks — bind once via delegation if needed
  $("#dlQueueFilters")
    ?.querySelectorAll(".dl-qf")
    .forEach((btn) => {
      btn.onclick = () => {
        dlQueueFilter = btn.getAttribute("data-qf") || "all";
        renderDownloadQueue(true);
      };
    });

  bindRecoveryButtons(dlQueueList);
  syncDownloadingFlag();
  if (playlistDl.jobIds.size) updatePlaylistProgressUi();
}

function recoveryActionsHtml(errMeta, pageUrl, job) {
  const acts = errMeta?.actions || ["retry"];
  const u = pageUrl || job?.pageUrl || "";
  const buttons = [];
  if (acts.includes("play_retry") && u) {
    buttons.push(
      `<button type="button" class="btn" data-act="play_retry" data-url="${escapeAttr(
        u
      )}">재생 후 재시도</button>`
    );
  }
  if (acts.includes("retry") && u) {
    buttons.push(
      `<button type="button" class="btn" data-act="retry" data-url="${escapeAttr(
        u
      )}">다시 받기</button>`
    );
  }
  if (acts.includes("open_page") && u) {
    buttons.push(
      `<button type="button" class="btn" data-act="open" data-url="${escapeAttr(
        u
      )}">페이지 열기</button>`
    );
  }
  if (acts.includes("login") && u) {
    buttons.push(
      `<button type="button" class="btn" data-act="login" data-url="${escapeAttr(
        u
      )}">로그인</button>`
    );
  }
  if (acts.includes("helper_start")) {
    buttons.push(
      `<button type="button" class="btn" data-act="helper_start">도우미 실행</button>`
    );
  }
  if (acts.includes("helper")) {
    buttons.push(
      `<button type="button" class="btn" data-act="helper">안내</button>`
    );
  }
  if (acts.includes("resume") && job?.id) {
    buttons.push(
      `<button type="button" class="btn" data-act="resume" data-job="${escapeAttr(
        job.id
      )}">다시 시작</button>`
    );
  }
  if (!buttons.length) return "";
  return `<div class="dl-job-actions">${buttons.join("")}</div>`;
}

/** Resolve UI job id → real background job id (optimistic local_* rows) */
function resolveRealJobId(jobId) {
  if (!jobId) return "";
  if (!String(jobId).startsWith("local_")) return jobId;
  const local = uiJobs.get(jobId);
  // Prefer tracked real id with same page/title
  for (const [id, j] of uiJobs) {
    if (String(id).startsWith("local_")) continue;
    if (j.status !== "running" && j.status !== "paused") continue;
    if (
      local &&
      ((local.pageUrl && j.pageUrl && local.pageUrl === j.pageUrl) ||
        (local.title && j.title && local.title === j.title))
    ) {
      return id;
    }
  }
  // Fallback: first running real job if only one
  const running = [...uiJobs.entries()].filter(
    ([id, j]) =>
      !String(id).startsWith("local_") &&
      (j.status === "running" || j.status === "paused")
  );
  if (running.length === 1) return running[0][0];
  return jobId;
}

function bindRecoveryButtons(root) {
  if (!root) return;
  // Event delegation — survives partial re-renders better than per-button binds
  if (root.dataset.actBound === "1") return;
  root.dataset.actBound = "1";
  root.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("[data-act]");
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.getAttribute("data-act");
    const url = btn.getAttribute("data-url") || "";
    const path = btn.getAttribute("data-path") || "";
    const did = btn.getAttribute("data-did");
    const jobId = resolveRealJobId(btn.getAttribute("data-job") || "");
    try {
      if (act === "cancel" && jobId) {
        btn.disabled = true;
        // Optimistic UI first — avoid flicker from late progress
        const rawId = btn.getAttribute("data-job") || jobId;
        const j = uiJobs.get(jobId) || uiJobs.get(rawId);
        if (j) {
          upsertUiJob(
            {
              ...j,
              id: jobId,
              status: "cancelled",
              message: "취소됨",
              phase: "cancelled",
              percent: j.percent || 0
            },
            { toast: false, forceStructure: true }
          );
        }
        const r = await chrome.runtime.sendMessage({
          type: "CANCEL_DOWNLOAD",
          jobId
        });
        if (r?.ok === false) {
          toast(r.error || "취소 실패", "error");
          btn.disabled = false;
          // Revert if needed
          await refreshJobsFromBackground();
          return;
        }
        toast("취소했습니다", "ok");
        // Delayed sync — SW already set cancelled
        setTimeout(() => refreshJobsFromBackground(), 400);
        return;
      }
      if (act === "pause" && jobId) {
        btn.disabled = true;
        const rawId = btn.getAttribute("data-job") || jobId;
        const j = uiJobs.get(jobId) || uiJobs.get(rawId);
        if (j) {
          upsertUiJob(
            {
              ...j,
              id: jobId,
              status: "paused",
              message: "일시정지됨 · 다시 시작 가능",
              phase: "paused"
            },
            { toast: false, forceStructure: true }
          );
        }
        const r = await chrome.runtime.sendMessage({
          type: "PAUSE_DOWNLOAD",
          jobId
        });
        if (r?.ok === false) {
          toast(r.error || "일시정지 실패", "error");
          btn.disabled = false;
          await refreshJobsFromBackground();
          return;
        }
        toast("일시정지했습니다", "ok");
        setTimeout(() => refreshJobsFromBackground(), 400);
        return;
      }
      if (act === "resume" && jobId) {
        btn.disabled = true;
        const r = await chrome.runtime.sendMessage({
          type: "RESUME_DOWNLOAD",
          jobId
        });
        if (r?.ok === false) {
          toast(r.error || "다시 시작 실패", "error");
          btn.disabled = false;
          return;
        }
        toast("다시 시작합니다", "ok");
        ensureQueuePoll();
        await refreshJobsFromBackground();
        return;
      }
      // Continue with other acts using same handler body — re-read rest of function
      await handleQueueAction(act, { url, path, did, jobId, btn });
    } catch (err) {
      btn.disabled = false;
      toast(String(err?.message || err || "실패"), "error");
    }
  });
}

async function handleQueueAction(act, { url, path, did, jobId, btn }) {
  if (act === "dismiss") {
    const id = btn?.getAttribute("data-job") || jobId || "";
    if (id) {
      uiJobs.delete(id);
      renderDownloadQueue(true);
    }
    return;
  }
  if (act === "play_retry" && url) {
    await chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    toast("페이지에서 재생을 시작한 뒤 다시 받기를 누르세요", "ok");
    return;
  }
  if (act === "retry" && url) {
    await downloadByPastedLink(url, { skipDupCheck: true });
    return;
  }
  if (act === "open" && url) {
    await chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    return;
  }
  if (act === "login" && url) {
    let loginUrl = url;
    try {
      const u = new URL(url);
      loginUrl = u.origin + "/";
    } catch {
      /* keep */
    }
    await chrome.runtime.sendMessage({ type: "OPEN_URL", url: loginUrl });
    toast("로그인 후 다시 받아 주세요", "ok");
    return;
  }
  if (act === "helper_start") {
    await downloadHelperStarter();
    return;
  }
  if (act === "helper") {
    showHelperHelp();
    return;
  }
  if (act === "show") {
    await chrome.runtime.sendMessage({
      type: "SHOW_DOWNLOAD",
      downloadId: did ? Number(did) : null,
      path
    });
  }
}

async function downloadHelperStarter() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_HELPER_STARTER"
    });
    if (res?.ok) {
      toast(
        res.hint ||
          "다운로드에 UVD-도우미-시작.command 저장됨 · 더블클릭 실행",
        "ok"
      );
      startHelperPoll();
      // Keep rechecking until helper is up
      setTimeout(() => refreshHelperStatus(true), 2000);
      setTimeout(() => refreshHelperStatus(true), 5000);
    } else {
      toast(res?.error || "실행 파일 저장 실패", "error");
      showHelperHelp();
    }
  } catch (e) {
    toast(userError(e?.message) || "실행 파일 저장 실패", "error");
    showHelperHelp();
  }
}

function showHelperHelp() {
  toast(
    "① 「실행 파일」저장 후 더블클릭  ② 또는 helper/start_background.command",
    "error"
  );
  chrome.runtime
    .sendMessage({
      type: "OPEN_URL",
      url: "https://github.com/moveurass/video-downloader-extension#helper"
    })
    .catch(() => {});
}

/* ── Tabs / settings / history ─────────────────────────── */

function switchTab(name) {
  activeTabName = name;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.getAttribute("data-tab") === name);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `tab-${name}`);
  });
  if (name === "history") loadHistoryUi();
  if (name === "watch") loadWatchlistUi();
  if (name === "settings") fillSettingsForm();
  if (name === "main") loadRecentStrip();
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (res?.settings) uvdSettings = res.settings;
  } catch {
    try {
      uvdSettings = await UVD.getSettings();
    } catch {
      /* defaults */
    }
  }
  applyModeChips();
  applyCompactUi();
  updateFooterNote();
}

function applyCompactUi() {
  applyUiLayout();
}

function applyUiLayout() {
  const width = uvdSettings.popupWidth || "normal";
  document.body.classList.remove("width-narrow", "width-normal", "width-wide");
  document.body.classList.add(
    width === "narrow"
      ? "width-narrow"
      : width === "wide"
        ? "width-wide"
        : "width-normal"
  );

  const density =
    uvdSettings.uiDensity ||
    (uvdSettings.compactUi === false ? "full" : "compact");
  document.body.classList.remove("compact-ui", "ultra-ui", "full-ui");
  if (density === "ultra") {
    document.body.classList.add("compact-ui", "ultra-ui");
  } else if (density === "full") {
    document.body.classList.add("full-ui");
  } else {
    document.body.classList.add("compact-ui");
  }
}

function applyModeChips() {
  const mode = uvdSettings.mediaMode || "video";
  document.querySelectorAll(".mode-chip").forEach((c) => {
    c.classList.toggle("active", c.getAttribute("data-mode") === mode);
  });
}

function updateFooterNote() {
  const el = $("#footerNote");
  if (!el) return;
  const folder = uvdSettings.subfolder || "VideoDownloader";
  const mode = UVD.mediaModeLabel(uvdSettings.mediaMode);
  el.textContent = `저장: 다운로드/${folder} · ${mode} · v1.23.3`;
}

function fillSettingsForm() {
  const sub = $("#setSubfolder");
  const tpl = $("#setTemplate");
  const mode = $("#setMediaMode");
  const notify = $("#setNotify");
  const clip = $("#setClipboard");
  const warnDup = $("#setWarnDup");
  const qbs = uvdSettings.qualityBySite || {};
  if (sub) sub.value = uvdSettings.subfolder || "VideoDownloader";
  if (tpl) {
    // Always show/use readable legacy names
    tpl.value = "legacy";
  }
  if (mode) mode.value = uvdSettings.mediaMode || "video";
  if (notify) notify.checked = uvdSettings.notifyOnComplete !== false;
  if (clip) clip.checked = !!uvdSettings.clipboardWatch;
  if (warnDup) warnDup.checked = uvdSettings.warnDuplicates !== false;
  updateHelperOutDirUi(helperOutDirCache);
  // Refresh helper path when opening settings
  chrome.runtime
    .sendMessage({ type: "YTDLP_HEALTH", force: false })
    .then((h) => {
      if (h?.outDir) helperOutDirCache = String(h.outDir);
      updateHelperOutDirUi(helperOutDirCache);
    })
    .catch(() => updateHelperOutDirUi(""));
  const saveThumb = $("#setSaveThumb");
  if (saveThumb) saveThumb.checked = uvdSettings.saveThumbnail !== false;
  const density = $("#setUiDensity");
  if (density) {
    density.value =
      uvdSettings.uiDensity ||
      (uvdSettings.compactUi === false ? "full" : "compact");
  }
  const width = $("#setPopupWidth");
  if (width) width.value = uvdSettings.popupWidth || "normal";
  const badge = $("#setShowBadge");
  if (badge) badge.checked = uvdSettings.showBadge !== false;
  const seriesC = $("#setSeriesComplete");
  if (seriesC) seriesC.checked = uvdSettings.seriesComplete !== false;
  const seriesN = $("#setSeriesCount");
  if (seriesN) {
    const n = String(uvdSettings.seriesCompleteCount || 5);
    if ([...seriesN.options].some((o) => o.value === n)) seriesN.value = n;
  }
  const compact = $("#setCompact");
  if (compact) compact.checked = uvdSettings.compactUi !== false;
  loadSitePacksUi();
  const setSel = (id, val) => {
    const el = $(id);
    if (!el) return;
    const v = val || "best";
    if ([...el.options].some((o) => o.value === v)) el.value = v;
    else el.value = "best";
  };
  setSel("#setQDefault", qbs.default);
  setSel("#setQYoutube", qbs.youtube);
  setSel("#setQTiktok", qbs.tiktok);
  setSel("#setQInstagram", qbs.instagram);
  setSel("#setQX", qbs.x);
  setSel("#setQFacebook", qbs.facebook);
  setSel("#setQBilibili", qbs.bilibili);
  const codec = $("#setCodecPref");
  if (codec) {
    const cp = uvdSettings.codecPref || "best";
    codec.value = ["best", "h264", "compat"].includes(cp) ? cp : "best";
  }
  const speed = $("#setDownloadSpeed");
  if (speed) {
    const sp = uvdSettings.downloadSpeed || "fast";
    speed.value = ["fast", "normal", "safe"].includes(sp) ? sp : "fast";
  }
  updateSettingsPreview();
}

function updateSettingsPreview() {
  const tpl =
    $("#setTemplate")?.value ||
    uvdSettings.filenameTemplate ||
    "legacy";
  const mode = $("#setMediaMode")?.value || uvdSettings.mediaMode || "video";
  const base =
    UVD.applyFilenameTemplate(tpl, {
      title: "SSIS-001 예제 영상 제목",
      quality: "1080p",
      site: "youtube",
      mediaMode: mode
    }) || "SSIS-001 예제 영상 제목_1080p";
  const ext = mode === "audio" ? ".mp3" : ".mp4";
  const prev = $("#setPreview");
  if (prev) {
    prev.textContent = `${uvdSettings.subfolder || $("#setSubfolder")?.value || "VideoDownloader"}/${base}${
      base.endsWith(ext) ? "" : ext
    }`;
  }
}

async function saveSettingsFromForm() {
  // Always readable legacy filenames (title + optional quality)
  const tpl = "legacy";
  const uiDensity = $("#setUiDensity")?.value || "compact";
  const patch = {
    subfolder: $("#setSubfolder")?.value?.trim() || "VideoDownloader",
    filenameTemplate: tpl,
    mediaMode: $("#setMediaMode")?.value || "video",
    notifyOnComplete: $("#setNotify")?.checked !== false,
    clipboardWatch: !!$("#setClipboard")?.checked,
    warnDuplicates: $("#setWarnDup")?.checked !== false,
    saveThumbnail: $("#setSaveThumb")?.checked !== false,
    uiDensity,
    compactUi: uiDensity !== "full",
    popupWidth: $("#setPopupWidth")?.value || "normal",
    showBadge: $("#setShowBadge")?.checked !== false,
    seriesComplete: $("#setSeriesComplete")?.checked !== false,
    seriesCompleteCount: parseInt($("#setSeriesCount")?.value || "5", 10) || 5,
    codecPref: $("#setCodecPref")?.value || "best",
    downloadSpeed: $("#setDownloadSpeed")?.value || "fast",
    qualityBySite: {
      default: $("#setQDefault")?.value || "best",
      youtube: $("#setQYoutube")?.value || "best",
      tiktok: $("#setQTiktok")?.value || "best",
      instagram: $("#setQInstagram")?.value || "best",
      x: $("#setQX")?.value || "best",
      facebook: $("#setQFacebook")?.value || "best",
      bilibili: $("#setQBilibili")?.value || "best"
    }
  };
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SET_SETTINGS",
      settings: patch
    });
    uvdSettings = res?.settings || patch;
    applyModeChips();
    applyUiLayout();
    updateFooterNote();
    setupClipboardWatch();
    // Re-apply site quality to current video
    if (currentTabUrl) applySiteDefaultQuality(currentTabUrl);
    // Refresh badge policy
    chrome.runtime.sendMessage({ type: "REFRESH_BADGE" }).catch(() => {});
    toast("설정을 저장했습니다", "ok");
    if (allItems[0]) render();
  } catch (e) {
    toast(userError(e?.message) || "설정 저장 실패", "error");
  }
}

/* ── Clipboard watch (opt-in) ─────────────────────────── */
let clipWatchTimer = null;
let lastClipSeen = "";
let dismissedClip = "";

function showClipBanner(url) {
  const ban = $("#clipBanner");
  const urlEl = $("#clipBannerUrl");
  if (!ban || !urlEl) return;
  urlEl.textContent = url;
  urlEl.title = url;
  ban.dataset.url = url;
  ban.classList.remove("hidden");
}

function hideClipBanner() {
  $("#clipBanner")?.classList.add("hidden");
}

async function pollClipboardOnce() {
  if (!uvdSettings.clipboardWatch) return;
  try {
    const text = await navigator.clipboard.readText();
    const urls = UVD.parseUrlsFromText(text);
    const link = urls.find(
      (u) =>
        isYoutubeUrl(u) ||
        isTiktokUrl(u) ||
        isInstagramUrl(u) ||
        isXUrl(u) ||
        isFacebookUrl(u) ||
        isBilibiliUrl(u) ||
        UVD.isPlaylistUrl(u)
    );
    if (!link) return;
    if (link === lastClipSeen || link === dismissedClip) return;
    if (($("#linkInput")?.value || "").includes(link)) return;
    if (currentTabUrl && pageKey(currentTabUrl) === pageKey(link)) return;
    lastClipSeen = link;
    showClipBanner(link);
  } catch {
    /* permission denied — ignore silently */
  }
}

function setupClipboardWatch() {
  if (clipWatchTimer) {
    clearInterval(clipWatchTimer);
    clipWatchTimer = null;
  }
  if (!uvdSettings.clipboardWatch) {
    hideClipBanner();
    return;
  }
  pollClipboardOnce();
  clipWatchTimer = setInterval(pollClipboardOnce, 2500);
}

async function loadHistoryUi() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "QUERY_LIBRARY",
      query: {
        q: libFilter.q,
        status: libFilter.status || "done",
        site: libFilter.site || "",
        series: libFilter.series || ""
      }
    });
    if (res?.ok && Array.isArray(res.items)) {
      historyItems = res.items;
    } else {
      const all = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
      historyItems = all?.history || [];
    }
  } catch {
    try {
      historyItems = await UVD.queryLibrary(libFilter);
    } catch {
      historyItems = await UVD.getHistory().catch(() => []);
    }
  }
  fillLibraryFilterOptions();
  renderHistory();
  updateRetryFailedButton();
}

async function fillLibraryFilterOptions() {
  const siteSel = $("#libSite");
  const seriesSel = $("#libSeries");
  let all = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
    all = res?.history || [];
  } catch {
    all = await UVD.getHistory().catch(() => []);
  }
  const sites = new Set();
  const series = new Set();
  for (const h of all) {
    if (h?.site) sites.add(h.site);
    if (h?.seriesPrefix) series.add(h.seriesPrefix);
    else if (h?.seriesKey) series.add(String(h.seriesKey).split("-")[0]);
  }
  if (siteSel) {
    const cur = libFilter.site || siteSel.value || "";
    siteSel.innerHTML =
      `<option value="">모든 사이트</option>` +
      [...sites]
        .sort()
        .map(
          (s) =>
            `<option value="${escapeAttr(s)}" ${
              cur === s ? "selected" : ""
            }>${escapeHtml(s)}</option>`
        )
        .join("");
  }
  if (seriesSel) {
    const cur = libFilter.series || seriesSel.value || "";
    seriesSel.innerHTML =
      `<option value="">모든 시리즈</option>` +
      [...series]
        .sort()
        .map(
          (s) =>
            `<option value="${escapeAttr(s)}" ${
              cur === s ? "selected" : ""
            }>${escapeHtml(s)}</option>`
        )
        .join("");
  }
}

async function loadSitePacksUi() {
  const root = $("#sitePackList");
  if (!root) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SITE_PACKS" });
    sitePacksCache = res?.packs || UVD.BUILTIN_SITE_PACKS || [];
  } catch {
    sitePacksCache = UVD.BUILTIN_SITE_PACKS || [];
  }
  root.innerHTML = sitePacksCache
    .map(
      (p) => `
    <label class="site-pack-row">
      <input type="checkbox" data-pack-id="${escapeAttr(p.id)}" ${
        p.enabled !== false ? "checked" : ""
      } />
      <span class="site-pack-meta">
        <span class="site-pack-name">${escapeHtml(p.name || p.id)}</span>
        <span class="site-pack-note">${escapeHtml(
          p.rules?.note || (p.hosts || []).slice(0, 3).join(", ")
        )}</span>
      </span>
    </label>`
    )
    .join("");
  root.querySelectorAll("input[data-pack-id]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const id = inp.getAttribute("data-pack-id");
      sitePacksCache = sitePacksCache.map((p) =>
        p.id === id ? { ...p, enabled: inp.checked } : p
      );
      await chrome.runtime
        .sendMessage({ type: "SET_SITE_PACKS", packs: sitePacksCache })
        .catch(() => {});
      toast(inp.checked ? `${id} 팩 사용` : `${id} 팩 끔`, "ok");
    });
  });
}

function hideSeriesBanner() {
  seriesPending = null;
  hideSeriesVerifyProgress();
  $("#seriesBanner")?.classList.add("hidden");
}

/** Normalize any thumb src the popup can render (http(s), data, blob, //). */
function normalizeThumbSrc(src) {
  if (!src || typeof src !== "string") return "";
  let u = src.trim();
  if (!u) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  return "";
}

/** Current page / card thumbnail to anchor product-code series rows. */
function seriesAnchorThumbnail() {
  try {
    for (const it of allItems || []) {
      const t = normalizeThumbSrc(it?.thumbnail);
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  try {
    const pageKey = UVD?.normalizeUrlKey?.(currentTabUrl || "") || "";
    for (const h of historyItems || []) {
      if (!h?.thumbnail) continue;
      const hk = UVD?.normalizeUrlKey?.(h.pageUrl || h.url || "") || "";
      if (pageKey && hk && pageKey === hk) {
        const t = normalizeThumbSrc(h.thumbnail);
        if (t) return t;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Look up a past library thumb for a product code / series key. */
function historyThumbForSeriesKey(key) {
  if (!key) return "";
  const k = String(key).toUpperCase();
  for (const h of historyItems || []) {
    if (!h?.thumbnail) continue;
    const sk = String(h.seriesKey || "").toUpperCase();
    const title = String(h.title || "").toUpperCase();
    if (sk === k || title.includes(k)) {
      const t = normalizeThumbSrc(h.thumbnail);
      if (t) return t;
    }
  }
  return "";
}

/**
 * If current cover URL embeds the product code, rewrite it for the next code.
 * Works well on 123av / missav style CDNs: .../ssis-001/cover.jpg → ssis-002
 */
function rewriteThumbForSeriesKey(thumbUrl, fromKey, toKey) {
  const src = normalizeThumbSrc(thumbUrl);
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
  if (!fromKey || !toKey || fromKey === toKey) return "";
  const variants = (k) => {
    const u = String(k);
    const lower = u.toLowerCase();
    const upper = u.toUpperCase();
    const noHyphen = u.replace(/[-_]/g, "");
    return [
      u,
      lower,
      upper,
      lower.replace(/-/g, "_"),
      upper.replace(/-/g, "_"),
      lower.replace(/-/g, ""),
      upper.replace(/-/g, ""),
      noHyphen.toLowerCase(),
      noHyphen.toUpperCase()
    ];
  };
  const froms = variants(fromKey);
  const tos = variants(toKey);
  let out = src;
  let hit = false;
  for (let i = 0; i < froms.length; i++) {
    const f = froms[i];
    const t = tos[i] || tos[0];
    if (!f || f.length < 3) continue;
    if (out.includes(f)) {
      out = out.split(f).join(t);
      hit = true;
    }
  }
  if (!hit || out === src) return "";
  return out;
}

/** Guess next product-code URLs (same logic spirit as background) */
function guessSeriesItemUrls(pageUrl, info, nexts) {
  let host = "";
  try {
    host = new URL(pageUrl).origin;
  } catch {
    host = "";
  }
  const anchorThumb = seriesAnchorThumbnail();
  const fromKey = info?.key || "";
  return nexts.map((n, i) => {
    let nextUrl = "";
    if (pageUrl && info.key) {
      nextUrl = pageUrl.replace(
        new RegExp(info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        n.key
      );
      if (nextUrl === pageUrl) {
        nextUrl = pageUrl.replace(
          new RegExp(`${info.prefix}[-_]?${info.num}`, "i"),
          n.key
        );
      }
    }
    // Also try lowercase path codes (123av often uses /v/ssis-001)
    if ((!nextUrl || nextUrl === pageUrl) && pageUrl && info.key) {
      const low = pageUrl.replace(
        new RegExp(info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
        n.key.toLowerCase()
      );
      if (low !== pageUrl) nextUrl = low;
    }
    let destNote = "URL 추정";
    if (!nextUrl || nextUrl === pageUrl) {
      if (host) {
        // 123av-style search paths
        if (/123av|missav|jable|njav|netflav|supjav/i.test(host)) {
          nextUrl = `${host}/en/search?keyword=${encodeURIComponent(n.key)}`;
          destNote = "사이트 검색";
        } else {
          nextUrl = `${host}/search?q=${encodeURIComponent(n.key)}`;
          destNote = "사이트 검색";
        }
      } else {
        nextUrl = `https://www.google.com/search?q=${encodeURIComponent(
          n.key + " video"
        )}`;
        destNote = "검색 링크";
      }
    } else {
      destNote = "주소 패턴 추정";
    }
    const histThumb = historyThumbForSeriesKey(n.key);
    const rewritten = rewriteThumbForSeriesKey(anchorThumb, fromKey, n.key);
    // Prefer: history → code-rewritten cover → (first row only) soft current
    const soft = !histThumb && !rewritten && i === 0 && !!anchorThumb;
    return {
      key: n.key,
      title: `${n.label || n.key}`,
      // Readable label so user knows what it is
      displayTitle: `다음 ${i + 1}편 · ${n.label || n.key}`,
      url: nextUrl,
      destNote,
      thumbnail: histThumb || rewritten || (soft ? anchorThumb : "") || "",
      softThumb: soft || (!!rewritten && !histThumb),
      selected: true
    };
  });
}

function shortUrlDisplay(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/+$/, "");
    const s = u.hostname.replace(/^www\./, "") + path;
    return s.length > 48 ? s.slice(0, 46) + "…" : s;
  } catch {
    return String(url).slice(0, 48);
  }
}

/** True if string looks like a YouTube video id (not a product code / list id). */
function isYouTubeVideoId(raw) {
  const id = String(raw || "").trim();
  if (!id) return false;
  // Product codes like SSIS-001 — not YT
  if (/^[A-Z]{2,12}[-_ ]?\d{2,6}$/i.test(id)) return false;
  // Playlist / radio list ids
  if (/^(PL|UU|LL|FL|OL|RD|SD|UL)[\w-]{10,}$/i.test(id)) return false;
  // Standard YT video ids are 11 chars [A-Za-z0-9_-]
  return /^[\w-]{11}$/.test(id);
}

/** Pull a YouTube video id out of a ytimg / img.youtube poster URL. */
function youtubeVideoIdFromThumbUrl(url) {
  const m = String(url || "").match(
    /(?:ytimg\.com|img\.youtube\.com)\/vi\/([\w-]{11})\//i
  );
  return m && isYouTubeVideoId(m[1]) ? m[1] : "";
}

/**
 * Extract a YouTube video id from id / key / url / thumbnail.
 * Order prefers explicit video identity over poster URL (poster can be wrong/shared).
 */
function youtubeVideoIdFromItem(item) {
  if (!item) return "";
  const tryId = (raw) => (isYouTubeVideoId(raw) ? String(raw).trim() : "");

  let vid = tryId(item.id) || tryId(item.key) || tryId(item.videoId);
  if (vid) return vid;

  const url = String(item.url || item.pageUrl || item.webpage_url || "");
  if (url) {
    // Bare 11-char id as url
    if (tryId(url)) return tryId(url);
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "youtu.be") {
        vid = tryId(u.pathname.replace(/^\//, "").split("/")[0]);
        if (vid) return vid;
      }
      if (
        host.includes("youtube.com") ||
        host.includes("youtube-nocookie.com") ||
        host.includes("music.youtube.com")
      ) {
        vid = tryId(u.searchParams.get("v"));
        if (vid) return vid;
        const m = u.pathname.match(
          /\/(?:shorts|embed|live|v|watch)\/([\w-]{11})/i
        );
        if (m && tryId(m[1])) return m[1];
      }
    } catch {
      /* ignore */
    }
    const m2 = url.match(/[?&]v=([\w-]{11})/i);
    if (m2 && tryId(m2[1])) return m2[1];
    const m3 = url.match(/youtu\.be\/([\w-]{11})/i);
    if (m3 && tryId(m3[1])) return m3[1];
  }

  // Last resort: id embedded in poster URL
  return youtubeVideoIdFromThumbUrl(item.thumbnail);
}

/** Stable YouTube poster URL candidates for a video id. */
function youtubePosterUrl(videoId, quality = "hqdefault") {
  if (!videoId || !isYouTubeVideoId(videoId)) return "";
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

/** Ordered candidate poster URLs for a series row. */
function seriesThumbCandidates(item) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const n = normalizeThumbSrc(u);
    if (!n || seen.has(n)) return;
    // Skip giant data URLs already on the item when listing candidates for fetch
    seen.add(n);
    out.push(n);
  };
  const direct = normalizeThumbSrc(item?.thumbnail);
  if (direct) push(direct);
  const vid = youtubeVideoIdFromItem(item);
  if (vid) {
    for (const q of ["hqdefault", "mqdefault", "sddefault", "0", "default"]) {
      push(`https://i.ytimg.com/vi/${vid}/${q}.jpg`);
      push(`https://img.youtube.com/vi/${vid}/${q}.jpg`);
    }
  }
  return out;
}

/** In-memory data-URL cache for series thumbs (popup session). */
const seriesThumbCache = new Map();

/**
 * Fetch image via background (host permissions) → data URL.
 * Popup <img src="https://…"> is frequently blank (CDN / referrer / tracking).
 */
async function fetchThumbDataUrl(url) {
  const key = String(url || "").trim();
  if (!key) return "";
  if (key.startsWith("data:image/")) return key;
  if (seriesThumbCache.has(key)) return seriesThumbCache.get(key);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_THUMB",
      url: key,
      tabId: currentTabId
    });
    if (res?.ok && res.dataUrl && String(res.dataUrl).startsWith("data:image/")) {
      seriesThumbCache.set(key, res.dataUrl);
      // Cap cache size
      if (seriesThumbCache.size > 80) {
        const first = seriesThumbCache.keys().next().value;
        seriesThumbCache.delete(first);
      }
      return res.dataUrl;
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function resolveSeriesThumbDataUrl(item) {
  if (!item) return "";
  // Prefer already-resolved data URL on the item
  const existing = normalizeThumbSrc(item.thumbnail);
  if (existing && existing.startsWith("data:image/")) return existing;
  if (existing && seriesThumbCache.has(existing)) {
    return seriesThumbCache.get(existing);
  }
  const candidates = seriesThumbCandidates(item);
  for (const url of candidates) {
    if (url.startsWith("data:image/")) return url;
    const data = await fetchThumbDataUrl(url);
    if (data) return data;
  }
  return "";
}

/**
 * After list paint: load each row thumb via privileged fetch and swap in.
 * token guards against stale renders when the list is rebuilt.
 */
let seriesThumbHydrateToken = 0;
async function hydrateSeriesThumbs() {
  const token = ++seriesThumbHydrateToken;
  const list = $("#seriesBannerList");
  if (!list || !seriesPending?.items?.length) return;
  const items = seriesPending.items;
  const jobs = items.map((_, i) => i);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const idx = jobs[cursor++];
      if (token !== seriesThumbHydrateToken) return;
      if (!seriesPending?.items?.[idx]) return;
      const item = seriesPending.items[idx];
      const dataUrl = await resolveSeriesThumbDataUrl(item);
      if (token !== seriesThumbHydrateToken) return;
      const li = list.querySelector(
        `li.series-preview-item[data-series-idx="${idx}"]`
      );
      if (!dataUrl) {
        const ph = li?.querySelector("span.series-preview-thumb-ph");
        if (ph) {
          ph.classList.remove("is-loading");
          ph.textContent = ph.getAttribute("data-ph") || "?";
        }
        continue;
      }
      // Store so re-render keeps it
      seriesPending.items[idx].thumbnail = dataUrl;
      seriesPending.items[idx].softThumb = false;
      if (seriesPending.allItems) {
        const key = String(item.id || item.key || item.url || "");
        for (const a of seriesPending.allItems) {
          const ak = String(a.id || a.key || a.url || "");
          if (key && ak && key === ak) {
            a.thumbnail = dataUrl;
            a.softThumb = false;
          }
        }
      }
      if (!li) continue;
      let img = li.querySelector("img.series-preview-thumb");
      if (!img) {
        const ph = li.querySelector("span.series-preview-thumb-ph");
        img = document.createElement("img");
        img.className = "series-preview-thumb";
        img.alt = "";
        img.setAttribute("data-series-idx", String(idx));
        if (ph) ph.replaceWith(img);
        else li.insertBefore(img, li.querySelector(".series-preview-body"));
      }
      img.classList.remove("is-soft", "is-loading");
      img.src = dataUrl;
    }
  });
  await Promise.all(workers);
}

/**
 * Normalize a playlist/series entry so id/url/thumbnail are per-video.
 * Fixes cases where helper returns a shared playlist cover for every row.
 */
function normalizeSeriesPlaylistEntry(e, index = 0) {
  const raw = e || {};
  let id =
    (isYouTubeVideoId(raw.id) && String(raw.id).trim()) ||
    (isYouTubeVideoId(raw.key) && String(raw.key).trim()) ||
    youtubeVideoIdFromItem(raw) ||
    "";
  let url = String(raw.url || raw.webpage_url || "").trim();
  if (id && (!url || !/^https?:/i.test(url))) {
    url = `https://www.youtube.com/watch?v=${id}`;
  } else if (url && !id) {
    id = youtubeVideoIdFromItem({ ...raw, url, id: "", key: "" }) || "";
  }
  // Always rebuild YT poster from *this* row's video id — never trust a
  // shared playlist-level thumbnail that yt-dlp may attach to every entry.
  let thumbnail = "";
  if (id) {
    thumbnail = youtubePosterUrl(id, "hqdefault");
  } else {
    thumbnail = normalizeThumbSrc(raw.thumbnail) || "";
  }
  return {
    title: raw.title || id || `영상 ${index + 1}`,
    url: url || raw.url || "",
    key: id || raw.key || raw.id || "",
    id: id || raw.id || "",
    duration: raw.duration || 0,
    thumbnail,
    uploader: raw.uploader || "",
    destNote: raw.destNote || "재생목록",
    selected: raw.selected !== false,
    softThumb: false
  };
}

/** Best-effort thumbnail for a series preview row */
function seriesItemThumbnail(item) {
  if (!item) return "";
  const vid = youtubeVideoIdFromItem(item);
  if (vid) return youtubePosterUrl(vid, "hqdefault");
  return normalizeThumbSrc(item.thumbnail) || "";
}

function seriesRangeLimit(pref) {
  const p = pref == null ? seriesRangePref : pref;
  if (p === "all") return 999;
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function resolveSeriesIdFromPayload(payload) {
  if (payload?.seriesId) return String(payload.seriesId);
  if (payload?.mode === "product_code") {
    return `series:code:${payload.seriesKey || payload.seriesPrefix || "series"}`;
  }
  const url = payload?.listUrl || payload?.pageUrl || "";
  try {
    const list = new URL(url).searchParams.get("list");
    if (list) return `series:pl:${list}`;
  } catch {
    /* ignore */
  }
  return `series:${Date.now()}`;
}

/** Apply downloaded flags + range window onto seriesPending.items for display. */
function rebuildSeriesVisibleItems() {
  if (!seriesPending) return;
  const all = seriesPending.allItems || seriesPending.items || [];
  const limit = seriesRangeLimit(seriesPending.rangePref ?? seriesRangePref);
  // Annotate downloaded from history
  let annotated = all;
  try {
    if (UVD.annotateSeriesDownloaded) {
      annotated = UVD.annotateSeriesDownloaded(all, historyItems || []);
    }
  } catch {
    annotated = all;
  }
  // "빠진 편만" — hide already-downloaded from the list
  let pool = annotated;
  if (seriesPending.missingOnly) {
    pool = annotated.filter((x) => !x.downloaded);
  }
  // Preserve user selection across rebuild when possible
  const prevSel = new Map(
    (seriesPending.items || []).map((x, i) => [
      String(x.id || x.key || x.url || i),
      x.selected
    ])
  );
  const windowed = pool.slice(0, limit).map((x, i) => {
    const k = String(x.id || x.key || x.url || i);
    let selected = x.selected;
    if (prevSel.has(k)) selected = prevSel.get(k);
    // Downloaded default off unless user re-checked
    if (x.downloaded && !prevSel.has(k)) selected = false;
    if (selected == null) selected = !x.downloaded;
    // missingOnly view: default all selected
    if (seriesPending.missingOnly && !prevSel.has(k)) selected = true;
    return {
      ...x,
      index: i,
      seriesIndex: x.seriesIndex || i + 1,
      selected: selected !== false
    };
  });
  seriesPending.allItems = annotated;
  seriesPending.items = windowed;
  seriesPending.rangePref = seriesPending.rangePref || seriesRangePref;
  seriesPending.seriesId =
    seriesPending.seriesId || resolveSeriesIdFromPayload(seriesPending);
}

function showSeriesBanner(payload) {
  const incoming = payload.items || [];
  const isLoading = !!payload.loading;
  // Keep full list separately for range chips
  const allItems = isLoading
    ? []
    : (payload.allItems || incoming).map((x, i) => ({
        ...x,
        seriesIndex: x.seriesIndex || i + 1
      }));

  seriesPending = {
    ...payload,
    allItems,
    rangePref: payload.rangePref || seriesRangePref,
    seriesId: payload.seriesId || resolveSeriesIdFromPayload(payload),
    items: []
  };
  if (!isLoading) rebuildSeriesVisibleItems();
  else seriesPending.items = [];

  const ban = $("#seriesBanner");
  const title = $("#seriesBannerTitle");
  const dest = $("#seriesBannerDest");
  const sub = $("#seriesBannerSub");
  const list = $("#seriesBannerList");
  const toolbar = $("#seriesToolbar");
  if (!ban) return;
  ban.classList.remove("hidden");
  if (toolbar) toolbar.classList.toggle("hidden", isLoading);

  renderSeriesRangeChips();
  renderSeriesListBody();
  updateSeriesGoButton();
  updateSeriesRetryButton();

  const items = seriesPending.items || [];
  const n = items.length;
  const totalAll = (seriesPending.allItems || []).length;
  const doneN = (seriesPending.allItems || []).filter((x) => x.downloaded).length;
  const isPl = seriesPending.mode === "playlist";
  const destLabel = isPl ? "바로 받기 (큐)" : "나중 받기";

  if (title) {
    title.textContent = isPl
      ? `재생목록 · ${totalAll || n}편`
      : `시리즈 ${seriesPending.seriesKey || ""} · 다음 ${totalAll || n}편`;
  }
  if (dest) {
    dest.textContent = destLabel;
    dest.classList.toggle("is-watch", !isPl);
  }
  if (sub) {
    if (isLoading) {
      sub.textContent =
        seriesPending.mode === "product_code"
          ? "실제로 있는 다음 편만 확인하는 중… (없는 번호는 제외)"
          : "받을 목록을 확인하는 중…";
    } else if (!n && !totalAll) {
      sub.textContent = "받을 항목이 없습니다.";
    } else if (isPl) {
      sub.textContent = `체크한 영상을 큐에 넣습니다 · 화질: ${
        selectedQuality === "best" ? "최고" : selectedQuality
      }${doneN ? ` · 이미 받음 ${doneN}` : ""}`;
    } else {
      sub.textContent = `페이지에서 확인된 편만 표시합니다${
        doneN ? ` · 이미 받음 ${doneN}` : ""
      } · 「나중」받기에 추가`;
    }
  }

  try {
    ban.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    /* ignore */
  }
}

function renderSeriesRangeChips() {
  const root = $("#seriesRange");
  if (!root || !seriesPending) return;
  const pref = String(seriesPending.rangePref || seriesRangePref);
  root.querySelectorAll(".series-range-chip").forEach((btn) => {
    const r = btn.getAttribute("data-range");
    btn.classList.toggle("active", r === pref);
  });
  const miss = $("#btnSeriesMissingOnly");
  if (miss) {
    miss.classList.toggle("active", !!seriesPending.missingOnly);
    miss.setAttribute("aria-pressed", seriesPending.missingOnly ? "true" : "false");
  }
}

function toggleSeriesMissingOnly(on) {
  if (!seriesPending) return;
  seriesPending.missingOnly =
    on == null ? !seriesPending.missingOnly : !!on;
  rebuildSeriesVisibleItems();
  renderSeriesRangeChips();
  renderSeriesListBody();
  updateSeriesGoButton();
  const sub = $("#seriesBannerSub");
  if (sub && !seriesPending.loading) {
    const items = seriesPending.items || [];
    const totalAll = (seriesPending.allItems || []).length;
    const doneN = (seriesPending.allItems || []).filter((x) => x.downloaded).length;
    if (seriesPending.missingOnly) {
      sub.textContent = `빠진 편만 · ${items.length}편${
        doneN ? ` (받음 ${doneN} 숨김)` : ""
      } · 전체 ${totalAll}`;
    }
  }
}

function renderSeriesListBody() {
  const list = $("#seriesBannerList");
  if (!list || !seriesPending) return;
  if (seriesPending.loading) {
    list.innerHTML = `<li class="series-preview-empty">불러오는 중…</li>`;
    return;
  }
  const items = seriesPending.items || [];
  const isPl = seriesPending.mode === "playlist";
  if (!items.length) {
    list.innerHTML = `<li class="series-preview-empty">표시할 항목이 없습니다</li>`;
    return;
  }
  list.innerHTML = items
    .map((x, i) => {
      const name = x.title || x.key || x.label || `항목 ${i + 1}`;
      const thumb = seriesItemThumbnail(x);
      const chips = [];
      if (x.downloaded) {
        chips.push(`<span class="series-preview-chip done">받음</span>`);
      }
      if (x.key && String(x.key) !== String(name)) {
        chips.push(
          `<span class="series-preview-chip key">${escapeHtml(
            String(x.key)
          )}</span>`
        );
      }
      if (x.duration) {
        chips.push(
          `<span class="series-preview-chip dur">${escapeHtml(
            formatDurShort(x.duration)
          )}</span>`
        );
      }
      if (x.uploader) {
        chips.push(
          `<span class="series-preview-chip">${escapeHtml(
            String(x.uploader).slice(0, 24)
          )}</span>`
        );
      }
      if (isPl) {
        chips.push(`<span class="series-preview-chip">바로 받기</span>`);
      } else {
        chips.push(`<span class="series-preview-chip">나중 받기</span>`);
      }
      const metaLine = x.url ? shortUrlDisplay(x.url) : x.destNote || "";
      const phLabel = (x.key || name || "?").slice(0, 10);
      // Prefer already-resolved data: URLs; otherwise show loading shell.
      // Real image is injected by hydrateSeriesThumbs() via privileged fetch.
      const ready =
        thumb && String(thumb).startsWith("data:image/")
          ? thumb
          : seriesThumbCache.get(thumb) || "";
      const thumbHtml = ready
        ? `<img class="series-preview-thumb" src="${escapeAttr(
            ready
          )}" alt="" decoding="async" data-series-idx="${i}" data-ph="${escapeAttr(
            phLabel
          )}" />`
        : `<span class="series-preview-thumb-ph is-loading" data-series-idx="${i}" data-ph="${escapeAttr(
            phLabel
          )}">${escapeHtml(phLabel)}</span>`;
      return `<li class="series-preview-item${
        x.downloaded ? " is-done" : ""
      }" data-series-idx="${i}">
            <input type="checkbox" data-series-idx="${i}" ${
              x.selected !== false ? "checked" : ""
            } />
            ${thumbHtml}
            <span class="series-preview-body">
              <span class="series-preview-name" title="${escapeAttr(
                name
              )}">${i + 1}. ${escapeHtml(name)}</span>
              ${
                metaLine
                  ? `<span class="series-preview-meta" title="${escapeAttr(
                      x.url || metaLine
                    )}">${escapeHtml(metaLine)}</span>`
                  : ""
              }
              ${
                chips.length
                  ? `<span class="series-preview-chips">${chips.join("")}</span>`
                  : ""
              }
            </span>
          </li>`;
    })
    .join("");
  list.querySelectorAll("input[data-series-idx]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.getAttribute("data-series-idx"), 10);
      if (seriesPending?.items?.[idx]) {
        seriesPending.items[idx].selected = inp.checked;
      }
      updateSeriesGoButton();
    });
  });
  // Load posters via background fetch (reliable in extension popup)
  hydrateSeriesThumbs().catch(() => {});
}

function setSeriesSelection(mode) {
  if (!seriesPending?.items?.length) return;
  for (const it of seriesPending.items) {
    if (mode === "all") it.selected = true;
    else if (mode === "none") it.selected = false;
    else if (mode === "pending") it.selected = !it.downloaded;
  }
  renderSeriesListBody();
  updateSeriesGoButton();
}

function setSeriesRange(pref) {
  seriesRangePref = pref === "all" ? "all" : String(pref);
  if (!seriesPending) return;
  seriesPending.rangePref = seriesRangePref;
  rebuildSeriesVisibleItems();
  renderSeriesRangeChips();
  renderSeriesListBody();
  updateSeriesGoButton();
  const sub = $("#seriesBannerSub");
  const title = $("#seriesBannerTitle");
  const items = seriesPending.items || [];
  const totalAll = (seriesPending.allItems || []).length;
  const doneN = (seriesPending.allItems || []).filter((x) => x.downloaded).length;
  const isPl = seriesPending.mode === "playlist";
  if (title) {
    title.textContent = isPl
      ? `재생목록 · ${totalAll || items.length}편`
      : `시리즈 ${seriesPending.seriesKey || ""} · 다음 ${totalAll || items.length}편`;
  }
  if (sub && !seriesPending.loading) {
    if (isPl) {
      sub.textContent = `표시 ${items.length}/${totalAll || items.length} · 화질: ${
        selectedQuality === "best" ? "최고" : selectedQuality
      }${doneN ? ` · 이미 받음 ${doneN}` : ""}`;
    } else {
      sub.textContent = `표시 ${items.length}/${totalAll || items.length}${
        doneN ? ` · 이미 받음 ${doneN}` : ""
      }`;
    }
  }
}

function updateSeriesGoButton() {
  const goBtn = $("#btnSeriesGo");
  if (!goBtn || !seriesPending) return;
  const sel = (seriesPending.items || []).filter((x) => x.selected !== false);
  const n = sel.length;
  const isPl = seriesPending.mode === "playlist";
  const skipDone = sel.filter((x) => x.downloaded).length;
  goBtn.disabled = n === 0 || !!seriesPending.loading;
  if (n === 0) {
    goBtn.textContent = "선택 없음";
  } else if (isPl) {
    goBtn.textContent =
      skipDone > 0 && skipDone < n
        ? `${n}편 바로 받기 · 받음 ${skipDone}`
        : `${n}편 바로 받기`;
  } else {
    goBtn.textContent = `${n}편 나중 받기에 추가`;
  }
}

async function updateSeriesRetryButton() {
  const btn = $("#btnSeriesRetryFailed");
  if (!btn) return;
  const sid = seriesPending?.seriesId || lastSeriesRun?.seriesId || "";
  if (!sid) {
    btn.classList.add("hidden");
    return;
  }
  let failed = [];
  try {
    failed = await UVD.getFailedRetryable({ seriesId: sid });
  } catch {
    failed = (historyItems || []).filter(
      (h) =>
        h?.status === "error" &&
        (h.seriesId === sid ||
          (Array.isArray(h.tags) && h.tags.includes(sid)))
    );
  }
  if (!failed.length) {
    btn.classList.add("hidden");
    btn.textContent = "실패 재시도";
    return;
  }
  btn.classList.remove("hidden");
  btn.textContent = `실패 재시도 · ${failed.length}`;
  btn.title = `이 시리즈 실패 ${failed.length}편 다시 받기`;
}

async function retrySeriesFailed() {
  const sid = seriesPending?.seriesId || lastSeriesRun?.seriesId || "";
  if (!sid) {
    toast("재시도할 시리즈가 없습니다", "error");
    return;
  }
  let failed = [];
  try {
    failed = await UVD.getFailedRetryable({ seriesId: sid });
  } catch {
    failed = [];
  }
  if (!failed.length) {
    toast("이 시리즈 실패 항목이 없습니다", "ok");
    updateSeriesRetryButton();
    return;
  }
  const urls = failed
    .map((h) => h.pageUrl || h.url)
    .filter((u) => /^https?:/i.test(u));
  toast(`${urls.length}편 시리즈 실패 재시도…`, "ok");
  try {
    await refreshHelperStatus(true);
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_BATCH",
      urls: urls.slice(0, 20),
      tabId: currentTabId,
      preferQuality: selectedQuality || "best"
    });
    if (res?.ok) {
      toast(`${res.count || urls.length}편 재시도 시작`, "ok");
      ensureQueuePoll();
      await refreshJobsFromBackground();
    } else {
      toast(userError(res?.error) || "재시도 실패", "error");
    }
  } catch (e) {
    toast(userError(e?.message) || "재시도 실패", "error");
  }
  updateSeriesRetryButton();
}

/** Swap series row thumb in-place when a better URL arrives. */
function patchSeriesRowThumb(index, thumbUrl, { soft = false } = {}) {
  if (!seriesPending?.items?.[index]) return;
  // Resolve via privileged fetch when given an http(s) URL
  const apply = (dataUrl) => {
    if (!dataUrl || !seriesPending?.items?.[index]) return;
    seriesPending.items[index].thumbnail = dataUrl;
    if (!soft) seriesPending.items[index].softThumb = false;
    const list = $("#seriesBannerList");
    if (!list) return;
    const li = list.querySelector(
      `li.series-preview-item[data-series-idx="${index}"]`
    );
    if (!li) return;
    let img = li.querySelector("img.series-preview-thumb");
    const ph = li.querySelector("span.series-preview-thumb-ph");
    if (!img) {
      img = document.createElement("img");
      img.className = "series-preview-thumb";
      img.alt = "";
      img.setAttribute("data-series-idx", String(index));
      if (ph) ph.replaceWith(img);
      else li.insertBefore(img, li.querySelector(".series-preview-body"));
    }
    img.classList.toggle("is-soft", !!soft);
    img.src = dataUrl;
  };
  const src = normalizeThumbSrc(thumbUrl);
  if (!src) return;
  if (src.startsWith("data:image/")) {
    apply(src);
    return;
  }
  fetchThumbDataUrl(src).then((data) => {
    if (data) apply(data);
  });
}

/**
 * Product-code series (123av etc.): scrape next-page og:image via content
 * script / cookies. yt-dlp has no 123av extractor so LIST_QUALITIES alone fails.
 */
async function enrichSeriesThumbnails() {
  if (!seriesPending?.items?.length || seriesPending.loading) return;
  // Playlist YouTube rows hydrate via ytimg — skip
  if (seriesPending.mode === "playlist") return;

  const items = seriesPending.items;
  const jobs = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const url = it?.url || "";
    if (!/^https?:/i.test(url)) continue;
    // Skip pure external search placeholders
    if (/google\.[^/]+\/search/i.test(url)) continue;
    // Need better thumb if missing or soft/rewritten guess
    const hasHard =
      normalizeThumbSrc(it.thumbnail) &&
      !it.softThumb &&
      String(it.thumbnail).startsWith("data:image/");
    if (hasHard) continue;
    jobs.push(i);
  }
  if (!jobs.length) return;

  const limit = 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const idx = jobs[cursor++];
      if (!seriesPending?.items?.[idx]) return;
      const row = seriesPending.items[idx];
      const url = row.url;
      try {
        // 1) Same-site page scrape (best for 123av — uses page cookies)
        const meta = await chrome.runtime
          .sendMessage({
            type: "PROBE_PAGE_META",
            url,
            pageUrl: url,
            tabId: currentTabId
          })
          .catch(() => null);
        if (meta?.ok) {
          if (normalizeThumbSrc(meta.thumbnail)) {
            patchSeriesRowThumb(idx, meta.thumbnail, { soft: false });
          }
          if (meta.title && seriesPending?.items?.[idx]) {
            // Keep key-prefixed label but upgrade real title when useful
            const key = seriesPending.items[idx].key || "";
            const t = String(meta.title).trim();
            if (t.length > 4 && (!key || t.toUpperCase().includes(String(key).toUpperCase()))) {
              seriesPending.items[idx].title = t.length > 80 ? t.slice(0, 78) + "…" : t;
              const nameEl = document.querySelector(
                `#seriesBannerList li[data-series-idx="${idx}"] .series-preview-name`
              );
              if (nameEl) {
                nameEl.textContent = `${idx + 1}. ${seriesPending.items[idx].title}`;
                nameEl.title = seriesPending.items[idx].title;
              }
            }
          }
          if (normalizeThumbSrc(meta.thumbnail)) continue;
        }
        // 2) Optional yt-dlp probe (works on some adult tubes, not 123av)
        if (helperOk) {
          const res = await chrome.runtime
            .sendMessage({
              type: "LIST_QUALITIES",
              url,
              pageUrl: url,
              forceYtDlp: true
            })
            .catch(() => null);
          if (res?.ok && normalizeThumbSrc(res.thumbnail)) {
            patchSeriesRowThumb(idx, res.thumbnail, { soft: false });
          }
        }
      } catch {
        /* ignore per-item */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker())
  );
}

async function ensureHistoryLoaded() {
  if (historyItems?.length) return;
  try {
    historyItems = await UVD.getHistory().catch(() => []);
  } catch {
    historyItems = [];
  }
}

/** Open series banner from a loaded playlistInfo (panel integration). */
async function openSeriesFromPlaylist(info, opts = {}) {
  if (!info?.entries?.length) {
    toast("재생목록이 비어 있습니다", "error");
    return;
  }
  await ensureHistoryLoaded();
  const rangePref =
    opts.rangePref ||
    seriesRangePref ||
    String(uvdSettings.seriesCompleteCount || 5);
  const listUrl = info.url || "";
  let seriesId = "";
  try {
    const list = new URL(listUrl).searchParams.get("list");
    seriesId = list ? `series:pl:${list}` : `series:pl:${UVD.normalizeUrlKey(listUrl)}`;
  } catch {
    seriesId = `series:pl:${Date.now()}`;
  }
  const all = info.entries.map((e, i) => normalizeSeriesPlaylistEntry(e, i));
  showSeriesBanner({
    mode: "playlist",
    title: info.title || "재생목록",
    pageUrl: listUrl,
    listUrl,
    playlistTitle: info.title || "재생목록",
    seriesId,
    seriesKey: "",
    allItems: all,
    items: all,
    rangePref,
    loading: false
  });
  if (!opts.quiet) {
    toast(
      `${all.length}개 항목 · 범위·체크 확인 후 「바로 받기」`,
      "ok"
    );
  }
}

async function offerSeriesComplete(title, pageUrl) {
  if (uvdSettings.seriesComplete === false) {
    toast("설정에서 시리즈 완주가 꺼져 있습니다", "error");
    return;
  }
  const info = UVD.extractSeriesInfo(title || "");
  const hasPl =
    UVD.isPlaylistOnlyUrl(pageUrl) || UVD.isWatchInPlaylistUrl?.(pageUrl);
  if (!info && !hasPl) return;

  await ensureHistoryLoaded();
  // Sync range default with settings when user hasn't touched chips
  if (!seriesRangePref || seriesRangePref === "5") {
    const sc = String(uvdSettings.seriesCompleteCount || 5);
    if (["3", "5", "10"].includes(sc)) seriesRangePref = sc;
  }

  // ── Playlist: load real remaining entries ──
  if (hasPl) {
    showSeriesBanner({
      mode: "playlist",
      title,
      pageUrl,
      seriesKey: info?.key || "",
      items: [],
      loading: true
    });
    try {
      await refreshHelperStatus(true);
      if (!helperOk) {
        showSeriesBanner({
          mode: "playlist",
          title,
          pageUrl,
          items: [],
          loading: false
        });
        toast("재생목록 미리보기는 도우미가 필요합니다", "error");
        return;
      }
      let listUrl = pageUrl;
      if (UVD.isWatchInPlaylistUrl(pageUrl)) {
        try {
          const u = new URL(pageUrl);
          const listId = u.searchParams.get("list");
          if (listId) listUrl = `https://www.youtube.com/playlist?list=${listId}`;
        } catch {
          /* ignore */
        }
      }
      const res = await chrome.runtime.sendMessage({
        type: "LIST_PLAYLIST",
        pageUrl: listUrl,
        max: 200
      });
      if (!res?.ok) throw new Error(res?.error || "목록 조회 실패");
      let entries = res.entries || [];
      const curKey = UVD.normalizeUrlKey(pageUrl);
      entries = entries.filter(
        (e) => UVD.normalizeUrlKey(e.url || "") !== curKey
      );
      if (UVD.isWatchInPlaylistUrl(pageUrl)) {
        try {
          const vid = new URL(pageUrl).searchParams.get("v");
          const idx = entries.findIndex(
            (e) => e.id === vid || (e.url || "").includes(`v=${vid}`)
          );
          if (idx >= 0) entries = entries.slice(idx + 1);
        } catch {
          /* ignore */
        }
      }
      // Keep full remainder; range chips control how many are shown/selected
      const all = entries.map((e, i) => normalizeSeriesPlaylistEntry(e, i));
      let seriesId = "";
      try {
        const list = new URL(listUrl).searchParams.get("list");
        seriesId = list ? `series:pl:${list}` : `series:pl:${UVD.normalizeUrlKey(listUrl)}`;
      } catch {
        seriesId = `series:pl:${Date.now()}`;
      }
      showSeriesBanner({
        mode: "playlist",
        title,
        pageUrl,
        listUrl,
        seriesKey: info?.key || "",
        playlistTitle: res.title || "재생목록",
        seriesId,
        allItems: all,
        items: all,
        rangePref: seriesRangePref,
        loading: false
      });
      if (!all.length) {
        toast("이어서 받을 재생목록 항목이 없습니다", "ok");
      }
    } catch (e) {
      hideSeriesBanner();
      toast(userError(e?.message) || "재생목록 미리보기 실패", "error");
    }
    return;
  }

  // ── Product code: guess next keys, then VERIFY pages exist ──
  if (info) {
    // Continue from library: if we've already saved later codes, start after max
    let baseInfo = { ...info };
    let continueNote = "";
    try {
      const maxInfo = UVD.maxSeriesNumInHistory?.(
        historyItems || [],
        info.prefix
      );
      if (maxInfo && Number.isFinite(maxInfo.num) && maxInfo.num >= info.num) {
        baseInfo = {
          ...info,
          num: maxInfo.num,
          pad: maxInfo.pad || info.pad,
          key: `${info.prefix}-${String(maxInfo.num).padStart(
            maxInfo.pad || info.pad || 3,
            "0"
          )}`
        };
        continueNote = `서재 기준 ${baseInfo.key} 이후부터`;
      }
    } catch {
      /* ignore */
    }

    showSeriesBanner({
      mode: "product_code",
      title,
      pageUrl,
      seriesKey: info.key,
      seriesId: `series:code:${info.prefix || info.key}`,
      items: [],
      allItems: [],
      rangePref: seriesRangePref,
      loading: true
    });
    showSeriesVerifyProgress();
    updateSeriesVerifyProgress({
      index: 0,
      total: 1,
      status: "checking",
      found: 0,
      missing: 0,
      label: continueNote
        ? `${continueNote} · 후보 준비…`
        : `${info.key} 다음 편 후보 준비 중…`
    });
    try {
      // Probe more candidates than UI range; stop early on consecutive misses
      const want = Math.min(
        20,
        Math.max(
          seriesRangeLimit(seriesRangePref),
          uvdSettings.seriesCompleteCount || 5,
          5
        )
      );
      // Over-fetch candidates so we can fill `want` after filtering phantoms
      // Use baseInfo (library-continued) for next keys
      const nexts = UVD.nextSeriesKeys(baseInfo, Math.min(30, want + 8));
      // URL guess still uses current pageUrl + original key patterns
      const guessed = guessSeriesItemUrls(pageUrl, info, nexts).map((x) => ({
        ...x,
        title: x.displayTitle || x.title
      }));
      // For continue: rewrite pageUrl patterns from baseInfo.key if needed
      if (continueNote && baseInfo.key !== info.key) {
        for (const g of guessed) {
          if (g.url && info.key) {
            const alt = pageUrl.replace(
              new RegExp(
                info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
                "i"
              ),
              g.key
            );
            if (alt !== pageUrl) g.url = alt;
          }
        }
      }
      updateSeriesVerifyProgress({
        index: 0,
        total: guessed.length || 1,
        status: "checking",
        found: 0,
        missing: 0,
        label: continueNote
          ? `${continueNote} · 후보 ${guessed.length}개`
          : `후보 ${guessed.length}개 · 목표 ${want}편`
      });
      const verified = await validateProductSeriesItems(guessed, {
        want,
        maxConsecutiveMiss: 2,
        onProgress: updateSeriesVerifyProgress
      });
      // Brief pause so user can read the final progress line
      await new Promise((r) => setTimeout(r, 350));
      hideSeriesVerifyProgress();
      showSeriesBanner({
        mode: "product_code",
        title,
        pageUrl,
        seriesKey: info.key,
        seriesId: `series:code:${info.prefix || info.key}`,
        allItems: verified,
        items: verified,
        rangePref: seriesRangePref,
        loading: false
      });
      if (!verified.length) {
        toast(
          seriesVerifyFailHint() ||
            "실제로 있는 다음 편을 찾지 못했습니다 · 품번 추정만으로는 목록에 넣지 않습니다",
          "error"
        );
      } else {
        const skipped = guessed.length - verified.length;
        toast(
          [
            continueNote || null,
            skipped > 0
              ? `실제 확인 ${verified.length}편 · 없는 번호 ${skipped}개 제외`
              : `실제 확인 ${verified.length}편`
          ]
            .filter(Boolean)
            .join(" · "),
          "ok"
        );
        hydrateSeriesThumbs().catch(() => {});
      }
    } catch (e) {
      hideSeriesVerifyProgress();
      hideSeriesBanner();
      toast(
        seriesProbeErrorHint(e) ||
          userError(e?.message) ||
          "시리즈 목록 확인 실패",
        "error"
      );
    }
  }
}

/** User-facing hint after product-series validation found nothing */
function seriesVerifyFailHint() {
  return "확인된 다음 편이 없습니다 · 사이트가 막혔거나 다음 품번이 없을 수 있어요. 영상 페이지를 연 채 다시 시도하세요";
}

function seriesProbeErrorHint(err) {
  const s = String(err?.message || err || "");
  if (/blocked|cloudflare|just a moment|captcha|403|401/i.test(s)) {
    return "사이트가 차단했습니다 · 123av 탭에서 영상 페이지를 연 뒤 재생하고 다시 「시리즈」를 눌러 주세요";
  }
  if (/cross-origin|content|Receiving end|Could not establish/i.test(s)) {
    return "페이지 연결이 필요합니다 · 해당 사이트 탭을 새로고침한 뒤 다시 시도하세요";
  }
  return null;
}

function showSeriesVerifyProgress() {
  const el = $("#seriesVerifyProgress");
  if (!el) return;
  el.classList.remove("hidden");
  const fill = $("#seriesVerifyFill");
  if (fill) fill.style.width = "0%";
  const text = $("#seriesVerifyText");
  if (text) text.textContent = "확인 준비 중…";
  const count = $("#seriesVerifyCount");
  if (count) count.textContent = "";
  const detail = $("#seriesVerifyDetail");
  if (detail) detail.textContent = "";
}

function hideSeriesVerifyProgress() {
  $("#seriesVerifyProgress")?.classList.add("hidden");
}

/**
 * @param {{
 *   index: number,
 *   total: number,
 *   key?: string,
 *   status?: 'checking'|'found'|'missing'|'skip'|'done'|'stop',
 *   found?: number,
 *   missing?: number,
 *   label?: string
 * }} p
 */
function updateSeriesVerifyProgress(p = {}) {
  const el = $("#seriesVerifyProgress");
  if (!el) return;
  el.classList.remove("hidden");
  const total = Math.max(1, Number(p.total) || 1);
  const index = Math.min(total, Math.max(0, Number(p.index) || 0));
  const found = Number(p.found) || 0;
  const missing = Number(p.missing) || 0;
  const pct = Math.round((index / total) * 100);
  const fill = $("#seriesVerifyFill");
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;

  const text = $("#seriesVerifyText");
  if (text) {
    if (p.status === "done") {
      text.textContent = "확인 완료";
    } else if (p.status === "stop") {
      text.textContent = "연속 없음 · 중단";
    } else if (p.status === "found") {
      text.textContent = "있음 · 목록에 추가";
    } else if (p.status === "missing") {
      text.textContent = "없음 · 건너뜀";
    } else if (p.status === "skip") {
      text.textContent = "검색 링크 · 건너뜀";
    } else {
      text.textContent = "페이지 확인 중…";
    }
  }
  const count = $("#seriesVerifyCount");
  if (count) {
    count.textContent = `${index}/${total} · 확인 ${found}${
      missing ? ` · 제외 ${missing}` : ""
    }`;
  }
  const detail = $("#seriesVerifyDetail");
  if (detail) {
    if (p.label) {
      detail.textContent = p.label;
    } else if (p.key) {
      const st =
        p.status === "found"
          ? "✓"
          : p.status === "missing"
            ? "✗"
            : p.status === "skip"
              ? "–"
              : "…";
      detail.textContent = `${st} ${p.key}`;
    } else {
      detail.textContent = "";
    }
  }
  // Keep sub line in sync
  const sub = $("#seriesBannerSub");
  if (sub && p.status !== "done") {
    sub.textContent = `확인 중 ${index}/${total} · 찾음 ${found}${
      p.key ? ` · ${p.key}` : ""
    }`;
  }
}

/**
 * Probe guessed product-code URLs; keep only pages that actually exist.
 * Stops after maxConsecutiveMiss failures in a row (series usually ends there).
 */
async function validateProductSeriesItems(candidates, opts = {}) {
  const want = Math.max(1, Number(opts.want) || 5);
  const maxMiss = Math.max(1, Number(opts.maxConsecutiveMiss) || 2);
  const onProgress =
    typeof opts.onProgress === "function" ? opts.onProgress : null;
  const out = [];
  let missStreak = 0;
  let missing = 0;
  const total = candidates.length;
  // Sequential probe — order matters and avoids hammering the site
  for (let i = 0; i < candidates.length && out.length < want; i++) {
    const c = candidates[i];
    const url = c?.url || "";
    const step = i + 1;
    onProgress?.({
      index: step,
      total,
      key: c.key,
      status: "checking",
      found: out.length,
      missing,
      label: c.key ? `${c.key} 확인 중…` : `후보 ${step} 확인 중…`
    });
    // Never treat pure search links as real episodes
    if (
      !url ||
      /\/search/i.test(url) ||
      /[?&](q|keyword|query|search)=/i.test(url) ||
      /google\.[^/]+\/search/i.test(url)
    ) {
      missing += 1;
      missStreak += 1;
      onProgress?.({
        index: step,
        total,
        key: c.key,
        status: "skip",
        found: out.length,
        missing,
        label: c.key
          ? `${c.key} · 검색 링크라 제외`
          : "검색 링크 · 제외"
      });
      if (missStreak >= maxMiss) {
        onProgress?.({
          index: step,
          total,
          key: c.key,
          status: "stop",
          found: out.length,
          missing,
          label: `연속 ${maxMiss}회 없음 · 더 이상 확인하지 않음`
        });
        break;
      }
      continue;
    }
    // Already in library as done → treat as real (even if site is down now)
    {
      const histHit = (historyItems || []).find(
        (h) =>
          h &&
          h.status === "done" &&
          (UVD.historyMatchesEntry?.(h, c) ||
            (c.key &&
              String(h.seriesKey || "")
                .toUpperCase() === String(c.key).toUpperCase()))
      );
      if (histHit || c.downloaded) {
        out.push({
          ...c,
          verified: true,
          url: histHit?.pageUrl || histHit?.url || c.url,
          title: histHit?.title || c.title || c.key,
          thumbnail:
            normalizeThumbSrc(histHit?.thumbnail) || c.thumbnail || "",
          destNote: "서재·확인됨",
          selected: c.selected !== false
        });
        missStreak = 0;
        onProgress?.({
          index: step,
          total,
          key: c.key,
          status: "found",
          found: out.length,
          missing,
          label: `${c.key || "항목"} · 서재에 있어 확인됨`
        });
        continue;
      }
    }
    try {
      const meta = await chrome.runtime
        .sendMessage({
          type: "PROBE_PAGE_META",
          url,
          pageUrl: url,
          expectedKey: c.key,
          key: c.key,
          tabId: currentTabId
        })
        .catch(() => null);
      const exists = !!(meta && meta.exists === true);
      if (!exists) {
        missing += 1;
        missStreak += 1;
        const why = meta?.blocked
          ? "차단됨 · 사이트에서 재생 후 재시도"
          : meta?.isSearch
            ? "검색으로 떨어짐 · 없는 품번"
            : meta?.notFound
              ? "없음/삭제"
              : meta?.error
                ? String(meta.error).slice(0, 40)
                : "페이지 없음";
        onProgress?.({
          index: step,
          total,
          key: c.key,
          status: "missing",
          found: out.length,
          missing,
          label: `${c.key || "항목"} · ${why}`
        });
        if (missStreak >= maxMiss) {
          const stopLabel = meta?.blocked
            ? "연속 차단 · 페이지에서 로그인/재생 후 다시 「시리즈」"
            : `연속 ${maxMiss}회 없음 · 시리즈 끝으로 보고 중단`;
          onProgress?.({
            index: step,
            total,
            key: c.key,
            status: "stop",
            found: out.length,
            missing,
            label: stopLabel
          });
          break;
        }
        continue;
      }
      missStreak = 0;
      const realTitle = String(meta.title || "").trim();
      const realThumb = normalizeThumbSrc(meta.thumbnail) || c.thumbnail || "";
      const finalUrl = meta.finalUrl || url;
      out.push({
        ...c,
        url: finalUrl,
        title:
          realTitle && realTitle.length > 2
            ? realTitle.length > 80
              ? realTitle.slice(0, 78) + "…"
              : realTitle
            : c.displayTitle || c.title || c.key,
        thumbnail: realThumb,
        softThumb: false,
        verified: true,
        destNote: "확인됨",
        selected: true
      });
      onProgress?.({
        index: step,
        total,
        key: c.key,
        status: "found",
        found: out.length,
        missing,
        label: `${c.key || "항목"} · 있음${
          realTitle ? ` · ${realTitle.slice(0, 40)}` : ""
        }`
      });
    } catch {
      missing += 1;
      missStreak += 1;
      onProgress?.({
        index: step,
        total,
        key: c.key,
        status: "missing",
        found: out.length,
        missing,
        label: `${c.key || "항목"} · 확인 실패`
      });
      if (missStreak >= maxMiss) {
        onProgress?.({
          index: step,
          total,
          key: c.key,
          status: "stop",
          found: out.length,
          missing,
          label: `연속 ${maxMiss}회 실패 · 중단`
        });
        break;
      }
    }
  }
  onProgress?.({
    index: total,
    total,
    status: "done",
    found: out.length,
    missing,
    label:
      out.length > 0
        ? `완료 · ${out.length}편 확인${missing ? ` · ${missing}개 제외` : ""}`
        : "완료 · 확인된 편 없음"
  });
  return out;
}

async function runSeriesComplete() {
  if (!seriesPending || seriesPending.loading) return;
  const selected = (seriesPending.items || []).filter(
    (x) => x.selected !== false
  );
  if (!selected.length) {
    toast("받을 항목을 체크해 주세요", "error");
    return;
  }
  const btn = $("#btnSeriesGo");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const isPl = seriesPending.mode === "playlist";
    // Pass only selected entries so user sees exactly what runs
    const seriesId =
      seriesPending.seriesId || resolveSeriesIdFromPayload(seriesPending);
    lastSeriesRun = {
      seriesId,
      title: seriesPending.playlistTitle || seriesPending.title || "",
      mode: seriesPending.mode
    };
    const res = await chrome.runtime.sendMessage({
      type: "SERIES_COMPLETE",
      title: seriesPending.title,
      pageUrl: seriesPending.pageUrl || seriesPending.listUrl,
      count: selected.length,
      preferQuality: selectedQuality || "best",
      tabId: currentTabId,
      seriesId,
      seriesTitle:
        seriesPending.playlistTitle || seriesPending.title || "",
      // Explicit selection — backend prefers these when provided
      entries: selected.map((x, i) => ({
        title: x.title,
        url: x.url,
        key: x.key || x.id,
        id: x.id || x.key,
        seriesIndex: x.seriesIndex || i + 1,
        thumbnail: x.thumbnail || ""
      })),
      mode: seriesPending.mode
    });
    if (!res?.ok) {
      toast(userError(res?.error) || "시리즈 완주 실패", "error");
      return;
    }
    if (res.seriesId) lastSeriesRun.seriesId = res.seriesId;
    if (res.mode === "playlist" || isPl) {
      const names = selected
        .slice(0, 3)
        .map((x) => x.title)
        .join(", ");
      const reDone = selected.filter((x) => x.downloaded).length;
      toast(
        `${res.queued || selected.length}편 받기 시작${
          reDone ? ` · 재받기 ${reDone}` : ""
        }${names ? ` · ${names}${selected.length > 3 ? " …" : ""}` : ""}`,
        "ok"
      );
      ensureQueuePoll();
      await refreshJobsFromBackground();
      // Keep banner for retry button; collapse list optional
      updateSeriesRetryButton();
    } else {
      const names = selected
        .slice(0, 4)
        .map((x) => x.key || x.title)
        .join(", ");
      toast(
        `나중 받기에 ${res.queued || selected.length}편 추가 · ${names}${
          selected.length > 4 ? " …" : ""
        }`,
        "ok"
      );
      await loadWatchlistUi();
      switchTab("watch");
      hideSeriesBanner();
    }
  } catch (e) {
    toast(userError(e?.message) || "시리즈 완주 실패", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      updateSeriesGoButton();
    }
  }
}

function updateRetryFailedButton() {
  const btn = $("#btnRetryFailed");
  if (!btn) return;
  const sid = lastSeriesRun?.seriesId || "";
  let seriesFailed = 0;
  if (sid) {
    seriesFailed = historyItems.filter(
      (h) =>
        h?.status === "error" &&
        (h.seriesId === sid ||
          (Array.isArray(h.tags) && h.tags.includes(sid)))
    ).length;
  }
  const n = historyItems.filter(
    (h) => h?.status === "error" && /^https?:/i.test(h.pageUrl || h.url || "")
  ).length;
  btn.disabled = n === 0;
  // Prefer series-scoped label when last run has failures
  if (seriesFailed > 0) {
    btn.textContent = `시리즈 실패 · ${seriesFailed}`;
    btn.title = `마지막 시리즈 실패 ${seriesFailed}편 다시 받기 (전체 실패 ${n})`;
    btn.dataset.seriesRetry = "1";
  } else {
    btn.textContent = n > 0 ? `실패 재시도 · ${n}` : "실패 재시도";
    btn.title =
      n > 0 ? `실패한 ${n}개 다시 받기` : "재시도할 실패 항목이 없습니다";
    delete btn.dataset.seriesRetry;
  }
  updateSeriesRetryButton().catch(() => {});
}

/* ── Recent files ─────────────────────────────── */
async function loadRecentStrip() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_RECENT_DONE", limit: 3 });
    recentItems = res?.items || [];
  } catch {
    recentItems = await UVD.getRecentDone(3).catch(() => []);
  }
  renderRecentStrip();
}

function renderRecentStrip() {
  const strip = $("#recentStrip");
  const list = $("#recentList");
  if (!strip || !list) return;
  if (!recentItems.length) {
    strip.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  strip.classList.remove("hidden");
  list.innerHTML = recentItems
    .map((h) => {
      const title = (h.title || h.filename || "영상").slice(0, 48);
      return `
        <div class="recent-item">
          <span class="recent-item-title" title="${escapeAttr(h.title || "")}">${escapeHtml(
            title
          )}</span>
          <button type="button" class="btn" data-act="show" data-path="${escapeAttr(
            h.path || ""
          )}" data-did="${escapeAttr(h.downloadId ?? "")}">폴더</button>
        </div>`;
    })
    .join("");
  bindRecoveryButtons(list);
}

/* ── Watchlist ────────────────────────────────── */
async function loadWatchlistUi() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_WATCHLIST" });
    watchlistItems = res?.watchlist || [];
  } catch {
    watchlistItems = await UVD.getWatchlist().catch(() => []);
  }
  renderWatchlist();
}

function formatScheduleLabel(w) {
  const at = Number(w?.scheduleAt || 0);
  if (!at || at < Date.now()) return w?.scheduleLabel || "";
  try {
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    if (sameDay) return `오늘 ${hh}:${mm}`;
    const tom = new Date(today);
    tom.setDate(tom.getDate() + 1);
    const isTom =
      d.getFullYear() === tom.getFullYear() &&
      d.getMonth() === tom.getMonth() &&
      d.getDate() === tom.getDate();
    if (isTom) return `내일 ${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  } catch {
    return w?.scheduleLabel || "예약됨";
  }
}

function scheduleOptionsHtml(w) {
  const at = Number(w?.scheduleAt || 0);
  const active = at > Date.now();
  return `
    <select class="watch-schedule" data-act="watch-sched" data-id="${escapeAttr(
      w.id
    )}" title="예약 받기">
      <option value="none" ${!active ? "selected" : ""}>예약 없음</option>
      <option value="1h" ${w.scheduleLabel === "1시간 후" ? "selected" : ""}>1시간 후</option>
      <option value="tonight" ${w.scheduleLabel === "오늘 밤 23시" ? "selected" : ""}>오늘 밤 23시</option>
      <option value="morning" ${w.scheduleLabel === "내일 아침 9시" ? "selected" : ""}>내일 아침 9시</option>
      <option value="clear" ${active ? "" : ""}>예약 취소</option>
    </select>`;
}

function computeSchedule(mode) {
  const now = Date.now();
  if (mode === "1h") {
    return { scheduleAt: now + 60 * 60 * 1000, scheduleLabel: "1시간 후" };
  }
  if (mode === "tonight") {
    const d = new Date();
    d.setHours(23, 0, 0, 0);
    if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1);
    return { scheduleAt: d.getTime(), scheduleLabel: "오늘 밤 23시" };
  }
  if (mode === "morning") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return { scheduleAt: d.getTime(), scheduleLabel: "내일 아침 9시" };
  }
  return { scheduleAt: 0, scheduleLabel: "" };
}

/** Group key for watchlist series rows */
function watchSeriesGroupKey(w) {
  if (!w) return "";
  if (w.seriesId) return String(w.seriesId);
  const tags = Array.isArray(w.tags) ? w.tags : [];
  const sid = tags.find((t) => String(t).startsWith("series:"));
  if (sid) return String(sid);
  if (w.seriesKey) {
    const info = UVD.extractSeriesInfo(w.seriesKey) || UVD.extractSeriesInfo(w.title);
    if (info?.prefix) return `series:code:${info.prefix}`;
  }
  const info = UVD.extractSeriesInfo(w.title || "");
  if (info?.prefix) return `series:code:${info.prefix}`;
  return "";
}

function watchSeriesGroupLabel(groupKey, items) {
  if (!groupKey) return "기타";
  if (groupKey.startsWith("series:code:")) {
    return `시리즈 ${groupKey.slice("series:code:".length)}`;
  }
  if (groupKey.startsWith("series:pl:")) {
    return items[0]?.title?.slice(0, 40) || "재생목록";
  }
  return items[0]?.title?.slice(0, 36) || "시리즈";
}

function renderWatchItemRow(w, idx) {
  const title = w.title || "나중에 받을 영상";
  const site = w.site || UVD.siteFromUrl(w.url || w.pageUrl) || "";
  const hasMedia = !!(w.mediaUrl && /^https?:/i.test(w.mediaUrl));
  const sched = formatScheduleLabel(w);
  const sk = w.seriesKey ? ` · ${w.seriesKey}` : "";
  return `
        <div class="history-item watch-item" draggable="true" data-watch-id="${escapeAttr(
          w.id
        )}" data-index="${idx}" data-series-group="${escapeAttr(
          watchSeriesGroupKey(w) || ""
        )}">
          <div class="history-top">
            <span class="watch-drag" title="드래그해서 순서 변경" aria-hidden="true">⋮⋮</span>
            <span class="history-status done">${idx + 1}</span>
            <div class="history-meta">
              <div class="history-title" title="${escapeAttr(title)}">${escapeHtml(
                title
              )}</div>
              <div class="history-sub">${escapeHtml(
                formatTimeAgo(w.at)
              )} · ${escapeHtml(site)}${escapeHtml(sk)}${hasMedia ? " · 스트림" : ""}${
                sched ? ` · ⏰ ${escapeHtml(sched)}` : ""
              }</div>
            </div>
          </div>
          <div class="history-actions watch-actions">
            ${scheduleOptionsHtml(w)}
            <button type="button" class="btn" data-act="watch-dl"
              data-url="${escapeAttr(w.url || w.pageUrl || "")}"
              data-page-url="${escapeAttr(w.pageUrl || w.url || "")}"
              data-media-url="${escapeAttr(w.mediaUrl || "")}"
              data-title="${escapeAttr(title)}"
              data-quality="${escapeAttr(w.quality || "")}"
              data-id="${escapeAttr(w.id)}">받기</button>
            <button type="button" class="btn" data-act="watch-rm" data-id="${escapeAttr(
              w.id
            )}">삭제</button>
          </div>
        </div>`;
}

function renderWatchlist() {
  const root = $("#watchList");
  if (!root) return;
  if (!watchlistItems.length) {
    root.innerHTML = `
      <div class="empty small">
        <p>비어 있습니다.</p>
        <p class="hint">링크 옆 「나중」또는 카드에서 추가 · 드래그로 순서 · 예약 가능</p>
      </div>`;
    return;
  }

  // Preserve overall order, group consecutive series items under headers
  const groups = [];
  const groupMap = new Map(); // key -> { key, items: [] } for non-flat render
  // Render: series groups first (by first appearance), then ungrouped in order
  const seen = new Set();
  const orderedKeys = [];
  for (const w of watchlistItems) {
    const g = watchSeriesGroupKey(w) || `__single:${w.id}`;
    if (!seen.has(g)) {
      seen.add(g);
      orderedKeys.push(g);
      groupMap.set(g, []);
    }
    groupMap.get(g).push(w);
  }

  let globalIdx = 0;
  const parts = [];
  for (const gKey of orderedKeys) {
    const items = groupMap.get(gKey) || [];
    const isSeries = !gKey.startsWith("__single:") && items.length >= 1 && watchSeriesGroupKey(items[0]);
    if (isSeries && items.length >= 1) {
      const label = watchSeriesGroupLabel(gKey, items);
      parts.push(`
        <div class="watch-series-group" data-series-group="${escapeAttr(gKey)}">
          <div class="watch-series-head">
            <div class="watch-series-head-text">
              <span class="watch-series-badge">시리즈</span>
              <span class="watch-series-name" title="${escapeAttr(label)}">${escapeHtml(
                label
              )}</span>
              <span class="watch-series-count">${items.length}편</span>
            </div>
            <div class="watch-series-actions">
              <button type="button" class="btn primary tiny" data-act="watch-series-dl" data-group="${escapeAttr(
                gKey
              )}">묶음 받기</button>
              <button type="button" class="btn ghost tiny" data-act="watch-series-rm" data-group="${escapeAttr(
                gKey
              )}">묶음 삭제</button>
            </div>
          </div>
          <div class="watch-series-body">
            ${items
              .map((w) => {
                globalIdx += 1;
                return renderWatchItemRow(w, globalIdx);
              })
              .join("")}
          </div>
        </div>`);
    } else {
      for (const w of items) {
        globalIdx += 1;
        parts.push(renderWatchItemRow(w, globalIdx));
      }
    }
  }
  root.innerHTML = parts.join("");

  // Actions
  root.querySelectorAll("[data-act]").forEach((el) => {
    const act = el.getAttribute("data-act");
    if (act === "watch-sched") {
      el.addEventListener("change", async () => {
        const id = el.getAttribute("data-id") || "";
        const mode = el.value;
        const patch =
          mode === "none" || mode === "clear"
            ? { scheduleAt: 0, scheduleLabel: "" }
            : computeSchedule(mode);
        await chrome.runtime
          .sendMessage({ type: "UPDATE_WATCHLIST_ITEM", id, patch })
          .catch(() => {});
        toast(
          patch.scheduleAt
            ? `예약: ${patch.scheduleLabel || formatScheduleLabel(patch)}`
            : "예약을 취소했습니다",
          "ok"
        );
        await loadWatchlistUi();
      });
      return;
    }
    el.addEventListener("click", async () => {
      const id = el.getAttribute("data-id") || "";
      const url = el.getAttribute("data-url") || "";
      const group = el.getAttribute("data-group") || "";
      if (act === "watch-series-dl" && group) {
        await downloadWatchSeriesGroup(group);
        return;
      }
      if (act === "watch-series-rm" && group) {
        await removeWatchSeriesGroup(group);
        return;
      }
      if (act === "watch-dl" && url) {
        await downloadByPastedLink(url, {
          skipDupCheck: false,
          mediaUrl: el.getAttribute("data-media-url") || "",
          pageUrl: el.getAttribute("data-page-url") || url,
          title: el.getAttribute("data-title") || "",
          quality: el.getAttribute("data-quality") || selectedQuality || "best"
        });
        await chrome.runtime
          .sendMessage({ type: "REMOVE_WATCHLIST", id })
          .catch(() => {});
        await loadWatchlistUi();
        return;
      }
      if (act === "watch-rm" && id) {
        await chrome.runtime
          .sendMessage({ type: "REMOVE_WATCHLIST", id })
          .catch(() => {});
        await loadWatchlistUi();
      }
    });
  });

  // Drag reorder
  let dragId = null;
  root.querySelectorAll(".watch-item").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragId = row.getAttribute("data-watch-id");
      row.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragId || "");
      } catch {
        /* ignore */
      }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      root.querySelectorAll(".watch-item").forEach((r) => r.classList.remove("drag-over"));
      dragId = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const fromId = dragId || e.dataTransfer?.getData("text/plain");
      const toId = row.getAttribute("data-watch-id");
      if (!fromId || !toId || fromId === toId) return;
      const ids = watchlistItems.map((w) => w.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, fromId);
      const res = await chrome.runtime
        .sendMessage({ type: "REORDER_WATCHLIST", ids })
        .catch(() => null);
      if (res?.watchlist) watchlistItems = res.watchlist;
      else {
        // local fallback order
        const map = new Map(watchlistItems.map((w) => [w.id, w]));
        watchlistItems = ids.map((id) => map.get(id)).filter(Boolean);
      }
      renderWatchlist();
    });
  });
}

async function downloadWatchSeriesGroup(groupKey) {
  const items = watchlistItems.filter((w) => watchSeriesGroupKey(w) === groupKey);
  if (!items.length) {
    toast("묶음에 항목이 없습니다", "error");
    return;
  }
  toast(`${items.length}편 묶음 받기 시작…`, "ok");
  switchTab("main");
  for (const w of items) {
    const url = w.url || w.pageUrl;
    if (!/^https?:/i.test(url)) continue;
    try {
      await downloadByPastedLink(url, {
        skipDupCheck: true,
        mediaUrl: w.mediaUrl || "",
        pageUrl: w.pageUrl || url,
        title: w.title || "",
        quality: w.quality || selectedQuality || "best"
      });
      await chrome.runtime
        .sendMessage({ type: "REMOVE_WATCHLIST", id: w.id })
        .catch(() => {});
    } catch {
      /* continue others */
    }
  }
  await loadWatchlistUi();
  ensureQueuePoll();
  toast("묶음 받기 요청을 넣었습니다", "ok");
}

async function removeWatchSeriesGroup(groupKey) {
  const items = watchlistItems.filter((w) => watchSeriesGroupKey(w) === groupKey);
  if (!items.length) return;
  for (const w of items) {
    await chrome.runtime
      .sendMessage({ type: "REMOVE_WATCHLIST", id: w.id })
      .catch(() => {});
  }
  toast(`시리즈 ${items.length}편을 나중 받기에서 삭제`, "ok");
  await loadWatchlistUi();
}

/** Any http(s) link we can try to download later (not chrome:// etc.) */
function isWatchlistableUrl(url) {
  if (!url || typeof url !== "string") return false;
  let href = url.trim();
  if (!href) return false;
  // bare social hosts without scheme
  if (
    !/^https?:\/\//i.test(href) &&
    /^(www\.)?(youtube|youtu\.be|tiktok|instagram|x\.com|twitter|facebook|fb\.watch|bilibili|b23\.tv)/i.test(
      href
    )
  ) {
    href = "https://" + href;
  }
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const u = new URL(href);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const h = (u.hostname || "").toLowerCase();
    if (!h || h === "localhost") return false;
    if (/^(chrome|chrome-extension|edge|about|devtools|brave)/i.test(u.protocol)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick best URL for watchlist: real video page > media stream > tab.
 */
function resolveWatchlistUrl(forcedUrl) {
  const fromInput = normalizePastedUrl(
    UVD.parseUrlsFromText($("#linkInput")?.value || "")[0] || ""
  );
  const item = allItems[0];
  const candidates = [
    forcedUrl,
    fromInput,
    item?.pageUrl,
    // Direct media / HLS only if page URL missing
    item?.url,
    currentTabUrl
  ]
    .map((u) => String(u || "").trim())
    .filter(Boolean);

  // Prefer known social/video pages over raw CDN/m3u8 when both exist
  for (const u of candidates) {
    if (
      isDownloadableSiteVideo(u) ||
      isYoutubeUrl(u) ||
      isTiktokUrl(u) ||
      isInstagramUrl(u) ||
      isXUrl(u) ||
      isFacebookUrl(u) ||
      isBilibiliUrl(u) ||
      UVD.isPlaylistUrl(u)
    ) {
      return u;
    }
  }
  for (const u of candidates) {
    if (isWatchlistableUrl(u)) return u;
  }
  return candidates[0] || "";
}

async function addCurrentToWatchlist(forcedUrl) {
  let url = resolveWatchlistUrl(forcedUrl);
  if (url && !/^https?:\/\//i.test(url)) {
    url = normalizePastedUrl(url) || url;
  }
  if (!url || !/^https?:/i.test(url)) {
    toast("추가할 링크가 없습니다 · 영상 페이지를 열거나 링크를 붙여 넣으세요", "error");
    return;
  }
  if (!isWatchlistableUrl(url)) {
    toast("http(s) 링크만 추가할 수 있습니다", "error");
    return;
  }

  // Instagram: only real posts (home/profile can't be downloaded later either)
  if (isInstagramHost(url) && !isInstagramPostUrl(url)) {
    toast("Instagram은 게시물·릴스 링크만 추가할 수 있습니다", "error");
    return;
  }

  const item = allItems[0];
  const sameCard =
    item &&
    (pageKey(item.pageUrl || item.url || "") === pageKey(url) ||
      pageKey(item.url || "") === pageKey(url));
  const title =
    (sameCard && (item.title || item.pageTitle || item.displayName)) ||
    (item && isSitePage(currentTabUrl) && (item.title || item.pageTitle)) ||
    fnameBaseFromLink(url) ||
    cleanTitleText(document?.title) ||
    "나중에 받을 영상";
  // Capture stream URL when available (123av / HLS sites need this for later download)
  let mediaUrl = "";
  if (sameCard && item?.url && item.url !== url) {
    if (isHlsItem(item) || looksLikeDirectMedia(item.url) || /\.m3u8|\/playlist/i.test(item.url)) {
      mediaUrl = item.url;
    }
  } else if (item?.url && (isHlsItem(item) || looksLikeDirectMedia(item.url))) {
    // Card media on current page even if URL key slightly differs
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, "");
      const curHost = currentTabUrl
        ? new URL(currentTabUrl).hostname.replace(/^www\./, "")
        : "";
      if (pageHost && (pageHost === curHost || !curHost)) {
        mediaUrl = item.url;
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "ADD_WATCHLIST",
      item: {
        url,
        pageUrl: item?.pageUrl || url,
        mediaUrl: mediaUrl || "",
        title: cleanTitleText(title) || title || "나중에 받을 영상",
        thumbnail: (sameCard && item?.thumbnail) || item?.thumbnail || "",
        quality: selectedQuality || "",
        site: UVD.siteFromUrl(url) || item?.site || ""
      }
    });
    watchlistItems = res?.watchlist || [];
    toast(
      mediaUrl
        ? "나중 받기에 추가했습니다 (스트림 포함)"
        : "나중 받기에 추가했습니다",
      "ok"
    );
    if (activeTabName === "watch") renderWatchlist();
  } catch (e) {
    toast(userError(e?.message) || "추가 실패", "error");
  }
}

async function downloadAllWatchlist() {
  if (!watchlistItems.length) {
    toast("나중 받기 목록이 비어 있습니다", "ok");
    return;
  }
  const urls = watchlistItems.map((w) => w.url || w.pageUrl).filter((u) => /^https?:/i.test(u));
  if (!urls.length) return;
  switchTab("main");
  toast(`${urls.length}개 나중 받기 시작…`, "ok");
  try {
    await refreshHelperStatus(true);
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_BATCH",
      urls: urls.slice(0, MAX_CONCURRENT_STARTS),
      tabId: currentTabId,
      preferQuality: selectedQuality || "best"
    });
    if (res?.ok) {
      // Remove started items from watchlist
      for (const u of urls.slice(0, res.count || urls.length)) {
        await chrome.runtime
          .sendMessage({ type: "REMOVE_WATCHLIST", id: u })
          .catch(() => {});
      }
      toast(`${res.count || urls.length}개 다운로드 시작`, "ok");
      ensureQueuePoll();
      await refreshJobsFromBackground();
      await loadWatchlistUi();
    } else {
      toast(userError(res?.error) || "시작 실패", "error");
    }
  } catch (e) {
    toast(userError(e?.message) || "시작 실패", "error");
  }
}

/**
 * If this URL was already downloaded successfully, ask before re-downloading.
 * @returns {Promise<boolean>} true = proceed, false = cancel
 */
async function confirmNotDuplicate(url, { force = false } = {}) {
  if (force || uvdSettings.warnDuplicates === false) return true;
  if (!url || !/^https?:/i.test(url)) return true;

  // Also skip if already running in queue
  const key = UVD.normalizeUrlKey(url);
  for (const j of uiJobs.values()) {
    if (
      j.status === "running" &&
      UVD.normalizeUrlKey(j.pageUrl || "") === key
    ) {
      toast("이미 받는 중입니다", "ok");
      return false;
    }
  }

  let dup = null;
  try {
    dup = await UVD.findDuplicateDone(url);
  } catch {
    dup = null;
  }
  if (!dup) return true;

  return new Promise((resolve) => {
    const modal = $("#dupModal");
    const text = $("#dupModalText");
    const meta = $("#dupModalMeta");
    if (!modal) {
      resolve(true);
      return;
    }
    const when = formatTimeAgo(dup.at);
    const size =
      dup.size >= 1024 * 1024
        ? `${(dup.size / 1024 / 1024).toFixed(1)}MB`
        : "";
    if (text) {
      text.textContent = `「${(dup.title || "영상").slice(0, 40)}」은(는) 이전에 저장했습니다.`;
    }
    if (meta) {
      meta.textContent = [when, size, dup.filename || ""].filter(Boolean).join(" · ");
    }
    modal.classList.remove("hidden");
    modal.dataset.path = dup.path || "";
    modal.dataset.did = dup.downloadId != null ? String(dup.downloadId) : "";

    const cleanup = (result) => {
      modal.classList.add("hidden");
      $("#btnDupForce")?.removeEventListener("click", onForce);
      $("#btnDupCancel")?.removeEventListener("click", onCancel);
      $("#btnDupFolder")?.removeEventListener("click", onFolder);
      resolve(result);
    };
    const onForce = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onFolder = async () => {
      try {
        await chrome.runtime.sendMessage({
          type: "SHOW_DOWNLOAD",
          downloadId: dup.downloadId,
          path: dup.path || ""
        });
      } catch {
        /* ignore */
      }
      cleanup(false);
    };
    $("#btnDupForce")?.addEventListener("click", onForce);
    $("#btnDupCancel")?.addEventListener("click", onCancel);
    $("#btnDupFolder")?.addEventListener("click", onFolder);
  });
}

/** Retry all failed history items (unique URLs) */
async function retryFailedDownloads() {
  const btn = $("#btnRetryFailed");
  // If last series has failures, prefer scoped retry
  if (btn?.dataset?.seriesRetry === "1" && lastSeriesRun?.seriesId) {
    await retrySeriesFailed();
    return;
  }
  let failed = [];
  try {
    failed = await UVD.getFailedRetryable();
  } catch {
    failed = historyItems.filter(
      (h) => h?.status === "error" && /^https?:/i.test(h.pageUrl || h.url || "")
    );
  }
  if (!failed.length) {
    toast("재시도할 실패 항목이 없습니다", "ok");
    return;
  }
  const urls = failed
    .map((h) => h.pageUrl || h.url)
    .filter((u) => /^https?:/i.test(u));
  if (!urls.length) {
    toast("재시도할 링크가 없습니다", "error");
    return;
  }
  switchTab("main");
  toast(`${urls.length}개 실패 항목 재시도 중…`, "ok");
  try {
    await refreshHelperStatus(true);
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_BATCH",
      urls: urls.slice(0, MAX_CONCURRENT_STARTS),
      tabId: currentTabId,
      preferQuality: selectedQuality || "best"
    });
    if (res?.ok) {
      toast(
        res.truncated
          ? `${res.count}개 재시작 (전체 ${res.total}개 중)`
          : `${res.count}개 재시도 시작`,
        "ok"
      );
      ensureQueuePoll();
      await refreshJobsFromBackground();
    } else {
      // Fallback: one by one without duplicate check (user asked to retry)
      for (const u of urls.slice(0, MAX_CONCURRENT_STARTS)) {
        await downloadByPastedLink(u, { skipDupCheck: true });
      }
    }
  } catch (e) {
    toast(userError(e?.message) || "재시도 실패", "error");
  }
}

function formatTimeAgo(ts) {
  const d = Date.now() - (ts || 0);
  if (d < 60_000) return "방금";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}시간 전`;
  return `${Math.floor(d / 86400_000)}일 전`;
}

function formatDurShort(sec) {
  if (!sec || sec < 1) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hidePlaylistBox() {
  playlistInfo = null;
  $("#playlistBox")?.classList.add("hidden");
}

function renderPlaylistPanel() {
  const box = $("#playlistBox");
  if (!box) return;
  if (!playlistInfo?.entries?.length && !playlistLoading) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const titleEl = $("#plTitle");
  const countEl = $("#plCount");
  if (playlistLoading && !playlistInfo) {
    if (titleEl) titleEl.textContent = "재생목록 불러오는 중…";
    if (countEl) countEl.textContent = "";
    return;
  }
  const info = playlistInfo;
  if (titleEl) titleEl.textContent = info.title || "재생목록";
  if (countEl) {
    const n = info.entries?.length || 0;
    const total = info.playlistCount || n;
    countEl.textContent =
      total > n ? `${n}개 · 전체 약 ${total}개` : `${n}개 영상`;
  }
  updatePlaylistProgressUi();
}

function updatePlaylistProgressUi() {
  const bar = $("#plProgress");
  const fill = $("#plProgressFill");
  const text = $("#plProgressText");
  if (!bar) return;
  if (!playlistDl.active) {
    // Derive from uiJobs matching playlist job ids
    if (playlistDl.jobIds.size) {
      let done = 0;
      let running = 0;
      for (const id of playlistDl.jobIds) {
        const j = uiJobs.get(id);
        if (!j) continue;
        if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
          done += 1;
        } else if (j.status === "running" || j.status === "paused") {
          running += 1;
        }
      }
      const total = playlistDl.total || playlistDl.jobIds.size;
      if (done + running > 0 && done < total) {
        bar.classList.remove("hidden");
        const pct = Math.round((done / total) * 100);
        if (fill) fill.style.width = `${pct}%`;
        if (text) {
          text.textContent = `목록 진행 ${done}/${total}${
            running ? ` · 받는 중 ${running}` : ""
          }`;
        }
        return;
      }
      if (done >= total && total > 0) {
        bar.classList.remove("hidden");
        if (fill) fill.style.width = "100%";
        if (text) text.textContent = `목록 완료 ${done}/${total}`;
        playlistDl.active = false;
        return;
      }
    }
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const total = playlistDl.total || 1;
  const done = playlistDl.done || 0;
  if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
  if (text) text.textContent = `시작 중… ${done}/${total}`;
}

async function loadPlaylistInfo(url, force = false) {
  const target = url || currentTabUrl || "";
  if (!target || !UVD.isPlaylistOnlyUrl(target)) {
    // watch with list= — offer expand? show subtle if list present
    if (target && UVD.isWatchInPlaylistUrl?.(target)) {
      // still load playlist from list= param for optional "전체 받기"
      try {
        const u = new URL(target);
        const listId = u.searchParams.get("list");
        if (listId) {
          const plUrl = `https://www.youtube.com/playlist?list=${listId}`;
          return loadPlaylistInfo(plUrl, force);
        }
      } catch {
        /* ignore */
      }
    }
    hidePlaylistBox();
    return null;
  }
  if (
    !force &&
    playlistInfo?.url === target &&
    playlistInfo.entries?.length
  ) {
    renderPlaylistPanel();
    return playlistInfo;
  }
  playlistLoading = true;
  renderPlaylistPanel();
  try {
    await refreshHelperStatus(true);
    if (!helperOk) {
      playlistInfo = {
        url: target,
        title: "재생목록 (도우미 필요)",
        entries: [],
        playlistCount: 0
      };
      playlistLoading = false;
      renderPlaylistPanel();
      toast("재생목록은 로컬 도우미가 필요합니다", "error");
      return null;
    }
    const res = await chrome.runtime.sendMessage({
      type: "LIST_PLAYLIST",
      pageUrl: target,
      max: 200
    });
    if (!res?.ok) {
      throw new Error(res?.error || "재생목록을 불러오지 못했습니다");
    }
    playlistInfo = {
      url: target,
      title: res.title || "재생목록",
      entries: res.entries || [],
      playlistCount: res.playlistCount || res.count || 0
    };
    playlistLoading = false;
    renderPlaylistPanel();
    // Integrate: open series selection banner with full list
    if (playlistInfo.entries?.length) {
      openSeriesFromPlaylist(playlistInfo, { quiet: true }).catch(() => {});
    }
    return playlistInfo;
  } catch (e) {
    playlistLoading = false;
    hidePlaylistBox();
    toast(userError(e?.message) || "재생목록 조회 실패", "error");
    return null;
  }
}

function playlistMaxCount() {
  // Prefer series range chip when banner is open
  if (seriesPending?.mode === "playlist") {
    return seriesRangeLimit(seriesPending.rangePref || seriesRangePref);
  }
  return seriesRangeLimit(seriesRangePref);
}

/** Open series banner for checkbox selection (integrated flow). */
async function selectPlaylistForDownload() {
  if (!playlistInfo?.entries?.length) {
    toast("재생목록이 비어 있습니다", "error");
    return;
  }
  await openSeriesFromPlaylist(playlistInfo);
}

async function downloadPlaylistAll() {
  if (!playlistInfo?.entries?.length) {
    toast("재생목록이 비어 있습니다", "error");
    return;
  }
  // Prefer series banner selection path when available
  if (
    seriesPending?.mode === "playlist" &&
    seriesPending.items?.some((x) => x.selected !== false)
  ) {
    await runSeriesComplete();
    return;
  }
  await refreshHelperStatus(true);
  if (!helperOk) {
    toast("재생목록 받기에는 도우미가 필요합니다", "error");
    return;
  }
  const max = playlistMaxCount();
  const entries = playlistInfo.entries.slice(0, max);
  const btn = $("#btnPlDownload");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "시작…";
  }
  playlistDl = {
    active: true,
    total: entries.length,
    done: 0,
    jobIds: new Set()
  };
  updatePlaylistProgressUi();
  let plSeriesId = "";
  try {
    const list = new URL(playlistInfo.url).searchParams.get("list");
    plSeriesId = list
      ? `series:pl:${list}`
      : `series:pl:${UVD.normalizeUrlKey(playlistInfo.url)}`;
  } catch {
    plSeriesId = `series:pl:${Date.now()}`;
  }
  lastSeriesRun = {
    seriesId: plSeriesId,
    title: playlistInfo.title || "",
    mode: "playlist"
  };
  try {
    const res = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_PLAYLIST",
      pageUrl: playlistInfo.url,
      title: playlistInfo.title,
      entries,
      max: entries.length,
      tabId: currentTabId,
      preferQuality: selectedQuality || "best",
      seriesId: plSeriesId
    });
    if (!res?.ok) {
      throw new Error(res?.error || "재생목록 받기 실패");
    }
    for (const id of res.jobIds || []) {
      playlistDl.jobIds.add(id);
      trackedJobIds.add(id);
    }
    playlistDl.active = true;
    playlistDl.total = res.count || entries.length;
    toast(
      `재생목록 ${res.count || entries.length}개 받기 시작 · 화질 ${
        selectedQuality === "best" ? "최고" : selectedQuality
      }`,
      "ok"
    );
    ensureQueuePoll();
    await refreshJobsFromBackground();
    updatePlaylistProgressUi();
  } catch (e) {
    playlistDl.active = false;
    toast(userError(e?.message) || "재생목록 받기 실패", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "목록 받기";
    }
  }
}

function renderHistory() {
  const root = $("#historyList");
  if (!root) return;
  if (!historyItems.length) {
    root.innerHTML = `<div class="empty small"><p>검색 결과가 없습니다.</p><p class="hint">필터를 바꾸거나 영상을 받아 보세요</p></div>`;
    return;
  }
  root.innerHTML = historyItems
    .map((h) => {
      const ok = h.status === "done";
      const errMeta = !ok ? UVD.classifyError(h.error || "") : null;
      const sub = ok
        ? `${formatTimeAgo(h.at)} · ${h.site || "?"} · ${
            h.mediaMode === "audio" ? "오디오" : h.mediaMode === "video_subs" ? "영상+자막" : "영상"
          }${h.size ? ` · ${(h.size / 1024 / 1024).toFixed(1)}MB` : ""}${
            h.seriesKey ? ` · ${h.seriesKey}` : ""
          }`
        : `${formatTimeAgo(h.at)} · ${errMeta?.label || "실패"}`;
      const errHint =
        !ok && errMeta?.hint
          ? `<div class="history-err-hint">${escapeHtml(errMeta.hint)}</div>`
          : "";
      const tags = (h.tags || []).slice(0, 6);
      const tagsHtml = tags.length
        ? `<div class="lib-tags">${tags
            .map((t) => `<span class="lib-tag">${escapeHtml(t)}</span>`)
            .join("")}</div>`
        : "";
      const acts = [];
      if (ok && (h.pageUrl || h.url)) {
        acts.push(
          `<button type="button" class="btn" data-act="retry" data-url="${escapeAttr(
            h.pageUrl || h.url
          )}">다시 받기</button>`
        );
      }
      if (ok) {
        acts.push(
          `<button type="button" class="btn" data-act="show" data-path="${escapeAttr(
            h.path || ""
          )}" data-did="${escapeAttr(h.downloadId ?? "")}">폴더</button>`
        );
        if (
          h.seriesKey ||
          UVD.isPlaylistOnlyUrl(h.pageUrl || h.url) ||
          UVD.isWatchInPlaylistUrl?.(h.pageUrl || h.url)
        ) {
          acts.push(
            `<button type="button" class="btn" data-act="series" data-title="${escapeAttr(
              h.title || ""
            )}" data-url="${escapeAttr(h.pageUrl || h.url || "")}">시리즈</button>`
          );
        }
      } else if (errMeta) {
        if (errMeta.actions.includes("retry") && (h.pageUrl || h.url)) {
          acts.push(
            `<button type="button" class="btn" data-act="retry" data-url="${escapeAttr(
              h.pageUrl || h.url
            )}">다시 받기</button>`
          );
        }
        if (errMeta.actions.includes("play_retry") && (h.pageUrl || h.url)) {
          acts.push(
            `<button type="button" class="btn" data-act="play_retry" data-url="${escapeAttr(
              h.pageUrl || h.url
            )}">재생 후 재시도</button>`
          );
        }
        if (errMeta.actions.includes("open_page") && (h.pageUrl || h.url)) {
          acts.push(
            `<button type="button" class="btn" data-act="open" data-url="${escapeAttr(
              h.pageUrl || h.url
            )}">페이지</button>`
          );
        }
        if (errMeta.actions.includes("helper_start")) {
          acts.push(
            `<button type="button" class="btn" data-act="helper_start">도우미 실행</button>`
          );
        }
        if (errMeta.actions.includes("helper")) {
          acts.push(
            `<button type="button" class="btn" data-act="helper">안내</button>`
          );
        }
        if (errMeta.actions.includes("login") && (h.pageUrl || h.url)) {
          acts.push(
            `<button type="button" class="btn" data-act="login" data-url="${escapeAttr(
              h.pageUrl || h.url
            )}">로그인</button>`
          );
        }
      }
      return `
        <div class="history-item ${ok ? "" : "is-error"}">
          <div class="history-top">
            <span class="history-status ${ok ? "done" : "error"}">${
              ok ? "✓" : "!"
            }</span>
            <div class="history-meta">
              <div class="history-title" title="${escapeAttr(
                h.title || ""
              )}">${escapeHtml(h.title || "영상")}</div>
              <div class="history-sub">${escapeHtml(sub)}${errHint}</div>
              ${tagsHtml}
            </div>
          </div>
          <div class="history-actions">${acts.join("")}</div>
        </div>`;
    })
    .join("");
  bindRecoveryButtons(root);
  root.querySelectorAll('[data-act="series"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const title = btn.getAttribute("data-title") || "";
      const url = btn.getAttribute("data-url") || "";
      switchTab("main");
      await offerSeriesComplete(title, url);
      if (!seriesPending?.items?.length && !seriesPending?.loading) {
        toast(
          "시리즈 목록을 만들지 못했습니다. 제목에 품번이 있거나 재생목록이어야 합니다",
          "error"
        );
      }
    });
  });
}

function updateLinkCount() {
  const text = $("#linkInput")?.value || "";
  const urls = UVD.parseUrlsFromText(text);
  const el = $("#linkCount");
  if (el) {
    el.textContent =
      urls.length > 1
        ? `${urls.length}개 링크 (일괄)`
        : urls.length === 1
          ? "1개 링크"
          : "0개 링크";
  }
  return urls;
}

/** Legacy single bar — only if queue DOM missing */
function showProgress(show, percent = 0, text = "") {
  if (dlQueueEl && uiJobs.size > 0) {
    // Multi-queue owns the UI
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
  if (progressText) {
    progressText.textContent = text || `받는 중… ${percent}%`;
  }
}

function applyJobProgress(jobOrProgress, opts = {}) {
  if (!jobOrProgress) return;
  const p = jobOrProgress;
  const jobId = p.id || p.jobId;
  if (!jobId) {
    // Unscoped progress with multiple jobs → ignore (was causing % thrash)
    const running = [...uiJobs.values()].filter((j) => j.status === "running");
    if (running.length > 1) return;
    if (running.length === 1) {
      const prev = running[0];
      // Don't revive paused/cancelled rows from ambient progress
      if (prev.status === "paused" || prev.status === "cancelled") return;
      const raw = typeof p.percent === "number" ? p.percent : prev.percent || 0;
      // Never lower a running job's bar from unscoped page events
      const percent =
        prev.status === "running"
          ? Math.max(prev.percent || 0, raw)
          : raw;
      upsertUiJob(
        {
          ...prev,
          percent,
          message: p.message || prev.message,
          phase: p.phase || prev.phase,
          status:
            p.phase === "done"
              ? "done"
              : p.phase === "error"
                ? "error"
                : "running"
        },
        opts
      );
    } else {
      showProgress(true, p.percent || 10, p.message || "받는 중…");
    }
    return;
  }
  const prev = uiJobs.get(jobId);
  // Paused/cancelled rows stay put — ignore late progress (main flicker source)
  if (
    prev &&
    (prev.status === "paused" ||
      prev.status === "cancelled" ||
      prev.status === "done" ||
      prev.status === "error") &&
    !p.status &&
    p.phase !== "done" &&
    p.phase !== "error"
  ) {
    return;
  }
  const raw = typeof p.percent === "number" ? p.percent : prev?.percent || 0;
  const percent =
    prev?.status === "running" && typeof prev.percent === "number"
      ? Math.max(prev.percent, raw)
      : raw;
  const nextStatus =
    p.status ||
    (p.phase === "done"
      ? "done"
      : p.phase === "error"
        ? "error"
        : p.phase === "paused"
          ? "paused"
          : prev?.status === "paused" || prev?.status === "cancelled"
            ? prev.status
            : "running");
  upsertUiJob(
    {
      id: jobId,
      title: p.title,
      percent,
      message: p.message || p.error,
      phase: p.phase,
      status: nextStatus,
      error: p.error,
      result: p.result,
      path: p.path,
      filename: p.filename,
      quality: p.quality,
      pageUrl: p.pageUrl,
      startedAt: p.startedAt,
      updatedAt: p.updatedAt || Date.now(),
      _silentDone: p._silentDone
    },
    opts
  );
}

/**
 * Re-attach UI to downloads still running in the service worker
 * (after popup close or page navigation).
 */
async function restoreActiveDownloads() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
    const jobs = res?.jobs || [];
    for (const j of jobs) {
      if (j?.id) {
        trackedJobIds.add(j.id);
        upsertUiJob(j, { toast: false });
      }
    }
    const running = jobs.filter((j) => j.status === "running");
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

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function userError(err) {
  if (!err) return null;
  const s = String(err);

  // Prefer shared classifier (helper / 403 / DRM / incomplete / …)
  try {
    if (typeof UVD?.classifyError === "function") {
      const meta = UVD.classifyError(s);
      if (meta && meta.code && meta.code !== "other") {
        const label = meta.label || "";
        const hint = meta.hint || "";
        if (label && hint) return `${label} — ${hint}`;
        if (label) return label;
        if (hint) return hint;
      }
    }
  } catch {
    /* fall through */
  }

  if (/파일 저장 실패|다운로드 시작 실패|Invalid filename|invalid filename|filename/i.test(s)) {
    return "파일 저장에 실패했습니다. 확장 프로그램을 새로고침한 뒤 다시 받아 주세요 (파일명·권한 문제일 수 있음)";
  }
  if (/다운로드가 완료되지 않았습니다|chrome:\/\/downloads/i.test(s)) {
    return "다운로드가 중간에 끊겼습니다. chrome://downloads 에서 확인하거나 다시 받아 주세요";
  }
  if (/파일이 너무 작|세그먼트 부족|병합 결과|빈 파일/i.test(s)) {
    return "영상 데이터가 불완전합니다. 페이지에서 재생을 누른 뒤 다시 받아 주세요";
  }
  if (/403|접근 거부|Segment HTTP/i.test(s)) {
    return "접근이 거부되었습니다 (403). 페이지를 열어 재생한 직후 다시 시도하세요";
  }
  if (/도우미|8787|yt-dlp not|연결할 수 없/i.test(s)) {
    return "로컬 도우미가 필요합니다. helper/start.command 를 실행한 뒤 다시 시도하세요";
  }

  // Hide all technical URL / English API noise
  if (
    /No URL|URL 없음|url required|invalid url|Invalid URL|not a valid URL|미디어 URL|url is/i.test(
      s
    )
  ) {
    return "받을 주소가 없습니다. 페이지를 새로고침한 뒤 재생해 주세요";
  }
  // Prefer clear Korean TikTok/YouTube messages as-is
  if (/TikTok|틱톡|재생 주소|페이지에서 재생/i.test(s)) {
    let clean = s.replace(/^Error:\s*/i, "").trim();
    if (clean.length > 120) clean = clean.slice(0, 117) + "…";
    return clean;
  }
  if (/Failed to fetch|NetworkError|네트워크 접근|CORS|Load failed/i.test(s)) {
    return "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 눌러 주세요";
  }
  if (/재생목록 URL|m3u8|playlist only/i.test(s) && /직접 저장|병합/i.test(s)) {
    return "스트리밍 영상을 합치는 중 문제가 생겼습니다. 다시 시도해 주세요";
  }
  if (/Blob URL|blob/i.test(s) && /Capture|캡처|받을 수/i.test(s)) {
    return "이 영상 형식을 바로 받을 수 없습니다. 재생 후 다시 시도해 주세요";
  }
  if (/도우미|install_autostart|start\.command|yt-dlp not|ytdlp|8787/i.test(s)) {
    return "로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요";
  }
  if (/Instagram|인스타/i.test(s)) {
    let clean = s.replace(/^Error:\s*/i, "").trim();
    if (clean.length > 120) clean = clean.slice(0, 117) + "…";
    return clean;
  }
  if (/DRM|SAMPLE-AES|Widevine/i.test(s)) return "보호된 영상이라 받을 수 없습니다";
  if (/Segment HTTP 403|세그먼트.*403|조각 접근|CDN이 접근/i.test(s)) {
    return "영상 조각 접근이 막혔습니다(403). 페이지에서 재생을 누른 직후 바로 다시 받아 주세요";
  }
  if (/HTTP 403|HTTP 401|접근 거부/i.test(s)) {
    return "접근이 거부되었습니다. 로그인·재생 후 다시 시도해 주세요";
  }
  if (/HTTP \d{3}/i.test(s)) {
    return "서버에서 영상을 주지 않았습니다. 재생 후 다시 시도해 주세요";
  }
  if (/너무 작|세그먼트 부족|병합 실패|유효한 세그먼트|조각 \d+\/\d+/i.test(s)) {
    return "영상 조각을 충분히 받지 못했습니다. 재생 직후 다시 시도해 주세요";
  }
  if (/시간 초과|timeout/i.test(s)) return "시간이 초과되었습니다. 다시 시도해 주세요";
  if (/Could not establish connection|Receiving end|Extension context/i.test(s)) {
    return "페이지를 새로고침한 뒤 다시 시도해 주세요";
  }
  if (/offscreen|OFFSCREEN|빈 청크|IndexedDB에 영상/i.test(s)) {
    return "저장 중 문제가 생겼습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요";
  }
  if (/파일 저장 실패/i.test(s)) {
    return s.length < 120
      ? s
      : "파일 저장에 실패했습니다. chrome://downloads 를 확인해 주세요";
  }
  if (/다운로드가 중단|USER_CANCELED|NETWORK_FAILED/i.test(s)) {
    return "다운로드가 중단되었습니다. 다시 시도해 주세요";
  }

  // Strip technical prefixes; keep Korean; soften pure English dumps
  let clean = s.replace(/^Error:\s*/i, "").trim();
  if (/[가-힣]/.test(clean)) {
    if (clean.length > 120) return clean.slice(0, 117) + "…";
    return clean;
  }
  if (/^https?:\/\//i.test(clean) || (/url/i.test(clean) && clean.length < 40)) {
    return "받을 수 없는 주소입니다. 페이지를 새로고침한 뒤 재생해 주세요";
  }
  if (/^[A-Za-z0-9\s:./_-]+$/.test(clean) && /url|fetch|http|blob|null|undefined/i.test(clean)) {
    return "다운로드에 실패했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요";
  }
  if (clean.length > 90) return clean.slice(0, 87) + "…";
  return clean || "다운로드에 실패했습니다";
}

/** Same-page check for thumbnails (watch?v= changes are different pages) */
function pageKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname || "/";
    if (host === "youtu.be") return `yt:${path.replace(/^\//, "").split("/")[0]}`;
    if (host.includes("youtube")) {
      const v = u.searchParams.get("v");
      if (v) return `yt:${v}`;
      const m = path.match(/\/(shorts|embed|live|clip)\/([^/?#]+)/i);
      if (m) return `yt:${m[1]}:${m[2]}`;
      return `yt:${path}`;
    }
    if (host.includes("tiktok")) {
      const m = path.match(/\/@[^/]+\/video\/(\d+)/i);
      if (m) return `tt:${m[1]}`;
      return `tt:${path}`;
    }
    if (host.includes("instagram") || host.includes("instagr.am")) {
      const m = path.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      if (m) return `ig:${m[1]}:${m[2]}`;
      return `ig:${path}`;
    }
    return `${host}${path}`;
  } catch {
    return String(url).slice(0, 120);
  }
}

/** Keep YT/TT card alive even when background sends empty MEDIA_UPDATED */
function ensureSiteItems(items, tabLike) {
  const list = Array.isArray(items) ? items.slice() : [];
  const url = currentTabUrl || tabLike?.url || "";
  if (!isSitePage(url)) return list;

  // On pure home/search — still offer download if URL might be a video; else empty guidance via render
  const local = buildLocalSiteItem(tabLike || { url, title: "" });
  if (!local) return list;

  if (!list.length) return [local];

  // Replace CDN fragments with page-level download item
  const top = list[0];
  const curKey = pageKey(url);
  const topKey = pageKey(top.pageUrl || top.url || "");
  const samePage = !topKey || !curKey || topKey === curKey;

  // Never carry previous page's thumbnail onto a new video page
  const thumb = samePage ? top.thumbnail || local.thumbnail : local.thumbnail;
  const title = samePage
    ? top.title || local.title
    : local.title || top.title;
  const pageTitle = samePage
    ? top.pageTitle || local.pageTitle
    : local.pageTitle || top.pageTitle;

  return [
    {
      ...local,
      ...(samePage ? top : {}),
      url: local.url,
      pageUrl: local.pageUrl,
      isSiteDownload: true,
      site: local.site,
      title,
      pageTitle,
      displayName: samePage ? top.displayName || local.displayName : local.displayName,
      filename: samePage ? top.filename || local.filename : local.filename,
      thumbnail: thumb || undefined
    }
  ];
}

function render() {
  // Always re-apply YT/TT card before paint
  allItems = ensureSiteItems(allItems, { url: currentTabUrl, title: allItems[0]?.title || "" });
  const items = allItems.slice(0, 1);
  listEl.innerHTML = "";

  if (!items.length) {
    // No card — show global quality chips for link paste
    syncGlobalQualityBox(false);
    let title = "받을 영상이 없습니다.";
    let hint = "페이지를 열거나 위에 게시물 링크를 붙여 넣으세요.";
    if (isInstagramHost(currentTabUrl) && !isInstagramPostUrl(currentTabUrl)) {
      title = "게시물·릴스 페이지를 열어 주세요.";
      hint =
        "instagram.com 홈/프로필이 아니라, 받을 게시물(/p/) 또는 릴스(/reel/)를 연 뒤 다시 열어 주세요.";
    } else if (isYoutubeUrl(currentTabUrl) && !isDownloadableSiteVideo(currentTabUrl)) {
      title = "영상 페이지를 열어 주세요.";
      hint = "YouTube watch/shorts 페이지에서 다시 열어 주세요.";
    } else if (isTiktokUrl(currentTabUrl) && !isDownloadableSiteVideo(currentTabUrl)) {
      title = "영상 페이지를 열어 주세요.";
      hint = "TikTok @유저/video/숫자 페이지에서 다시 열어 주세요.";
    } else if (
      /(?:^|\.)x\.com|(?:^|\.)twitter\.com/i.test(
        (() => {
          try {
            return new URL(currentTabUrl).hostname;
          } catch {
            return "";
          }
        })()
      ) &&
      !isXUrl(currentTabUrl)
    ) {
      title = "트윗 영상 페이지를 열어 주세요.";
      hint = "x.com/…/status/숫자 주소에서 다시 열어 주세요.";
    } else if (
      /facebook\.com|fb\.watch|fb\.com/i.test(currentTabUrl || "") &&
      !isFacebookUrl(currentTabUrl)
    ) {
      title = "Facebook 영상 페이지를 열어 주세요.";
      hint = "Watch / Reel / 동영상 게시물 주소에서 다시 열어 주세요.";
    } else if (
      /bilibili\.com|b23\.tv/i.test(currentTabUrl || "") &&
      !isBilibiliUrl(currentTabUrl)
    ) {
      title = "Bilibili 영상 페이지를 열어 주세요.";
      hint = "bilibili.com/video/BV… 주소에서 다시 열어 주세요.";
    } else if (isDownloadableSiteVideo(currentTabUrl)) {
      title = "목록을 불러오지 못했습니다.";
      hint = "확장 프로그램을 새로고침한 뒤 다시 열어 주세요. 또는 링크를 붙여 넣어 보세요.";
    }
    listEl.innerHTML = `
      <div class="empty" id="empty">
        <div class="empty-icon">🎬</div>
        <p>${escapeHtml(title)}</p>
        <p class="hint">${escapeHtml(hint)}</p>
      </div>`;
    return;
  }

  const item = items[0];
  const card = document.createElement("article");
  card.className = "card";

  const name = displayName(item);
  const file = downloadFilename(item);
  item._saveAs = file;
  const site = siteLabel(currentTabUrl, item);
  const btnLabel = site ? `${site} 다운로드` : "다운로드";

  // Order: info → quality chips (always visible) → download CTA
  card.innerHTML = `
    <div class="card-top">
      <div class="thumb" aria-hidden="true">${thumbHtml(item)}</div>
      <div class="meta">
        <div class="name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
        <div class="meta-grid">${metaRowsHtml(item)}</div>
      </div>
    </div>
    ${estimateBarHtml(item, qualitiesLoading)}
    ${qualityPickerHtml()}
    <div class="card-actions card-actions-row">
      <button type="button" class="btn primary btn-dl">${escapeHtml(btnLabel)}</button>
      <button type="button" class="btn btn-watch" title="나중에 받기">나중</button>
      <button type="button" class="btn btn-series" title="시리즈 완주">시리즈</button>
    </div>
    <details class="card-details">
      <summary class="card-details-sum">저장 이름 · 상세</summary>
      <div class="filename-box" title="${escapeAttr(file)}">
        <span class="filename-label">저장 이름</span>
        <span class="filename-value">${escapeHtml(file)}</span>
      </div>
    </details>
  `;

  const img = card.querySelector(".thumb-img");
  if (img) {
    img.addEventListener("error", () => {
      img.replaceWith(
        Object.assign(document.createElement("span"), {
          className: "thumb-fallback",
          textContent: "🎬"
        })
      );
    });
  }

  card.querySelectorAll(".q-chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      if (chip.id === "btnReprobeQuality" || chip.classList.contains("q-chip-action")) {
        chip.disabled = true;
        const prev = chip.textContent;
        chip.textContent = "확인 중…";
        try {
          // Rescan page so player height lands on media items
          if (currentTabId != null) {
            await chrome.tabs
              .sendMessage(currentTabId, { type: "SCAN_NOW" })
              .catch(() => null);
            await new Promise((r) => setTimeout(r, 400));
            const media = await chrome.runtime
              .sendMessage({
                type: "GET_MEDIA",
                tabId: currentTabId,
                pageUrl: currentTabUrl
              })
              .catch(() => null);
            if (media?.items?.length) allItems = media.items;
          }
          await loadAvailableQualities(allItems[0] || item);
          render();
          if (isOnlyBareBest(availableQualities)) {
            toast("아직 화질을 못 읽었습니다. 재생 후 다시 확인해 주세요", "error");
          } else {
            toast(
              `화질: ${formatQualityChipLabel(availableQualities[0])}`,
              "ok"
            );
          }
        } catch {
          toast("화질 확인 실패", "error");
          chip.disabled = false;
          chip.textContent = prev || "다시 확인";
        }
        return;
      }
      selectedQuality = chip.getAttribute("data-quality") || "best";
      // Re-render so filename + active chip update
      render();
    });
  });

  card.querySelector(".btn-dl").addEventListener("click", async (e) => {
    if (!canStartAnotherDownload()) {
      toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`, "error");
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "추가됨";
    try {
      await downloadItem(item);
    } finally {
      // Re-enable quickly so another file can be queued
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = prev || "다운로드";
      }, 600);
    }
  });

  card.querySelector(".btn-watch")?.addEventListener("click", async () => {
    // Prefer page URL for sites; fall back to media URL (HLS/mp4)
    const url =
      (item.pageUrl && isWatchlistableUrl(item.pageUrl) && item.pageUrl) ||
      (item.url && isWatchlistableUrl(item.url) && item.url) ||
      currentTabUrl ||
      item.pageUrl ||
      item.url;
    await addCurrentToWatchlist(url);
  });

  card.querySelector(".btn-series")?.addEventListener("click", async () => {
    const title = item.title || item.pageTitle || name;
    const pageUrl = item.pageUrl || item.url || currentTabUrl || "";
    toast("받을 목록을 준비 중…", "ok");
    await offerSeriesComplete(title, pageUrl);
    if (seriesPending?.loading) {
      /* panel shows loading */
    } else if (seriesPending?.items?.length) {
      toast(
        `${seriesPending.items.length}개 항목 · 체크 확인 후 「${
          seriesPending.mode === "playlist" ? "바로 받기" : "나중 받기"
        }」`,
        "ok"
      );
    } else {
      toast(
        "시리즈 코드를 찾지 못했습니다 (예: SSIS-001) · 재생목록이면 목록 페이지에서 시도",
        "error"
      );
    }
  });

  listEl.appendChild(card);
  // Card already has quality chips — hide the global bar
  syncGlobalQualityBox(true);
}

async function downloadItem(item, opts = {}) {
  if (!canStartAnotherDownload()) {
    toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`, "error");
    return;
  }

  const pageUrl = currentTabUrl || item.pageUrl || item.url;
  if (!opts.skipDupCheck) {
    const ok = await confirmNotDuplicate(pageUrl);
    if (!ok) return;
  }
  const hasTiktokCdn =
    item.url &&
    /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(item.url) &&
    !/tiktok\.com\/@|tiktok\.com\/t\//i.test(item.url);
  const useHelper =
    item.isSiteDownload ||
    item.site === "youtube" ||
    item.site === "instagram" ||
    item.site === "x" ||
    item.site === "facebook" ||
    item.site === "bilibili" ||
    isYoutubeUrl(pageUrl) ||
    isYoutubeUrl(item.url) ||
    isInstagramUrl(pageUrl) ||
    isInstagramUrl(item.url) ||
    isXUrl(pageUrl) ||
    isXUrl(item.url) ||
    isFacebookUrl(pageUrl) ||
    isFacebookUrl(item.url) ||
    isBilibiliUrl(pageUrl) ||
    isBilibiliUrl(item.url) ||
    ((item.site === "tiktok" || isTiktokUrl(pageUrl) || isTiktokUrl(item.url)) &&
      !hasTiktokCdn);

  try {
    if (useHelper) {
      await refreshHelperStatus(true);
      if (!helperOk) {
        toast(
          "소셜 사이트 받기에는 로컬 도우미가 필요합니다. helper/start.command 를 실행해 주세요",
          "error"
        );
        return;
      }
    }

    const saveName = downloadFilename({
      ...item,
      quality: selectedQuality === "best" ? item.quality : selectedQuality
    });
    item._saveAs = saveName;
    const title =
      cleanTitleText(item.title || item.pageTitle || item.displayName || "") ||
      cleanTitleText(saveName) ||
      displayName(item) ||
      "영상";

    // Optimistic row so the user sees concurrency immediately
    const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    upsertUiJob(
      {
        id: tempId,
        title,
        filename: saveName || title,
        pageUrl,
        quality: selectedQuality || "",
        status: "running",
        percent: 3,
        message: "대기열에 추가됨…",
        phase: "start",
        startedAt: Date.now()
      },
      { toast: false }
    );

    const res = await chrome.runtime.sendMessage({
      type: useHelper
        ? "DOWNLOAD_PAGE"
        : isHlsItem(item)
          ? "DOWNLOAD_HLS"
          : "DOWNLOAD",
      url: useHelper ? pageUrl : item.url,
      pageUrl,
      filename: saveName,
      tabId: currentTabId,
      preferQuality: selectedQuality || "best",
      mediaType: item.type,
      preferYtDlp: useHelper,
      title,
      autoHls: !useHelper
    });

    // Replace optimistic row with real job id
    if (res?.jobId) {
      uiJobs.delete(tempId);
      trackedJobIds.add(res.jobId);
      upsertUiJob(
        {
          id: res.jobId,
          title,
          filename: saveName || title,
          pageUrl,
          quality: selectedQuality || "",
          status: "running",
          percent: 4,
          message: "백그라운드에서 받는 중…",
          phase: "start",
          startedAt: Date.now()
        },
        { toast: false }
      );
      ensureQueuePoll();
      const n = runningJobCount();
      const short =
        title.length > 28 ? title.slice(0, 26) + "…" : title;
      toast(
        n > 1
          ? `받는 중 ${n}개 · ${short}`
          : `받는 중 · ${short}`,
        "ok"
      );
      // Series list only when user taps 「시리즈」— never auto-show
      return;
    }

    uiJobs.delete(tempId);
    renderDownloadQueue();

    if (res == null) {
      toast("백그라운드에서 받는 중입니다", "ok");
      return;
    }
    if (res?.ok === false) {
      toast(userError(res?.error) || "다운로드 실패", "error");
      return;
    }
    // Legacy full response (should be rare after started:true)
    if (res?.ok) {
      toast("저장 완료 · 다운로드/VideoDownloader", "ok");
    }
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/Receiving end|message port|Extension context|The message port/i.test(msg)) {
      toast("백그라운드에서 계속 받는 중입니다", "ok");
      return;
    }
    toast(userError(e?.message) || "다운로드 실패", "error");
  }
}

async function resolveActiveTab() {
  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true }
  ];
  for (const q of queries) {
    try {
      const tabs = await chrome.tabs.query(q);
      const t = tabs?.find((x) => x.id != null && !String(x.url || "").startsWith("chrome-extension:"));
      if (t?.id) return t;
      if (tabs?.[0]?.id) return tabs[0];
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadMedia() {
  let tab = await resolveActiveTab();
  if (!tab?.id) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🎬</div>
        <p>탭을 찾지 못했습니다.</p>
        <p class="hint">YouTube 영상 탭을 연 뒤 확장을 다시 열어 주세요.</p>
      </div>`;
    return;
  }

  // Refresh tab details (url is sometimes missing on first query)
  try {
    tab = await chrome.tabs.get(tab.id);
  } catch {
    /* keep query result */
  }

  currentTabId = tab.id;
  currentTabUrl = tab.url || tab.pendingUrl || currentTabUrl || null;

  try {
    pageHost.textContent = currentTabUrl ? new URL(currentTabUrl).hostname : "탭 URL 없음";
  } catch {
    pageHost.textContent = currentTabUrl || "—";
  }

  // Debug host line: if not youtube but user thinks they are — show short url
  if (currentTabUrl && pageHost) {
    try {
      const u = new URL(currentTabUrl);
      pageHost.textContent = u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 24) : "");
      pageHost.title = currentTabUrl;
    } catch {
      /* ignore */
    }
  }

  // YouTube often blocks content scripts — never rely only on SCAN
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" });
  } catch {
    /* restricted / not injected */
  }

  // TikTok: SnapTik-style page JSON extract (playAddr / downloadAddr)
  if (isTiktokUrl(currentTabUrl)) {
    try {
      const ext = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_TIKTOK" });
      if (ext?.urls?.length) {
        // Store on window for this session — merged via GET_MEDIA after PAGE_MEDIA
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {
      /* ignore */
    }
  }

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: "GET_MEDIA",
      tabId: currentTabId,
      pageUrl: currentTabUrl,
      title: tab.title || ""
    });
  } catch {
    res = null;
  }
  allItems = ensureSiteItems(Array.isArray(res?.items) ? res.items : [], tab);

  // Ensure thumbnail / title from *current* page only (never keep previous video thumb)
  if (allItems[0]) {
    try {
      const meta = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_META" });
      if (meta?.thumbnail || meta?.title) {
        const curKey = pageKey(currentTabUrl);
        allItems = allItems.map((i) => {
          const itemKey = pageKey(i.pageUrl || i.url || currentTabUrl);
          const same = !itemKey || !curKey || itemKey === curKey;
          return {
            ...i,
            // Prefer fresh page meta thumb; drop mismatched old thumbs
            thumbnail: same
              ? meta.thumbnail || i.thumbnail || undefined
              : meta.thumbnail || undefined,
            title:
              meta.title ||
              (i.title && !/^YouTube|TikTok|Instagram/i.test(i.title) ? i.title : "") ||
              i.title,
            pageTitle: meta.title || i.pageTitle
          };
        });
        chrome.runtime
          .sendMessage({
            type: "PAGE_META",
            tabId: currentTabId,
            pageUrl: currentTabUrl,
            pageMeta: {
              ...meta,
              lastUrl: currentTabUrl,
              // Clear if page has no thumb yet — don't leave previous
              thumbnail: meta.thumbnail || undefined
            }
          })
          .catch(() => {});
      } else {
        // No meta from page — strip thumbs that don't match current URL
        const curKey = pageKey(currentTabUrl);
        allItems = allItems.map((i) => {
          const itemKey = pageKey(i.pageUrl || i.url || "");
          if (itemKey && curKey && itemKey !== curKey) {
            return { ...i, thumbnail: undefined };
          }
          return i;
        });
      }
    } catch {
      /* YouTube often blocks CS — use tab title; clear foreign thumbs */
      const curKey = pageKey(currentTabUrl);
      if (allItems[0]) {
        const itemKey = pageKey(allItems[0].pageUrl || allItems[0].url || "");
        if (itemKey && curKey && itemKey !== curKey) {
          allItems[0].thumbnail = undefined;
        }
      }
      if (tab.title && allItems[0]) {
        const t = tab.title.replace(/\s*[-–—|].*$/, "").trim();
        if (t && t.length > 2) {
          allItems[0].title = t;
          allItems[0].pageTitle = t;
          allItems[0].displayName = t;
        }
      }
    }
  }

  // If HLS missing duration/size, ask background to probe then refresh list
  const first = allItems[0];
  if (first && isHlsItem(first) && !first.isSiteDownload && !(first.duration >= 1)) {
    try {
      await chrome.runtime.sendMessage({
        type: "PROBE_HLS",
        url: first.url,
        tabId: currentTabId
      });
      await new Promise((r) => setTimeout(r, 600));
      res = await chrome.runtime.sendMessage({
        type: "GET_MEDIA",
        tabId: currentTabId,
        pageUrl: currentTabUrl
      });
      if (res?.items?.length) allItems = res.items;
    } catch {
      /* ignore */
    }
  }

  await refreshHelperStatus();
  updateQuickPageUi();
  // Auto-fill link input with current social page URL
  autofillLinkFromCurrentTab();

  // First paint (may show "화질 확인 중…")
  qualitiesLoading = true;
  render();
  // Then resolve real available qualities for this video
  if (allItems[0]) {
    await loadAvailableQualities(allItems[0]);
  } else {
    availableQualities = [{ id: "best", label: "최고" }];
    qualitiesLoading = false;
  }
  render();

  // Playlist panel (YouTube /playlist?list= or watch+list)
  if (
    currentTabUrl &&
    (UVD.isPlaylistOnlyUrl(currentTabUrl) ||
      UVD.isWatchInPlaylistUrl?.(currentTabUrl))
  ) {
    loadPlaylistInfo(currentTabUrl).catch(() => {});
  } else {
    hidePlaylistBox();
  }
}

function siteDisplayName(url) {
  if (isInstagramUrl(url)) return "Instagram";
  if (isTiktokUrl(url)) return "TikTok";
  if (isYoutubeUrl(url)) return "YouTube";
  if (isXUrl(url)) return "X";
  if (isFacebookUrl(url)) return "Facebook";
  if (isBilibiliUrl(url)) return "Bilibili";
  return "이 페이지";
}

function updateQuickPageUi() {
  const box = $("#quickBox");
  const btn = $("#btnThisPage");
  const hint = $("#quickHint");
  if (!box || !btn) return;
  // Card already has primary download — hide duplicate quick CTA when video card is shown
  const hasCard = !!(allItems[0] && isSitePage(currentTabUrl));
  if (currentTabUrl && isSitePage(currentTabUrl) && !hasCard) {
    box.classList.remove("hidden");
    const name = siteDisplayName(currentTabUrl);
    btn.textContent = `이 ${name} 영상 받기`;
    if (hint) {
      hint.textContent =
        name === "Instagram"
          ? "로그인 후 가장 잘 받음 · Alt+Shift+D"
          : `바로 저장 · Alt+Shift+D`;
    }
  } else {
    box.classList.add("hidden");
  }
}

function autofillLinkFromCurrentTab() {
  const input = $("#linkInput");
  if (!input || !currentTabUrl) return;
  if (isSitePage(currentTabUrl)) {
    input.value = currentTabUrl;
    input.title = currentTabUrl;
  }
}

$("#btnScan").addEventListener("click", async () => {
  $("#btnScan").textContent = "…";
  await loadMedia();
  $("#btnScan").textContent = "↻";
});

$("#btnClear").addEventListener("click", async () => {
  if (currentTabId == null) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_MEDIA", tabId: currentTabId });
  allItems = [];
  render();
});

function normalizePastedUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // allow bare social hosts without scheme
  if (
    !/^https?:\/\//i.test(s) &&
    /^(www\.)?(tiktok|youtube|youtu\.be|vm\.tiktok|vt\.tiktok|instagram|instagr\.am|x\.com|twitter\.com|t\.co|facebook\.com|fb\.watch|fb\.com|bilibili\.com|b23\.tv)/i.test(
      s
    )
  ) {
    s = "https://" + s;
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/i.test(u.protocol)) return "";
    return u.href;
  } catch {
    return "";
  }
}

function fnameBaseFromLink(link) {
  try {
    if (isTiktokUrl(link)) {
      const m = link.match(/video\/(\d+)/);
      return m ? `TikTok_${m[1]}` : "TikTok";
    }
    if (isYoutubeUrl(link)) {
      const u = new URL(link);
      const id = u.searchParams.get("v") || u.pathname.split("/").pop();
      return id ? `YouTube_${id}` : "YouTube";
    }
    if (isInstagramUrl(link)) {
      const m = link.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      return m ? `Instagram_${m[2]}` : "Instagram";
    }
    if (isXUrl(link)) {
      const m = link.match(/status\/(\d+)/i);
      return m ? `X_${m[1]}` : "X";
    }
    if (isFacebookUrl(link)) {
      try {
        const u = new URL(link);
        const v = u.searchParams.get("v");
        if (v) return `Facebook_${v}`;
        const m = u.pathname.match(/\/(videos|reel|reels|watch)\/([^/?#]+)/i);
        if (m) return `Facebook_${m[2]}`;
      } catch {
        /* ignore */
      }
      return "Facebook";
    }
    if (isBilibiliUrl(link)) {
      const m = link.match(/\/video\/(BV[\w]+|av\d+)/i);
      return m ? `Bilibili_${m[1]}` : "Bilibili";
    }
  } catch {
    /* ignore */
  }
  return UVD.siteFromUrl(link) || "영상";
}

async function downloadByPastedLink(forcedUrl, opts = {}) {
  const input = $("#linkInput");
  const btn = $("#btnLinkDl");
  const thisBtn = $("#btnThisPage");
  const skipDup = !!opts.skipDupCheck;

  // Multi-link batch when textarea has several URLs (and no single forcedUrl override list)
  if (!forcedUrl) {
    const urls = updateLinkCount().filter(
      (u) => isWatchlistableUrl(u) || looksLikeDirectMedia(u)
    );
    if (urls.length > 1) {
      // Filter out known duplicates (unless user forced)
      let toStart = urls;
      if (!skipDup && uvdSettings.warnDuplicates !== false) {
        const kept = [];
        let skipped = 0;
        for (const u of urls) {
          const dup = await UVD.findDuplicateDone(u).catch(() => null);
          if (dup) skipped += 1;
          else kept.push(u);
        }
        if (!kept.length) {
          toast(
            `모두 이미 받은 링크입니다 (${skipped}개). 기록에서 다시 받기를 쓰세요`,
            "ok"
          );
          return;
        }
        if (skipped) {
          toast(`${skipped}개는 이미 받아 건너뛰고 ${kept.length}개만 시작합니다`, "ok");
        }
        toStart = kept;
      }
      if (runningJobCount() + toStart.length > MAX_CONCURRENT_STARTS) {
        toast(
          `동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 — 일부만 시작합니다`,
          "ok"
        );
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = "일괄…";
      }
      try {
        await refreshHelperStatus(true);
        // Use first URL's site default quality for batch
        const batchQ = selectedQuality || "best";
        const res = await chrome.runtime.sendMessage({
          type: "DOWNLOAD_BATCH",
          urls: toStart,
          tabId: currentTabId,
          preferQuality: batchQ
        });
        if (res?.ok) {
          toast(
            res.truncated
              ? `${res.count}개 시작 (전체 ${res.total}개 중)`
              : `${res.count}개 일괄 다운로드 시작`,
            "ok"
          );
          if (input) input.value = "";
          updateLinkCount();
          ensureQueuePoll();
          await refreshJobsFromBackground();
        } else {
          toast(userError(res?.error) || "일괄 다운로드 실패", "error");
        }
      } catch (e) {
        toast(userError(e?.message) || "일괄 다운로드 실패", "error");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "받기";
        }
        if (thisBtn) {
          thisBtn.disabled = false;
          updateQuickPageUi();
        }
      }
      return;
    }
  }

  if (!canStartAnotherDownload()) {
    toast(`동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`, "error");
    return;
  }

  const raw = forcedUrl || input?.value || "";
  const parsed = UVD.parseUrlsFromText(raw);
  const link = normalizePastedUrl(parsed[0] || raw);
  if (!link) {
    toast("유효한 링크를 붙여 넣어 주세요 (YT/TT/IG/X/FB/B站)", "error");
    input?.focus();
    return;
  }

  if (!skipDup) {
    const ok = await confirmNotDuplicate(link);
    if (!ok) return;
  }

  // Apply site default quality for this link when chips not yet loaded
  applySiteDefaultQuality(link);
  if (!isWatchlistableUrl(link) && !looksLikeDirectMedia(link)) {
    toast("유효한 http(s) 링크가 필요합니다", "error");
    return;
  }

  // Pure playlist URL → load panel + series selection banner
  if (UVD.isPlaylistOnlyUrl(link)) {
    await loadPlaylistInfo(link, true);
    toast("재생목록 불러옴 · 위 시리즈 패널에서 체크 후 받으세요", "ok");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "추가…";
  }

  try {
    const mediaUrl = opts.mediaUrl || "";
    const pageUrlHint = opts.pageUrl || link;
    const isSocial =
      isYoutubeUrl(link) ||
      isTiktokUrl(link) ||
      isInstagramUrl(link) ||
      isXUrl(link) ||
      isFacebookUrl(link) ||
      isBilibiliUrl(link) ||
      UVD.isPlaylistUrl(link);
    const isDirectMedia =
      looksLikeDirectMedia(link) ||
      /\.m3u8(\?|$|#)/i.test(link) ||
      looksLikeDirectMedia(mediaUrl) ||
      /\.m3u8(\?|$|#)/i.test(mediaUrl || "");
    // Prefer real title from current card / opts when available
    const sameAsCard =
      allItems[0] &&
      pageKey(allItems[0].pageUrl || allItems[0].url || "") === pageKey(link);
    const realTitle =
      (opts.title && cleanTitleText(opts.title)) ||
      (sameAsCard
        ? allItems[0].title || allItems[0].pageTitle || allItems[0].displayName
        : "");
    const displayLabel =
      (realTitle && !UVD.isGenericSaveName(realTitle) && cleanTitleText(realTitle)) ||
      fnameBaseFromLink(link) ||
      "영상";
    const preferQ = opts.quality || selectedQuality || "best";
    // Empty filename → helper uses yt-dlp video title (readable)
    const filename = downloadFilename({
      title: realTitle || "",
      pageTitle: realTitle || "",
      displayName: realTitle || "",
      pageUrl: pageUrlHint,
      type: uvdSettings.mediaMode === "audio" ? "audio" : "video"
    });

    const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    upsertUiJob(
      {
        id: tempId,
        title: displayLabel,
        filename: filename || displayLabel,
        pageUrl: pageUrlHint,
        quality: preferQ,
        status: "running",
        percent: 3,
        message: "대기열에 추가됨…",
        phase: "start",
        startedAt: Date.now()
      },
      { toast: false }
    );

    let res;
    if (isSocial) {
      await refreshHelperStatus(true);
      res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_CURRENT_PAGE",
        url: link,
        pageUrl: link,
        // Only force name when we have a real human title
        filename: filename || undefined,
        tabId: currentTabId,
        preferQuality: preferQ,
        title: realTitle && !UVD.isGenericSaveName(realTitle) ? realTitle : undefined
      });
    } else if (mediaUrl || (isDirectMedia && /\.(m3u8|mp4|webm|mkv)/i.test(mediaUrl || link))) {
      // 123av 등: 저장된 스트림 또는 직접 미디어 URL
      const stream = mediaUrl || link;
      const isHls = /\.m3u8(\?|$|#)/i.test(stream);
      res = await chrome.runtime.sendMessage({
        type: isHls ? "DOWNLOAD_HLS" : "DOWNLOAD",
        url: stream,
        pageUrl: pageUrlHint,
        filename: filename || undefined,
        tabId: currentTabId,
        preferQuality: preferQ,
        mediaType: isHls ? "stream" : "video",
        preferYtDlp: false,
        openPageIfNeeded: true,
        title: realTitle || displayLabel
      });
    } else {
      // Generic video page (123av / missav / jable …) — open & scan if needed
      res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_PAGE",
        url: link,
        pageUrl: link,
        filename: filename || undefined,
        tabId: currentTabId,
        preferQuality: preferQ,
        title: realTitle || displayLabel
      });
    }

    if (res?.jobId) {
      uiJobs.delete(tempId);
      trackedJobIds.add(res.jobId);
      upsertUiJob(
        {
          id: res.jobId,
          title: displayLabel,
          filename: filename || displayLabel,
          pageUrl: link,
          status: "running",
          percent: 4,
          message: "백그라운드에서 받는 중…",
          phase: "start",
          startedAt: Date.now()
        },
        { toast: false }
      );
      ensureQueuePoll();
      const n = runningJobCount();
      toast(
        n > 1
          ? `다운로드 ${n}개 동시 진행 중`
          : "받기 시작 · 페이지를 이동해도 계속됩니다",
        "ok"
      );
      if (input && !forcedUrl) {
        input.value = "";
        updateLinkCount();
      }
      return;
    }

    uiJobs.delete(tempId);
    renderDownloadQueue();

    if (res == null) {
      toast("백그라운드에서 받는 중입니다", "ok");
      return;
    }
    if (res?.ok === false) {
      toast(userError(res?.error) || "다운로드 실패", "error");
      return;
    }
    if (res?.ok) {
      toast(`저장 완료 · 다운로드/${uvdSettings.subfolder || "VideoDownloader"}`, "ok");
    }
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/Receiving end|message port|Extension context|The message port/i.test(msg)) {
      toast("백그라운드에서 계속 받는 중입니다", "ok");
    } else {
      toast(userError(e?.message) || "다운로드 실패", "error");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "받기";
    }
    if (thisBtn) {
      thisBtn.disabled = false;
      updateQuickPageUi();
    }
  }
}

async function downloadThisPage() {
  if (!currentTabUrl || !isSitePage(currentTabUrl)) {
    toast("지원 사이트 페이지에서 열어 주세요", "error");
    return;
  }
  if ($("#linkInput")) $("#linkInput").value = currentTabUrl;
  await downloadByPastedLink(currentTabUrl);
}

function looksLikeDirectMedia(url) {
  return (
    /\.(mp4|webm|mov|m4v|mkv|m3u8|mpd)(\?|$|#)/i.test(url || "") ||
    /mime_type=video/i.test(url || "") ||
    /\/videoplayback/i.test(url || "")
  );
}

$("#btnLinkDl")?.addEventListener("click", () => downloadByPastedLink());
$("#btnThisPage")?.addEventListener("click", () => downloadThisPage());
$("#linkInput")?.addEventListener("input", () => updateLinkCount());
$("#linkInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    downloadByPastedLink();
  }
});

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.getAttribute("data-tab")));
});
document.querySelectorAll(".mode-chip").forEach((c) => {
  c.addEventListener("click", async () => {
    const mode = c.getAttribute("data-mode") || "video";
    uvdSettings.mediaMode = mode;
    applyModeChips();
    try {
      const res = await chrome.runtime.sendMessage({
        type: "SET_SETTINGS",
        settings: { mediaMode: mode }
      });
      if (res?.settings) uvdSettings = res.settings;
    } catch {
      /* local only */
    }
    updateFooterNote();
    if (allItems[0]) render();
    toast(
      mode === "audio"
        ? "오디오만 (MP3)으로 받습니다"
        : mode === "video_subs"
          ? "영상 + 자막으로 받습니다"
          : "영상(MP4)으로 받습니다",
      "ok"
    );
  });
});
$("#btnSaveSettings")?.addEventListener("click", () => saveSettingsFromForm());
$("#setTemplate")?.addEventListener("input", updateSettingsPreview);
$("#setSubfolder")?.addEventListener("input", () => {
  uvdSettings.subfolder = $("#setSubfolder").value;
  updateSettingsPreview();
});
$("#setMediaMode")?.addEventListener("change", updateSettingsPreview);
$("#btnClearHistory")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" }).catch(() => {});
  historyItems = [];
  renderHistory();
  updateRetryFailedButton();
  toast("기록을 비웠습니다", "ok");
});
$("#btnRetryFailed")?.addEventListener("click", () => retryFailedDownloads());
$("#btnHelperFix")?.addEventListener("click", () => showHelperHelp());
$("#btnHelperStart")?.addEventListener("click", () => downloadHelperStarter());
$("#btnHelperRecheck")?.addEventListener("click", async () => {
  toast("도우미 상태 확인 중…", "ok");
  await refreshHelperStatus(true);
  toast(helperOk ? "도우미 연결됨" : "아직 꺼져 있습니다 · 실행 파일을 더블클릭하세요", helperOk ? "ok" : "error");
});
$("#btnPlDownload")?.addEventListener("click", () => downloadPlaylistAll());
$("#btnPlSelect")?.addEventListener("click", () => selectPlaylistForDownload());
$("#btnPlRefresh")?.addEventListener("click", () => {
  const url = playlistInfo?.url || currentTabUrl;
  if (url) loadPlaylistInfo(url, true);
});
$("#btnSeriesGo")?.addEventListener("click", () => runSeriesComplete());
$("#btnSeriesDismiss")?.addEventListener("click", () => hideSeriesBanner());
$("#btnSeriesRetryFailed")?.addEventListener("click", () =>
  retrySeriesFailed()
);
$("#btnSeriesSelAll")?.addEventListener("click", () => setSeriesSelection("all"));
$("#btnSeriesSelPending")?.addEventListener("click", () =>
  setSeriesSelection("pending")
);
$("#btnSeriesSelNone")?.addEventListener("click", () =>
  setSeriesSelection("none")
);
$("#seriesRange")?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.(".series-range-chip");
  if (!btn) return;
  if (btn.id === "btnSeriesMissingOnly") {
    toggleSeriesMissingOnly();
    return;
  }
  const r = btn.getAttribute("data-range");
  if (r) setSeriesRange(r);
});

// Library filters
let libSearchTimer = null;
$("#libSearch")?.addEventListener("input", () => {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => {
    libFilter.q = $("#libSearch")?.value || "";
    loadHistoryUi();
  }, 220);
});
$("#libStatus")?.addEventListener("change", () => {
  libFilter.status = $("#libStatus")?.value || "done";
  loadHistoryUi();
});
$("#libSite")?.addEventListener("change", () => {
  libFilter.site = $("#libSite")?.value || "";
  loadHistoryUi();
});
$("#libSeries")?.addEventListener("change", () => {
  libFilter.series = $("#libSeries")?.value || "";
  loadHistoryUi();
});
$("#btnAddWatch")?.addEventListener("click", () => addCurrentToWatchlist());
$("#btnWatchDlAll")?.addEventListener("click", () => downloadAllWatchlist());
$("#btnClearWatch")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_WATCHLIST" }).catch(() => {});
  watchlistItems = [];
  renderWatchlist();
  toast("나중 받기를 비웠습니다", "ok");
});

$("#btnClipApply")?.addEventListener("click", () => {
  const url = $("#clipBanner")?.dataset?.url || $("#clipBannerUrl")?.textContent || "";
  if (!url || url === "—") return;
  if ($("#linkInput")) {
    $("#linkInput").value = url;
    updateLinkCount();
  }
  hideClipBanner();
  toast("링크를 적용했습니다 · 받기를 누르세요", "ok");
  switchTab("main");
});
$("#btnClipDismiss")?.addEventListener("click", () => {
  dismissedClip = $("#clipBanner")?.dataset?.url || lastClipSeen || "";
  hideClipBanner();
});

// One-shot autofill when clipboard watch is OFF (legacy convenience)
(async () => {
  try {
    if (uvdSettings.clipboardWatch) return; // watch handles suggestions instead
    if ($("#linkInput")?.value) return;
    if (currentTabUrl && isSitePage(currentTabUrl)) return;
    const text = await navigator.clipboard.readText();
    const urls = UVD.parseUrlsFromText(text);
    if (urls.length > 1) {
      $("#linkInput").value = urls.join("\n");
      updateLinkCount();
      return;
    }
    const link = normalizePastedUrl(urls[0] || text);
    if (
      link &&
      (isYoutubeUrl(link) ||
        isTiktokUrl(link) ||
        isInstagramUrl(link) ||
        isXUrl(link) ||
        isFacebookUrl(link) ||
        isBilibiliUrl(link))
    ) {
      $("#linkInput").value = link;
      updateLinkCount();
    }
  } catch {
    /* clipboard permission may be denied */
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "MEDIA_UPDATED" && msg.tabId === currentTabId) {
    // Do NOT wipe YT/TT card with empty network updates
    // Filter out items whose pageUrl identity doesn't match current tab
    const curKey = pageKey(currentTabUrl);
    const items = (msg.items || []).map((i) => {
      const k = pageKey(i.pageUrl || i.url || "");
      if (curKey && k && k !== curKey && i.isSiteDownload) {
        return { ...i, thumbnail: undefined, url: currentTabUrl, pageUrl: currentTabUrl };
      }
      if (curKey && k && k !== curKey) {
        return { ...i, thumbnail: undefined };
      }
      return i;
    });
    allItems = ensureSiteItems(items, {
      url: currentTabUrl,
      title: (items[0] && items[0].title) || ""
    });
    render();
    refreshHelperStatus();
  }

  // Global download jobs — multi-queue (concurrent + page leave)
  if (msg.type === "DOWNLOAD_JOB" && msg.job) {
    const job = msg.job;
    if (job.id) trackedJobIds.add(job.id);
    applyJobProgress(job);
    // Always keep action buttons available for more concurrent downloads
    const btn = $("#btnLinkDl");
    const thisBtn = $("#btnThisPage");
    if (btn && btn.textContent !== "추가…") {
      btn.disabled = false;
      btn.textContent = "받기";
    }
    if (thisBtn) {
      thisBtn.disabled = false;
      updateQuickPageUi();
    }
    if (job.status === "done") loadRecentStrip();
    return;
  }

  // Progress from any tab / global job (page leave must not hide it)
  if (msg.type === "HLS_PROGRESS") {
    const p = msg.progress;
    if (!p) return;
    const isOurs =
      p.global ||
      p.jobId ||
      msg.tabId === currentTabId ||
      msg.tabId === -1 ||
      (p.jobId && trackedJobIds.has(p.jobId)) ||
      runningJobCount() > 0;
    if (!isOurs) return;
    if (p.jobId) trackedJobIds.add(p.jobId);
    applyJobProgress(p);
  }

  if (msg.type === "HISTORY_UPDATED" && Array.isArray(msg.history)) {
    historyItems = msg.history;
    loadRecentStrip();
    if (activeTabName === "history") {
      renderHistory();
      updateRetryFailedButton();
    } else {
      updateRetryFailedButton();
    }
  }
  if (msg.type === "WATCHLIST_UPDATED" && Array.isArray(msg.watchlist)) {
    watchlistItems = msg.watchlist;
    if (activeTabName === "watch") renderWatchlist();
  }
});

// Restore settings + in-flight downloads, then load page media
(async () => {
  await loadSettings();
  setupClipboardWatch();
  await restoreActiveDownloads();
  await loadMedia();
  updateLinkCount();
  await loadRecentStrip();
})();
