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
let availableQualities = [{ id: "best", label: "최고" }];
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
  return false;
}

function siteLabel(url, item) {
  if (item?.site === "youtube" || isYoutubeUrl(url || item?.url || item?.pageUrl)) return "YouTube";
  if (item?.site === "tiktok" || isTiktokUrl(url || item?.url || item?.pageUrl)) return "TikTok";
  if (item?.site === "instagram" || isInstagramUrl(url || item?.url || item?.pageUrl)) {
    return "Instagram";
  }
  return null;
}

function siteKindFromUrl(pageUrl) {
  if (isYoutubeUrl(pageUrl)) return "youtube";
  if (isTiktokUrl(pageUrl)) return "tiktok";
  if (isInstagramUrl(pageUrl)) return "instagram";
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
    .replace(/\s*[-–—|].*$/, "")
    .replace(/^\(\d{1,4}\)\s*/, "")
    .trim();
  const defaults = {
    youtube: "YouTube 영상",
    tiktok: "TikTok 영상",
    instagram: "Instagram 영상"
  };
  if (!title || /^(youtube|tiktok|instagram)$/i.test(title)) {
    title = defaults[kind] || "영상";
  }
  const safeBase = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const label = kind === "youtube" ? "YouTube" : kind === "tiktok" ? "TikTok" : "Instagram";
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

async function refreshHelperStatus(force = false) {
  if (!helperBar) return;
  const need =
    isSitePage(currentTabUrl) ||
    allItems.some((i) => i.isSiteDownload || i.site) ||
    !!$("#linkInput")?.value;
  const fixBtn = $("#btnHelperFix");
  if (!need) {
    helperBar.classList.add("hidden");
    fixBtn?.classList.add("hidden");
    return;
  }
  helperBar.classList.remove("hidden");
  helperBar.classList.remove("ok", "warn");
  helperText.textContent = "도우미 확인 중…";
  try {
    const h = await chrome.runtime.sendMessage({ type: "YTDLP_HEALTH", force });
    helperOk = !!(h?.ok && h?.ytdlp);
    if (helperOk) {
      helperBar.classList.add("ok");
      helperText.textContent = `YT·TikTok·Instagram 준비됨${
        h.ytdlpVersion ? ` · yt-dlp ${h.ytdlpVersion}` : ""
      }`;
      fixBtn?.classList.add("hidden");
    } else {
      helperBar.classList.add("warn");
      helperText.textContent =
        "도우미 꺼짐 — helper/install_autostart.command 실행";
      fixBtn?.classList.remove("hidden");
    }
  } catch {
    helperOk = false;
    helperBar.classList.add("warn");
    helperText.textContent =
      "도우미 꺼짐 — helper/install_autostart.command 실행";
    fixBtn?.classList.remove("hidden");
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

/** Clean page title → readable Korean/Japanese name */
function cleanTitleText(raw) {
  if (!raw) return "";
  let t = String(raw);
  // HTML entities
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  // Tab/notification counters: "(2) Video title"
  t = t.replace(/^\(\d{1,4}\)\s*/, "").replace(/^\[\d{1,4}\]\s*/, "");
  // emoji / symbols
  t = t
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[♥❤💕💗💖💘⭐✨♡]/g, "");
  // site suffixes
  t = t.replace(
    /\s*[\-|–—|·•:]\s*(YouTube|123AV|123av|MissAV|Jable|Netflix|Twitch|Bilibili).*$/i,
    ""
  );
  t = t.replace(/^\(\d{1,4}\)\s*/, "");
  // strip extension / junk
  t = t
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
  const candidates = [
    item.title,
    item.pageTitle,
    item.displayName,
    item.filename
  ];
  // 가장 길고 읽기 좋은 제목 선택
  let best = "";
  for (const c of candidates) {
    const cleaned = cleanTitleText(c);
    if (!cleaned || isUglyName(cleaned) || cleaned.length < 2) continue;
    if (cleaned.length > best.length) best = cleaned;
  }
  if (!best) best = "영상";
  if (best.length > 70) best = best.slice(0, 68).trim() + "…";
  return best;
}

/**
 * 저장 파일명 — 예전 방식: 읽기 쉬운 제목 + (선택) 화질
 * 예: "SSIS-001 이복 여동생 이야기_720p.mp4"
 * 제목을 모를 때는 빈 문자열 → yt-dlp가 실제 제목 사용
 */
function downloadFilename(item) {
  let title = "";
  for (const c of [item.title, item.pageTitle, item.displayName]) {
    const cleaned = cleanTitleText(c);
    if (
      cleaned &&
      !isUglyName(cleaned) &&
      !UVD.isGenericSaveName(cleaned) &&
      cleaned.length > title.length
    ) {
      title = cleaned;
    }
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
  const pageUrl = item.pageUrl || item.url || currentTabUrl || "";
  let base = UVD.applyFilenameTemplate(uvdSettings.filenameTemplate || "legacy", {
    title,
    quality,
    site: UVD.siteFromUrl(pageUrl),
    mediaMode
  });

  // Fallback only for non-helper direct saves — still avoid YouTube_id junk
  if (!base) {
    if (title && !UVD.isGenericSaveName(title)) {
      base = title.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
      if (quality && !base.includes(quality)) base += `_${quality}`;
    }
  }

  const ext =
    mediaMode === "audio" || item.type === "audio" ? ".mp3" : ".mp4";
  if (!base) return ""; // let helper/extractor choose real title
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

function qualityPickerHtml() {
  if (qualitiesLoading) {
    return `
      <div class="quality-picker">
        <span class="quality-label">화질</span>
        <p class="quality-hint">가능한 화질 확인 중…</p>
      </div>`;
  }
  const opts =
    availableQualities?.length > 0
      ? availableQualities
      : [{ id: "best", label: "최고" }];
  // Ensure selection is still valid
  if (!opts.some((q) => q.id === selectedQuality)) {
    selectedQuality = opts[0].id;
  }
  return `
    <div class="quality-picker">
      <span class="quality-label">화질</span>
      <div class="quality-chips" role="group" aria-label="화질 선택">
        ${opts
          .map(
            (q) =>
              `<button type="button" class="q-chip${
                selectedQuality === q.id ? " active" : ""
              }" data-quality="${escapeAttr(q.id)}">${escapeHtml(q.label)}</button>`
          )
          .join("")}
      </div>
    </div>`;
}

async function loadAvailableQualities(item) {
  qualitiesLoading = true;
  availableQualities = [{ id: "best", label: "최고" }];
  const pageUrl = currentTabUrl || item?.pageUrl || item?.url || "";
  const mediaUrl = item?.url || pageUrl;

  // Don't probe homepage/profile — yt-dlp returns "Unsupported URL"
  if (!isDownloadableSiteVideo(mediaUrl) && !isDownloadableSiteVideo(pageUrl)) {
    availableQualities = [{ id: "best", label: "최고" }];
    qualitiesLoading = false;
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "LIST_QUALITIES",
      url: mediaUrl,
      pageUrl,
      tabId: currentTabId,
      mediaType: item?.type,
      forceYtDlp: !!(item?.isSiteDownload || isDownloadableSiteVideo(pageUrl))
    });
    if (res?.ok && res.qualities?.length) {
      // Drop any junk labels (errors must never become chips)
      availableQualities = res.qualities.filter(
        (q) =>
          q &&
          q.id &&
          q.label &&
          !/unsupported|error|fail|http/i.test(String(q.label)) &&
          !/unsupported|error/i.test(String(q.id))
      );
      if (!availableQualities.length) {
        availableQualities = [{ id: "best", label: "최고" }];
      }
    } else {
      availableQualities = [{ id: "best", label: "최고" }];
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
      if (bestQ?.height) patch._bestHeight = bestQ.height;
      // Per-quality sizes already on chips; also stash on item for "best"
      if (bestQ?.estimatedSize) {
        patch.estimatedSize = bestQ.estimatedSize;
        patch._sizeApprox = true;
      }
      allItems[0] = patch;
    }
  } catch {
    availableQualities = [{ id: "best", label: "최고" }];
  }
  // Prefer per-site default quality when available
  applySiteDefaultQuality(pageUrl || mediaUrl);
  if (!availableQualities.some((q) => q.id === selectedQuality)) {
    selectedQuality = availableQualities[0]?.id || "best";
  }
  qualitiesLoading = false;
}

/** Pick site default quality (or nearest lower) from available chips */
function applySiteDefaultQuality(pageUrl) {
  const pref = UVD.qualityForSite(uvdSettings, pageUrl || currentTabUrl || "");
  if (!pref) return;
  if (availableQualities.some((q) => q.id === pref)) {
    selectedQuality = pref;
    return;
  }
  // Prefer nearest lower resolution if exact missing (e.g. want 1080 but only 720)
  const order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"];
  const prefIdx = order.indexOf(pref);
  if (prefIdx >= 0) {
    for (let i = prefIdx; i < order.length; i++) {
      if (availableQualities.some((q) => q.id === order[i])) {
        selectedQuality = order[i];
        return;
      }
    }
  }
  if (availableQualities.some((q) => q.id === "best")) {
    selectedQuality = "best";
  }
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

function shortJobTitle(job) {
  const raw =
    job?.title ||
    job?.filename ||
    job?.pageUrl ||
    "영상";
  let t = String(raw)
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/\.mp4$/i, "")
    .trim();
  if (t.length > 36) t = t.slice(0, 34) + "…";
  return t || "영상";
}

function cleanJobMessage(msg, phase) {
  let text = String(msg || "").trim();
  if (!text || /\d+\s*\/\s*\d+/.test(text) || /조각|세그먼트|\[download\]/i.test(text)) {
    if (phase === "merge") return "파일 만드는 중…";
    if (phase === "save") return "저장 중…";
    return "받는 중…";
  }
  if (/ERROR/i.test(text)) return text.slice(0, 48);
  if (phase === "merge" || /만들|합치|Merg/i.test(text)) return "파일 만드는 중…";
  if (phase === "save" || /^저장/i.test(text)) return "저장 중…";
  if (text.length > 42) text = text.slice(0, 40) + "…";
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

async function refreshJobsFromBackground() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
    const jobs = res?.jobs || [];
    let changed = false;
    for (const j of jobs) {
      if (!j?.id) continue;
      trackedJobIds.add(j.id);
      const prev = uiJobs.get(j.id);
      if (
        !prev ||
        prev.status !== j.status ||
        prev.percent !== j.percent ||
        prev.message !== j.message
      ) {
        upsertUiJob(j, { toast: false });
        changed = true;
      } else {
        uiJobs.set(j.id, { ...prev, ...j });
      }
    }
    // Drop very old finished jobs not in SW anymore (keep 45s for UX)
    const now = Date.now();
    for (const [id, j] of uiJobs) {
      if (j.status === "running") continue;
      if (!jobs.some((x) => x.id === id) && now - (j.updatedAt || 0) > 45_000) {
        uiJobs.delete(id);
        changed = true;
      }
    }
    if (changed || jobs.length) renderDownloadQueue();
  } catch {
    /* ignore */
  }
}

/** Throttle full queue re-renders while many jobs tick */
let queueRenderTimer = null;
let queueDirty = false;
function scheduleQueueRender() {
  queueDirty = true;
  if (queueRenderTimer) return;
  queueRenderTimer = setTimeout(() => {
    queueRenderTimer = null;
    if (!queueDirty) return;
    queueDirty = false;
    renderDownloadQueue();
  }, 180);
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

  // Per-job monotonic percent (stops bar bouncing when events interleave)
  let percent =
    typeof job.percent === "number"
      ? job.percent
      : typeof prev.percent === "number"
        ? prev.percent
        : 0;
  if (
    status === "running" &&
    prev.status === "running" &&
    typeof prev.percent === "number" &&
    typeof job.percent === "number" &&
    job.percent < prev.percent - 0.5
  ) {
    // Allow reset only when clearly starting a new phase from near-zero
    if (!(job.percent <= 8 && prev.percent >= 20 && /start|playlist|준비/i.test(job.message || job.phase || ""))) {
      percent = prev.percent;
    }
  }
  percent = Math.max(0, Math.min(100, percent));

  const next = {
    ...prev,
    ...job,
    id,
    status,
    percent,
    message: job.message || prev.message || "",
    title: job.title || prev.title || job.filename || "영상",
    filename: job.filename || prev.filename || "",
    pageUrl: job.pageUrl || prev.pageUrl || "",
    error: job.error || (status === "error" ? job.message : prev.error) || null,
    result: job.result || prev.result || null,
    updatedAt: job.updatedAt || Date.now(),
    startedAt: job.startedAt || prev.startedAt || Date.now()
  };

  // Skip no-op updates (same % rounded + same message) to reduce flicker
  if (
    prev.status === next.status &&
    Math.round(prev.percent || 0) === Math.round(next.percent || 0) &&
    prev.message === next.message &&
    status === "running" &&
    opts.toast === false
  ) {
    uiJobs.set(id, next);
    return;
  }

  uiJobs.set(id, next);
  trackedJobIds.add(id);
  syncDownloadingFlag();
  if (status === "done" || status === "error") {
    renderDownloadQueue();
  } else {
    scheduleQueueRender();
  }

  if (opts.toast !== false) {
    if (status === "done" && !toastedJobIds.has(id) && !job._silentDone) {
      toastedJobIds.add(id);
      const path = next.result?.path || next.path || "";
      const where = path
        ? String(path).split(/[/\\]/).slice(-2).join("/")
        : "다운로드/VideoDownloader";
      toast(`저장 완료 · ${where}`, "ok");
    } else if (status === "error" && !toastedJobIds.has(id)) {
      toastedJobIds.add(id);
      toast(userError(next.error || next.message || "다운로드 실패"), "error");
    }
  }

  if (status === "running") ensureQueuePoll();
  // Auto-remove finished rows after a while
  if (status === "done" || status === "error") {
    setTimeout(() => {
      const cur = uiJobs.get(id);
      if (cur && cur.status !== "running") {
        uiJobs.delete(id);
        renderDownloadQueue();
      }
    }, 20_000);
  }
}

function renderDownloadQueue() {
  if (!dlQueueEl || !dlQueueList) return;
  const jobs = [...uiJobs.values()].sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
  );
  const running = jobs.filter((j) => j.status === "running");
  const done = jobs.filter((j) => j.status === "done");
  const errored = jobs.filter((j) => j.status === "error");

  if (!jobs.length) {
    dlQueueEl.classList.add("hidden");
    // hide legacy single bar too
    if (progressEl) progressEl.classList.add("hidden");
    syncDownloadingFlag();
    return;
  }

  dlQueueEl.classList.remove("hidden");
  // Prefer multi queue over single bar
  if (progressEl) progressEl.classList.add("hidden");

  if (dlQueueTitle) {
    if (running.length) {
      dlQueueTitle.textContent = `받는 중 ${running.length}개`;
    } else if (done.length && !errored.length) {
      dlQueueTitle.textContent = `완료 ${done.length}개`;
    } else if (errored.length) {
      dlQueueTitle.textContent = `실패 ${errored.length}개`;
    } else {
      dlQueueTitle.textContent = `다운로드 ${jobs.length}개`;
    }
  }

  if (dlQueueBadge) {
    const n = running.length || done.length || errored.length;
    dlQueueBadge.textContent = String(n);
    dlQueueBadge.classList.remove("hidden", "done", "error");
    if (!running.length && done.length) dlQueueBadge.classList.add("done");
    if (!running.length && errored.length && !done.length) {
      dlQueueBadge.classList.add("error");
    }
  }

  if (dlQueueSub) {
    if (running.length > 1) {
      dlQueueSub.textContent = `${running.length}개 동시 다운로드 진행 중 · 페이지 이동 OK`;
    } else if (running.length === 1) {
      dlQueueSub.textContent = "백그라운드에서 받는 중 · 추가로 더 받을 수 있어요";
    } else if (done.length) {
      dlQueueSub.textContent = "저장 위치: 다운로드/VideoDownloader";
    } else {
      dlQueueSub.textContent = "다시 시도해 주세요";
    }
  }

  dlQueueList.innerHTML = jobs
    .map((j) => {
      const st = j.status || "running";
      const pct = Math.min(100, Math.max(0, Math.round(j.percent || 0)));
      const icon = st === "done" ? "✓" : st === "error" ? "!" : "↓";
      const pctLabel =
        st === "done" ? "완료" : st === "error" ? "실패" : `${pct}%`;
      const msg =
        st === "error"
          ? cleanJobMessage(j.error || j.message || "실패", "error")
          : cleanJobMessage(j.message, j.phase);
      const errMeta =
        st === "error"
          ? UVD.classifyError(j.error || j.message || "")
          : null;
      const actionsHtml =
        st === "error"
          ? recoveryActionsHtml(errMeta, j.pageUrl, j)
          : st === "done"
            ? `<div class="dl-job-actions">
                <button type="button" class="btn" data-act="show" data-path="${escapeAttr(
                  j.result?.path || ""
                )}" data-did="${escapeAttr(
                  j.result?.downloadId ?? ""
                )}">폴더</button>
              </div>`
            : "";
      const errLine =
        st === "error" && errMeta
          ? `<div class="dl-job-err">${escapeHtml(errMeta.label)} — ${escapeHtml(
              errMeta.hint
            )}</div>`
          : "";
      return `
        <div class="dl-job ${st === "done" ? "is-done" : ""} ${
          st === "error" ? "is-error" : ""
        }" data-job-id="${escapeAttr(j.id)}">
          <div class="dl-job-top">
            <span class="dl-job-status ${escapeAttr(st)}" aria-hidden="true">${icon}</span>
            <div class="dl-job-meta">
              <div class="dl-job-title" title="${escapeAttr(
                j.title || j.filename || ""
              )}">${escapeHtml(shortJobTitle(j))}</div>
              <div class="dl-job-msg">${escapeHtml(msg)}</div>
              ${errLine}
            </div>
            <span class="dl-job-pct">${escapeHtml(pctLabel)}</span>
          </div>
          <div class="dl-job-bar">
            <div class="dl-job-fill" style="width:${
              st === "error" ? 100 : pct
            }%"></div>
          </div>
          ${actionsHtml}
        </div>`;
    })
    .join("");

  bindRecoveryButtons(dlQueueList);
  syncDownloadingFlag();
}

function recoveryActionsHtml(errMeta, pageUrl, job) {
  const acts = errMeta?.actions || ["retry"];
  const buttons = [];
  if (acts.includes("retry")) {
    buttons.push(
      `<button type="button" class="btn" data-act="retry" data-url="${escapeAttr(
        pageUrl || job?.pageUrl || ""
      )}">다시 받기</button>`
    );
  }
  if (acts.includes("open_page") && (pageUrl || job?.pageUrl)) {
    buttons.push(
      `<button type="button" class="btn" data-act="open" data-url="${escapeAttr(
        pageUrl || job.pageUrl
      )}">페이지 열기</button>`
    );
  }
  if (acts.includes("login") && (pageUrl || job?.pageUrl)) {
    buttons.push(
      `<button type="button" class="btn" data-act="login" data-url="${escapeAttr(
        pageUrl || job.pageUrl
      )}">로그인</button>`
    );
  }
  if (acts.includes("helper")) {
    buttons.push(
      `<button type="button" class="btn" data-act="helper">도우미 안내</button>`
    );
  }
  if (!buttons.length) return "";
  return `<div class="dl-job-actions">${buttons.join("")}</div>`;
}

