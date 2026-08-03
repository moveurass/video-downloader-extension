/**
 * Popup: one best video + download. YouTube/TikTok via local helper.
 */

let currentTabId = null;
let currentTabUrl = null;
let allItems = [];
let downloading = false;
let helperOk = false;
/** Selected download quality id (best | 4K | 1080p | …) */
let selectedQuality = "best";
/** Only qualities that exist for the current video */
let availableQualities = [{ id: "best", label: "최고" }];
let qualitiesLoading = false;

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
  if (/tiktok\.com/i.test(url) || /tiktokv\.com/i.test(url)) return true;
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return h.includes("tiktok");
  } catch {
    return false;
  }
}

function isSitePage(url) {
  return isYoutubeUrl(url) || isTiktokUrl(url);
}

/** watch / shorts / youtu.be / tiktok video pages */
function isDownloadableSiteVideo(url) {
  if (!url) return false;
  if (isYoutubeUrl(url)) {
    // Be permissive: any youtube URL can try yt-dlp; home page will error with clear message
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./i, "") === "youtu.be" && u.pathname.length > 1) return true;
      if (u.searchParams.get("v")) return true;
      if (/\/(shorts|live|embed|clip)\/[\w-]+/i.test(u.pathname)) return true;
      if (/\/watch/i.test(u.pathname)) return true;
      // Playlist watch, etc.
      if (/[?&]v=/i.test(url)) return true;
      // If path is only / or /results /feed — not a video
      if (/^\/?(results|feed|shorts\/?)?$/i.test(u.pathname.replace(/\/+$/, "") || "/")) {
        return false;
      }
      // Any other deep path — allow card (yt-dlp decides)
      return u.pathname.length > 1;
    } catch {
      return /[?&]v=|\/shorts\/|youtu\.be\//i.test(url);
    }
  }
  if (isTiktokUrl(url)) {
    return (
      /\/video\/\d+|\/@[\w.-]+\/video\//i.test(url) ||
      /vm\.tiktok\.com|vt\.tiktok\.com/i.test(url) ||
      // Allow showing card on most tiktok pages
      true
    );
  }
  return false;
}

function siteLabel(url, item) {
  if (item?.site === "youtube" || isYoutubeUrl(url || item?.url || item?.pageUrl)) return "YouTube";
  if (item?.site === "tiktok" || isTiktokUrl(url || item?.url || item?.pageUrl)) return "TikTok";
  return null;
}