function bindRecoveryButtons(root) {
  if (!root) return;
  root.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const act = btn.getAttribute("data-act");
      const url = btn.getAttribute("data-url") || "";
      const path = btn.getAttribute("data-path") || "";
      const did = btn.getAttribute("data-did");
      try {
        if (act === "retry" && url) {
          await downloadByPastedLink(url);
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
          return;
        }
      } catch (err) {
        toast(userError(err?.message) || "실행 실패", "error");
      }
    });
  });
}

function showHelperHelp() {
  toast(
    "helper/install_autostart.command 를 더블클릭해 도우미를 설치·실행하세요",
    "error"
  );
  // Try open extension folder help via GitHub readme
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
  document.body.classList.toggle("compact-ui", uvdSettings.compactUi !== false);
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
  el.textContent = `저장: 다운로드/${folder} · ${mode} · v1.17`;
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
    tpl.value =
      !uvdSettings.filenameTemplate ||
      uvdSettings.filenameTemplate === "legacy" ||
      uvdSettings.filenameTemplate === "{title}_{quality}"
        ? "legacy"
        : uvdSettings.filenameTemplate;
  }
  if (mode) mode.value = uvdSettings.mediaMode || "video";
  if (notify) notify.checked = uvdSettings.notifyOnComplete !== false;
  if (clip) clip.checked = !!uvdSettings.clipboardWatch;
  if (warnDup) warnDup.checked = uvdSettings.warnDuplicates !== false;
  const saveThumb = $("#setSaveThumb");
  if (saveThumb) saveThumb.checked = uvdSettings.saveThumbnail !== false;
  const compact = $("#setCompact");
  if (compact) compact.checked = uvdSettings.compactUi !== false;
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
  let tpl = $("#setTemplate")?.value?.trim() || "legacy";
  // Treat empty / old default as readable legacy style
  if (!tpl || tpl === "{title}_{quality}") tpl = "legacy";
  const patch = {
    subfolder: $("#setSubfolder")?.value?.trim() || "VideoDownloader",
    filenameTemplate: tpl,
    mediaMode: $("#setMediaMode")?.value || "video",
    notifyOnComplete: $("#setNotify")?.checked !== false,
    clipboardWatch: !!$("#setClipboard")?.checked,
    warnDuplicates: $("#setWarnDup")?.checked !== false,
    saveThumbnail: $("#setSaveThumb")?.checked !== false,
    compactUi: $("#setCompact")?.checked !== false,
    qualityBySite: {
      default: $("#setQDefault")?.value || "best",
      youtube: $("#setQYoutube")?.value || "1080p",
      tiktok: $("#setQTiktok")?.value || "best",
      instagram: $("#setQInstagram")?.value || "best"
    }
  };
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SET_SETTINGS",
      settings: patch
    });
    uvdSettings = res?.settings || patch;
    applyModeChips();
    applyCompactUi();
    updateFooterNote();
    setupClipboardWatch();
    // Re-apply site quality to current video
    if (currentTabUrl) applySiteDefaultQuality(currentTabUrl);
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
    const res = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
    historyItems = res?.history || [];
  } catch {
    historyItems = await UVD.getHistory().catch(() => []);
  }
  renderHistory();
  updateRetryFailedButton();
}