/** Always-available card for YT/TT when background has no media */
function buildLocalSiteItem(tab) {
  const pageUrl = tab?.url || currentTabUrl || "";
  if (!pageUrl || !isSitePage(pageUrl)) return null;
  // Still show card on video-ish URLs; for pure home show card too with generic name
  // (user can click; helper returns clear error if not a video)
  const kind = isYoutubeUrl(pageUrl) ? "youtube" : "tiktok";
  let title = String(tab?.title || "")
    .replace(/^\(\d{1,4}\)\s*/, "") // tab/notification count e.g. "(2) Title"
    .replace(/\s*[-–—|]\s*YouTube\s*$/i, "")
    .replace(/\s*[-–—|]\s*TikTok\s*$/i, "")
    .replace(/\s*[-–—|].*$/, "")
    .replace(/^\(\d{1,4}\)\s*/, "")
    .trim();
  if (!title || (/^(youtube|tiktok)$/i.test(title) && title.length < 12)) {
    title = kind === "youtube" ? "YouTube 영상" : "TikTok 영상";
  }
  const safeBase = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
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
    filename: `${safeBase || (kind === "youtube" ? "YouTube" : "TikTok")}.mp4`,
    // real resolution is unknown until download — don't put "best" in the filename
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
  const need = isSitePage(currentTabUrl) || allItems.some((i) => i.isSiteDownload || i.site);
  if (!need) {
    helperBar.classList.add("hidden");
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
      helperText.textContent = `YouTube·TikTok 준비됨${h.ytdlpVersion ? ` · yt-dlp ${h.ytdlpVersion}` : ""}`;
    } else {
      helperBar.classList.add("warn");
      helperText.textContent =
        "도우미 꺼짐 — helper/start.command 실행 후 다시 열어 주세요";
    }
  } catch {
    helperOk = false;
    helperBar.classList.add("warn");
    helperText.textContent =
      "도우미 꺼짐 — helper/start.command 실행 후 다시 열어 주세요";
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

function metaRowsHtml(item) {
  const site = siteLabel(currentTabUrl, item);
  const dur = formatDuration(item.duration);
  const est = estimateSize(item);
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
 * 저장 파일명 — 제목으로 구분
 * 예: "SSIS-001 이복 여동생 이야기_720p.mp4"
 */
function downloadFilename(item) {
  let base = "";
  for (const c of [item.title, item.pageTitle, item.displayName]) {
    const cleaned = cleanTitleText(c);
    if (cleaned && !isUglyName(cleaned) && cleaned.length > base.length) {
      base = cleaned;
    }
  }
  if (!base || isUglyName(base)) base = "영상";

  if (base.length > 52) {
    base = base.slice(0, 50).replace(/\s+\S*$/, "") || base.slice(0, 50);
  }
  base = base.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();

  // Prefer user-selected quality for filename (skip "best")
  let qTag = "";
  if (selectedQuality && !/^(best|all)$/i.test(selectedQuality)) {
    qTag = `_${selectedQuality}`;
  } else if (
    item.quality &&
    item.quality !== "unknown" &&
    !/^(best|all|unknown|highest)$/i.test(item.quality) &&
    !base.includes(item.quality)
  ) {
    qTag = `_${item.quality}`;
  }
  const ext = item.type === "audio" ? ".mp3" : ".mp4";
  return `${base}${qTag}${ext}`;
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
      <span class="quality-label">화질 <span class="quality-hint-inline">(이 영상에서 가능)</span></span>
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
  try {
    const res = await chrome.runtime.sendMessage({
      type: "LIST_QUALITIES",
      url: mediaUrl,
      pageUrl,
      tabId: currentTabId,
      mediaType: item?.type,
      forceYtDlp: !!(item?.isSiteDownload || isSitePage(pageUrl))
    });
    if (res?.qualities?.length) {
      availableQualities = res.qualities;
    } else {
      availableQualities = [{ id: "best", label: "최고" }];
    }
  } catch {
    availableQualities = [{ id: "best", label: "최고" }];
  }
  // Keep selection if still available, else highest
  if (!availableQualities.some((q) => q.id === selectedQuality)) {
    selectedQuality = availableQualities[0]?.id || "best";
  }
  qualitiesLoading = false;
}

function thumbHtml(item) {
  const src = item.thumbnail;
  if (src) {
    return `<img class="thumb-img" src="${escapeAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<span class="thumb-fallback">🎬</span>`;
}

function showProgress(show, percent = 0, text = "") {
  if (!show) {
    progressEl.classList.add("hidden");
    return;
  }
  progressEl.classList.remove("hidden");
  progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  progressText.textContent = text || `받는 중… ${percent}%`;
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
  if (/Failed to fetch|NetworkError|네트워크 접근|CORS|Load failed/i.test(s)) {
    return "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 눌러 주세요";
  }
  if (/재생목록 URL|m3u8|playlist only/i.test(s) && /직접 저장|병합/i.test(s)) {
    return "스트리밍 영상을 합치는 중 문제가 생겼습니다. 다시 시도해 주세요";
  }
  if (/Blob URL|blob/i.test(s) && /Capture|캡처|받을 수/i.test(s)) {
    return "이 영상 형식을 바로 받을 수 없습니다. 재생 후 다시 시도해 주세요";
  }
  if (/도우미|start\.command|yt-dlp not|ytdlp|8787/i.test(s)) {
    return "YouTube·TikTok은 로컬 도우미가 필요합니다. helper/start.command 를 실행해 주세요";
  }
  if (/DRM|SAMPLE-AES|Widevine/i.test(s)) return "보호된 영상이라 받을 수 없습니다";
  if (/HTTP 403|HTTP 401|접근 거부/i.test(s)) {
    return "접근이 거부되었습니다. 재생 후 다시 시도해 주세요";
  }
  if (/HTTP \d{3}/i.test(s)) {
    return "서버에서 영상을 주지 않았습니다. 재생 후 다시 시도해 주세요";
  }
  if (/너무 작|세그먼트 부족|병합 실패|유효한 세그먼트/i.test(s)) {
    return "영상 데이터를 충분히 받지 못했습니다. 재생 후 다시 시도해 주세요";
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

  // Strip technical prefixes; never show raw English "url ..." dumps
  let clean = s.replace(/^Error:\s*/i, "").trim();
  if (/^https?:\/\//i.test(clean) || /url/i.test(clean) && clean.length < 40) {
    return "받을 수 없는 주소입니다. 페이지를 새로고침한 뒤 재생해 주세요";
  }
  // If mostly English technical, soften
  if (/^[A-Za-z0-9\s:./_-]+$/.test(clean) && /url|fetch|http|blob|null|undefined/i.test(clean)) {
    return "다운로드에 실패했습니다. 재생 후 다시 시도해 주세요";
  }
  if (clean.length > 90) return clean.slice(0, 87) + "…";
  return clean || "다운로드에 실패했습니다";
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
  return [
    {
      ...local,
      ...top,
      url: local.url,
      pageUrl: local.pageUrl,
      isSiteDownload: true,
      site: local.site,
      title: top.title || local.title,
      pageTitle: top.pageTitle || local.pageTitle,
      displayName: top.displayName || local.displayName,
      filename: top.filename || local.filename,
      thumbnail: top.thumbnail || local.thumbnail
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
    let hint = "페이지를 연 뒤 ↻ 를 눌러 보세요.";
    if (isSitePage(currentTabUrl) && !isDownloadableSiteVideo(currentTabUrl)) {
      title = "영상 페이지를 열어 주세요.";
      hint = isYoutubeUrl(currentTabUrl)
        ? "YouTube에서 영상을 재생(watch/shorts)한 뒤 다시 열어 주세요."
        : "TikTok 영상 페이지에서 다시 열어 주세요.";
    } else if (isSitePage(currentTabUrl)) {
      title = "목록을 불러오지 못했습니다.";
      hint = "확장 프로그램을 새로고침(chrome://extensions)한 뒤 다시 열어 주세요.";
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

  card.innerHTML = `
    <div class="card-top">
      <div class="thumb">${thumbHtml(item)}</div>
      <div class="meta">
        <div class="name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
        <div class="meta-grid">${metaRowsHtml(item)}</div>
        <div class="filename-box" title="${escapeAttr(file)}">
          <span class="filename-label">저장 이름</span>
          <span class="filename-value">${escapeHtml(file)}</span>
        </div>
      </div>
    </div>
    ${qualityPickerHtml()}
    <div class="card-actions">
      <button type="button" class="btn primary btn-dl">${escapeHtml(btnLabel)}</button>
    </div>
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
      if (downloading) return;
      selectedQuality = chip.getAttribute("data-quality") || "best";
      // Re-render so filename + active chip update
      render();
    });
  });

  card.querySelector(".btn-dl").addEventListener("click", async (e) => {
    if (downloading) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "받는 중…";
    downloading = true;
    try {
      await downloadItem(item);
    } finally {
      downloading = false;
      btn.disabled = false;
      btn.textContent = prev || "다운로드";
    }
  });

  listEl.appendChild(card);
}

async function downloadItem(item) {
  showProgress(true, 5, "받는 중…");
  let finished = false;
  // Long streams can take many minutes — only warn, don't cancel SW work
  const watchdog = setTimeout(() => {
    if (finished) return;
    toast("아직 받는 중입니다. 팝업을 닫지 말고 기다려 주세요…", "error");
  }, 120_000);

  const pageUrl = currentTabUrl || item.pageUrl || item.url;
  const useHelper =
    item.isSiteDownload ||
    item.site === "youtube" ||
    item.site === "tiktok" ||
    isSitePage(pageUrl) ||
    isSitePage(item.url);

  try {
    if (useHelper) {
      await refreshHelperStatus(true);
      if (!helperOk) {
        finished = true;
        clearTimeout(watchdog);
        showProgress(false);
        toast(
          "YouTube·TikTok은 로컬 도우미가 필요합니다. helper/start.command 를 실행해 주세요",
          "error"
        );
        return;
      }
    }

    // Refresh filename with current quality pick
    const saveName = downloadFilename({
      ...item,
      quality: selectedQuality === "best" ? item.quality : selectedQuality
    });
    item._saveAs = saveName;
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
      title: item.title || item.pageTitle || saveName,
      autoHls: !useHelper
    });
    finished = true;
    clearTimeout(watchdog);

    const ytdlpOk = res?.ok && (res.method === "yt-dlp" || res.ytdlp);
    const chromeOk = res?.ok && res.downloadId != null;

    if (ytdlpOk || chromeOk) {
      const sz = res.size || 0;
      if (chromeOk && sz > 0 && sz < 200_000) {
        showProgress(false);
        toast("파일이 너무 작습니다. 실제 영상이 저장되지 않았을 수 있습니다", "error");
      } else {
        showProgress(true, 100, "저장 완료");
        setTimeout(() => showProgress(false), 1500);
        const mb = sz >= 1024 * 1024 ? `${(sz / 1024 / 1024).toFixed(1)}MB` : "";
        const where = res.path
          ? res.path.split(/[/\\]/).slice(-2).join("/")
          : res.outDir
            ? "다운로드/VideoDownloader"
            : "다운로드/VideoDownloader";
        toast(mb ? `저장 완료 (${mb}) · ${where}` : `저장 완료 · ${where}`, "ok");
        try {
          if (res.downloadId != null) {
            chrome.downloads.show(res.downloadId);
          } else if (res.path && typeof res.path === "string" && res.path.includes("/")) {
            // Open downloads folder for helper-saved files
            chrome.downloads.showDefaultFolder?.();
          }
        } catch {
          /* ignore */
        }
      }
    } else {
      showProgress(false);
      toast(
        userError(res?.error) ||
          "다운로드 실패 — 저장이 확인되지 않았습니다",
        "error"
      );
    }
  } catch (e) {
    finished = true;
    clearTimeout(watchdog);
    showProgress(false);
    toast(userError(e?.message) || "다운로드 실패", "error");
  } finally {
    finished = true;
    clearTimeout(watchdog);
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

  // Ensure thumbnail / title from page when possible
  if (allItems[0]) {
    try {
      const meta = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_META" });
      if (meta?.thumbnail || meta?.title) {
        allItems = allItems.map((i) => ({
          ...i,
          thumbnail: i.thumbnail || meta.thumbnail,
          title: i.title && !/^YouTube|TikTok/i.test(i.title) ? i.title : meta.title || i.title,
          pageTitle: meta.title || i.pageTitle
        }));
        chrome.runtime
          .sendMessage({
            type: "PAGE_META",
            tabId: currentTabId,
            pageMeta: meta
          })
          .catch(() => {});
      }
    } catch {
      /* YouTube often blocks CS — use tab title */
      if (tab.title && allItems[0]) {
        const t = tab.title.replace(/\s*[-–—|].*$/, "").trim();
        if (t && t.length > 2) {
          allItems[0].title = allItems[0].title || t;
          allItems[0].pageTitle = allItems[0].pageTitle || t;
          allItems[0].displayName = allItems[0].displayName || t;
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "MEDIA_UPDATED" && msg.tabId === currentTabId) {
    // Do NOT wipe YT/TT card with empty network updates
    allItems = ensureSiteItems(msg.items || [], {
      url: currentTabUrl,
      title: (msg.items && msg.items[0] && msg.items[0].title) || ""
    });
    render();
    refreshHelperStatus();
  }
  if (msg.type === "HLS_PROGRESS" && (msg.tabId === currentTabId || msg.tabId === -1)) {
    const p = msg.progress;
    if (!p) return;
    if (p.phase === "error") {
      showProgress(false);
    } else if (p.phase === "done") {
      showProgress(true, 100, "저장 완료");
      setTimeout(() => showProgress(false), 800);
    } else {
      const pct = p.percent || 10;
      // Never surface raw segment counts like "1234/2375"
      let text = `받는 중… ${Math.round(pct)}%`;
      if (
        p.message &&
        !/\d+\s*\/\s*\d+/.test(p.message) &&
        !/조각|세그먼트|\[download\]|ERROR/i.test(p.message)
      ) {
        text = p.message;
      } else if (p.phase === "merge" || /만들|합치|Merg/i.test(p.message || "")) {
        text = "파일 만드는 중…";
      } else if (p.phase === "save" || /저장/i.test(p.message || "")) {
        text = "저장 중…";
      }
      showProgress(true, pct, text);
    }
  }
});

loadMedia();