function updateRetryFailedButton() {
  const btn = $("#btnRetryFailed");
  if (!btn) return;
  const n = historyItems.filter(
    (h) => h?.status === "error" && /^https?:/i.test(h.pageUrl || h.url || "")
  ).length;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `실패만 재시도 (${n})` : "실패만 재시도";
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

function renderWatchlist() {
  const root = $("#watchList");
  if (!root) return;
  if (!watchlistItems.length) {
    root.innerHTML = `
      <div class="empty small">
        <p>비어 있습니다.</p>
        <p class="hint">링크 옆 「나중」또는 카드에서 추가하세요.</p>
      </div>`;
    return;
  }
  root.innerHTML = watchlistItems
    .map((w) => {
      const title = w.title || "나중에 받을 영상";
      return `
        <div class="history-item" data-watch-id="${escapeAttr(w.id)}">
          <div class="history-top">
            <span class="history-status done">☆</span>
            <div class="history-meta">
              <div class="history-title" title="${escapeAttr(title)}">${escapeHtml(
                title
              )}</div>
              <div class="history-sub">${escapeHtml(
                formatTimeAgo(w.at)
              )} · ${escapeHtml(w.site || UVD.siteFromUrl(w.url) || "")}</div>
            </div>
          </div>
          <div class="history-actions">
            <button type="button" class="btn" data-act="watch-dl" data-url="${escapeAttr(
              w.url || w.pageUrl || ""
            )}" data-id="${escapeAttr(w.id)}">받기</button>
            <button type="button" class="btn" data-act="watch-rm" data-id="${escapeAttr(
              w.id
            )}">삭제</button>
          </div>
        </div>`;
    })
    .join("");
  root.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id") || "";
      const url = btn.getAttribute("data-url") || "";
      if (act === "watch-dl" && url) {
        await downloadByPastedLink(url, { skipDupCheck: false });
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
}

async function addCurrentToWatchlist(forcedUrl) {
  let url = forcedUrl || "";
  if (!url) {
    const fromInput = UVD.parseUrlsFromText($("#linkInput")?.value || "")[0];
    url = fromInput || currentTabUrl || "";
  }
  if (!/^https?:/i.test(url)) {
    toast("추가할 링크가 없습니다", "error");
    return;
  }
  if (
    !isYoutubeUrl(url) &&
    !isTiktokUrl(url) &&
    !isInstagramUrl(url) &&
    !UVD.isPlaylistUrl(url) &&
    !looksLikeDirectMedia(url)
  ) {
    toast("지원 사이트 링크만 추가할 수 있습니다", "error");
    return;
  }
  const title =
    (allItems[0] &&
      pageKey(allItems[0].pageUrl || allItems[0].url || "") === pageKey(url) &&
      (allItems[0].title || allItems[0].pageTitle)) ||
    fnameBaseFromLink(url) ||
    "나중에 받을 영상";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "ADD_WATCHLIST",
      item: {
        url,
        pageUrl: url,
        title: cleanTitleText(title) || title,
        thumbnail: allItems[0]?.thumbnail || "",
        quality: selectedQuality || "",
        site: UVD.siteFromUrl(url)
      }
    });
    watchlistItems = res?.watchlist || [];
    toast("나중 받기에 추가했습니다", "ok");
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

function renderHistory() {
  const root = $("#historyList");
  if (!root) return;
  if (!historyItems.length) {
    root.innerHTML = `<div class="empty small"><p>기록이 없습니다.</p></div>`;
    return;
  }
  root.innerHTML = historyItems
    .map((h) => {
      const ok = h.status === "done";
      const errMeta = !ok ? UVD.classifyError(h.error || "") : null;
      const sub = ok
        ? `${formatTimeAgo(h.at)} · ${h.mediaMode === "audio" ? "오디오" : h.mediaMode === "video_subs" ? "영상+자막" : "영상"}${
            h.size ? ` · ${(h.size / 1024 / 1024).toFixed(1)}MB` : ""
          }`
        : `${formatTimeAgo(h.at)} · ${errMeta?.label || "실패"}`;
      const acts = [];
      if (h.pageUrl || h.url) {
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
      } else if (errMeta) {
        if (errMeta.actions.includes("open_page") && (h.pageUrl || h.url)) {
          acts.push(
            `<button type="button" class="btn" data-act="open" data-url="${escapeAttr(
              h.pageUrl || h.url
            )}">페이지</button>`
          );
        }
        if (errMeta.actions.includes("helper")) {
          acts.push(
            `<button type="button" class="btn" data-act="helper">도우미</button>`
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
              <div class="history-sub">${escapeHtml(sub)}${
                !ok && errMeta
                  ? `<br>${escapeHtml(errMeta.hint)}`
                  : ""
              }</div>
            </div>
          </div>
          <div class="history-actions">${acts.join("")}</div>
        </div>`;
    })
    .join("");
  bindRecoveryButtons(root);
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
      upsertUiJob(
        {
          ...running[0],
          percent: p.percent,
          message: p.message,
          phase: p.phase,
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
  upsertUiJob(
    {
      id: jobId,
      title: p.title,
      percent: p.percent,
      message: p.message || p.error,
      phase: p.phase,
      status:
        p.status ||
        (p.phase === "done" ? "done" : p.phase === "error" ? "error" : "running"),
      error: p.error,
      result: p.result,
      path: p.path,
      filename: p.filename,
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

  // Download CTA first (no scroll) → estimate → quality → details
  card.innerHTML = `
    <div class="card-top">
      <div class="thumb" aria-hidden="true">${thumbHtml(item)}</div>
      <div class="meta">
        <div class="name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
        <div class="meta-grid">${metaRowsHtml(item)}</div>
      </div>
    </div>
    ${estimateBarHtml(item, qualitiesLoading)}
    <div class="card-actions card-actions-row">
      <button type="button" class="btn primary btn-dl">${escapeHtml(btnLabel)}</button>
      <button type="button" class="btn btn-watch" title="나중에 받기">나중</button>
    </div>
    ${qualityPickerHtml()}
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
    chip.addEventListener("click", () => {
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
    const url = item.pageUrl || item.url || currentTabUrl;
    await addCurrentToWatchlist(url);
  });

  listEl.appendChild(card);
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
    isYoutubeUrl(pageUrl) ||
    isYoutubeUrl(item.url) ||
    isInstagramUrl(pageUrl) ||
    isInstagramUrl(item.url) ||
    ((item.site === "tiktok" || isTiktokUrl(pageUrl) || isTiktokUrl(item.url)) &&
      !hasTiktokCdn);

  try {
    if (useHelper) {
      await refreshHelperStatus(true);
      if (!helperOk) {
        toast(
          "YouTube·TikTok은 로컬 도우미가 필요합니다. helper/start.command 를 실행해 주세요",
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
    const title = item.title || item.pageTitle || saveName;

    // Optimistic row so the user sees concurrency immediately
    const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    upsertUiJob(
      {
        id: tempId,
        title,
        filename: saveName,
        pageUrl,
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
          filename: saveName,
          pageUrl,
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
}

function siteDisplayName(url) {
  if (isInstagramUrl(url)) return "Instagram";
  if (isTiktokUrl(url)) return "TikTok";
  if (isYoutubeUrl(url)) return "YouTube";
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
  // allow bare tiktok/youtube without scheme
  if (
    !/^https?:\/\//i.test(s) &&
    /^(www\.)?(tiktok|youtube|youtu\.be|vm\.tiktok|instagram|instagr\.am)/i.test(s)
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
      (u) =>
        isYoutubeUrl(u) ||
        isTiktokUrl(u) ||
        isInstagramUrl(u) ||
        looksLikeDirectMedia(u) ||
        UVD.isPlaylistUrl(u)
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
        const batchQ = UVD.qualityForSite(uvdSettings, toStart[0]) || selectedQuality || "best";
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
    toast("유효한 링크를 붙여 넣어 주세요 (YouTube / TikTok / Instagram)", "error");
    input?.focus();
    return;
  }

  if (!skipDup) {
    const ok = await confirmNotDuplicate(link);
    if (!ok) return;
  }

  // Apply site default quality for this link when chips not yet loaded
  applySiteDefaultQuality(link);
  if (
    !isYoutubeUrl(link) &&
    !isTiktokUrl(link) &&
    !isInstagramUrl(link) &&
    !looksLikeDirectMedia(link) &&
    !UVD.isPlaylistUrl(link)
  ) {
    toast("YouTube, TikTok, Instagram 또는 직접 영상 링크만 지원합니다", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "추가…";
  }

  try {
    const isPage =
      isYoutubeUrl(link) ||
      isTiktokUrl(link) ||
      isInstagramUrl(link) ||
      UVD.isPlaylistUrl(link);
    // Prefer real title from current card when it's the same video page
    const sameAsCard =
      allItems[0] &&
      pageKey(allItems[0].pageUrl || allItems[0].url || "") === pageKey(link);
    const realTitle = sameAsCard
      ? allItems[0].title || allItems[0].pageTitle || allItems[0].displayName
      : "";
    const displayLabel =
      (realTitle && !UVD.isGenericSaveName(realTitle) && cleanTitleText(realTitle)) ||
      fnameBaseFromLink(link);
    // Empty filename → helper uses yt-dlp video title (readable)
    const filename = downloadFilename({
      title: realTitle || "",
      pageTitle: realTitle || "",
      displayName: realTitle || "",
      pageUrl: link,
      type: uvdSettings.mediaMode === "audio" ? "audio" : "video"
    });

    const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    upsertUiJob(
      {
        id: tempId,
        title: displayLabel,
        filename: filename || displayLabel,
        pageUrl: link,
        status: "running",
        percent: 3,
        message: "대기열에 추가됨…",
        phase: "start",
        startedAt: Date.now()
      },
      { toast: false }
    );

    let res;
    if (isPage) {
      await refreshHelperStatus(true);
      res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_CURRENT_PAGE",
        url: link,
        pageUrl: link,
        // Only force name when we have a real human title
        filename: filename || undefined,
        tabId: currentTabId,
        preferQuality: selectedQuality || "best",
        title: realTitle && !UVD.isGenericSaveName(realTitle) ? realTitle : undefined
      });
    } else {
      res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD",
        url: link,
        pageUrl: currentTabUrl || link,
        filename: filename || undefined,
        tabId: currentTabId,
        preferQuality: selectedQuality || "best",
        mediaType: "video",
        preferYtDlp: false,
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
  return /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url || "") || /mime_type=video/i.test(url || "");
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
    if (link && (isYoutubeUrl(link) || isTiktokUrl(link) || isInstagramUrl(link))) {
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
