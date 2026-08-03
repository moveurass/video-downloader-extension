/**
 * Universal Video Downloader — Background Service Worker
 * Detect media, merge HLS, save via chrome.downloads (verified complete).
 */
importScripts("hls-downloader.js", "naming.js", "ytdlp.js");

/** @type {Map<number, Map<string, object>>} */
const tabMedia = new Map();
/** @type {Map<number, { title?: string, thumbnail?: string, host?: string, lastUrl?: string }>} */
const tabMeta = new Map();
const hlsProgress = new Map();
const videoAssemblies = new Map();
const probedUrls = new Set();
const REFERER_RULE_ID = 771001;

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

function isTiktokUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  return (
    h === "tiktok.com" ||
    h.endsWith(".tiktok.com") ||
    h === "vm.tiktok.com" ||
    h === "vt.tiktok.com" ||
    h === "m.tiktok.com" ||
    h.includes("tiktokv.com") ||
    h.includes("tiktokcdn")
  );
}

/** Sites that need local yt-dlp helper for reliable full-quality download */
function needsYtDlpHelper(url, pageUrl) {
  return (
    isYoutubeUrl(url) ||
    isYoutubeUrl(pageUrl) ||
    isTiktokUrl(url) ||
    isTiktokUrl(pageUrl)
  );
}

function siteKind(url, pageUrl) {
  if (isYoutubeUrl(url) || isYoutubeUrl(pageUrl)) return "youtube";
  if (isTiktokUrl(url) || isTiktokUrl(pageUrl)) return "tiktok";
  return null;
}

function makeSitePlaceholder(tab) {
  const pageUrl = tab?.url || "";
  const kind = siteKind(pageUrl, pageUrl);
  if (!kind) return null;
  const meta = tab?.id != null ? tabMeta.get(tab.id) : null;
  const title =
    meta?.title ||
    Naming.cleanPageTitle(tab?.title || "") ||
    (kind === "youtube" ? "YouTube 영상" : "TikTok 영상");
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
  if (/tiktokcdn|musical\.ly|byteicdn|ibyteimg|tiktokv\.com/i.test(url) && /video|play|media|mime_type=video/i.test(url)) {
    return true;
  }
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

function emitDownloadProgress(tabId, percent, message, phase = "download") {
  const progress = { percent, message, phase };
  hlsProgress.set(tabId ?? -1, progress);
  chrome.runtime
    .sendMessage({ type: "HLS_PROGRESS", tabId: tabId ?? -1, progress })
    .catch(() => {});
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
  const thumbnail = item.thumbnail || meta?.thumbnail || undefined;
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
  const next = {
    title: meta.title || prev.title,
    thumbnail: meta.thumbnail || prev.thumbnail,
    host: meta.host || prev.host,
    lastUrl: meta.lastUrl || prev.lastUrl
  };
  tabMeta.set(tabId, next);

  const map = tabMedia.get(tabId);
  if (!map) return;
  let changed = false;
  for (const [url, item] of map) {
    const patched = enrichItem(tabId, item);
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
  // Async badge so YT/TT still show "1"
  getMediaForTabAsync(tabId)
    .then((items) => {
      const count = items?.length || 0;
      chrome.action.setBadgeText({
        tabId,
        text: count > 0 ? String(count) : ""
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
  chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
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
  if (pageUrl && /^https?:/i.test(pageUrl) && needsYtDlpHelper(pageUrl, pageUrl)) {
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
    // YouTube / TikTok: always expose page-level item (yt-dlp)
    if (needsYtDlpHelper(url, url)) {
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

async function downloadViaYtDlp(tabId, url, pageUrl, filename, preferQuality) {
  const available = await YtDlp.available();
  if (!available) {
    throw new Error(
      "YouTube·TikTok은 로컬 도우미가 필요합니다. helper/start.command 를 실행한 뒤 다시 시도해 주세요"
    );
  }

  const targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : url;
  const kind = siteKind(url, targetPage);
  const label =
    kind === "youtube" ? "YouTube" : kind === "tiktok" ? "TikTok" : "영상";

  emitDownloadProgress(tabId, 4, `${label} 준비 중…`, "start");

  const result = await YtDlp.downloadAndWait(
    {
      url: targetPage,
      pageUrl: targetPage,
      filename: filename || undefined,
      title: filename || undefined,
      quality: preferQuality || "best",
      site: kind || undefined
    },
    (p) => {
      let message = p.message || "받는 중…";
      // Soften raw yt-dlp lines
      if (/\[download\]/i.test(message)) message = `받는 중… ${Math.round(p.percent || 0)}%`;
      if (/Merging|Merger/i.test(message)) message = "파일 합치는 중…";
      if (/Destination|Writing/i.test(message)) message = "저장 중…";
      if (/ERROR/i.test(message)) message = message.slice(0, 120);
      emitDownloadProgress(tabId, p.percent || 10, message, p.status || "download");
    },
    40 * 60 * 1000
  );

  emitDownloadProgress(tabId, 100, "저장 완료", "done");
  return {
    ok: true,
    method: "yt-dlp",
    // No chrome.downloads id — file written by helper to Downloads/VideoDownloader
    downloadId: null,
    ytdlp: true,
    path: result.path || result.outDir || "",
    outDir: result.outDir || "",
    filename: result.filename || filename,
    size: result.size || 0
  };
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
  tabMedia.delete(tabId);
  tabMeta.delete(tabId);
  hlsProgress.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    try {
      const prev = tabMeta.get(tabId)?.lastUrl || "";
      const next = changeInfo.url;
      const prevPath = prev ? new URL(prev).origin + new URL(prev).pathname : "";
      const nextPath = new URL(next).origin + new URL(next).pathname;
      if (prevPath && prevPath === nextPath) {
        setTabMeta(tabId, { lastUrl: next });
      } else {
        tabMedia.delete(tabId);
        tabMeta.delete(tabId);
        updateBadge(tabId);
        setTabMeta(tabId, { lastUrl: next });
      }
    } catch {
      tabMedia.delete(tabId);
      tabMeta.delete(tabId);
      updateBadge(tabId);
    }
  } else if (changeInfo.status === "complete" && tab?.url) {
    setTabMeta(tabId, {
      lastUrl: tab.url,
      title: Naming.cleanPageTitle(tab.title || "") || undefined,
      host: (() => {
        try {
          return new URL(tab.url).hostname;
        } catch {
          return undefined;
        }
      })()
    });
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
  });
}
chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);
setupContextMenus();

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
      await downloadSmart(tabId, info.srcUrl, fname, "best", item?.type || "video", item, {
        pageUrl: tab.url
      });
    }
    if (info.menuItemId === "uvd-download-best") {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "SCAN_NOW" });
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 800));
      const best = getMediaForTab(tabId)[0];
      if (!best) throw new Error("감지된 영상이 없습니다");
      await downloadSmart(
        tabId,
        best.url,
        best.filename,
        "best",
        best.type,
        best,
        { pageUrl: tab.url }
      );
    }
  } catch (e) {
    console.warn("[UVD] context menu", e);
  }
});

// ─── downloads ─────────────────────────────────────────────

function startKeepAlive() {
  const id = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {
      /* ignore */
    }
  }, 2000);
  // Alarms also prevent SW kill during long merges/saves
  try {
    chrome.alarms.create("uvd-dl-keepalive", { periodInMinutes: 0.5 });
  } catch {
    /* ignore */
  }
  return id;
}

function stopKeepAlive(id) {
  if (id) clearInterval(id);
  try {
    chrome.alarms.clear("uvd-dl-keepalive");
  } catch {
    /* ignore */
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
      id = await startChromeDownload(objectUrl, `VideoDownloader/${name}`);
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
    id = await startChromeDownload(dataUrl, `VideoDownloader/${name}`);
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
    id = await startChromeDownload(url, `VideoDownloader/${name}`);
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

async function withTabReferer(tabId, fn) {
  let pageUrl = "";
  let origin = "";
  try {
    if (tabId != null && tabId >= 0) {
      const tab = await chrome.tabs.get(tabId);
      pageUrl = tab.url || "";
      origin = pageUrl ? new URL(pageUrl).origin : "";
    }
  } catch {
    /* ignore */
  }

  if (pageUrl && chrome.declarativeNetRequest) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [REFERER_RULE_ID],
        addRules: [
          {
            id: REFERER_RULE_ID,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "Referer", operation: "set", value: pageUrl },
                ...(origin
                  ? [{ header: "Origin", operation: "set", value: origin }]
                  : [])
              ]
            },
            condition: {
              urlFilter: "*",
              resourceTypes: ["xmlhttprequest", "media", "other", "sub_frame"]
            }
          }
        ]
      });
    } catch (e) {
      console.warn("[UVD] DNR", e);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await chrome.declarativeNetRequest?.updateSessionRules({
        removeRuleIds: [REFERER_RULE_ID]
      });
    } catch {
      /* ignore */
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

async function runHlsDownload(tabId, url, preferQuality, filenameHint, itemHint) {
  if (!url) throw new Error("받을 주소가 없습니다");
  const key = tabId ?? -1;
  const setProg = (p) => {
    hlsProgress.set(key, p);
    chrome.runtime
      .sendMessage({ type: "HLS_PROGRESS", tabId: key, progress: p })
      .catch(() => {});
  };

  setProg({ phase: "start", message: "준비 중…", percent: 2 });

  const result = await HLS.downloadAndMerge(url, {
    preferQuality: preferQuality || "best",
    requestInit: { credentials: "include", cache: "no-store" },
    onProgress: (p) => {
      let percent = 3;
      let message = "준비 중…";
      if (p.phase === "segments" && p.total) {
        percent = Math.round((p.current / p.total) * 88) + 5;
        message = `받는 중… ${percent}%`;
      } else if (p.phase === "merge") {
        percent = 94;
        message = "파일 만드는 중…";
      } else if (p.phase === "playlist") {
        percent = 5;
        message = "준비 중…";
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
      chrome.tabs.sendMessage(tabId, { type: "SMART_DOWNLOAD", ...payload }),
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
  const pageUrl =
    options.pageUrl || itemHint?.pageUrl || (await resolvePageUrl(tabId, ""));

  emitDownloadProgress(tabId, 3, "시작…", "start");

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
        preferQuality
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
      emitDownloadProgress(tabId, 5, "스트림으로 전환…");
    }
  }

  if (workUrl.startsWith("blob:")) {
    emitDownloadProgress(tabId, 10, "버퍼 추출 중…");
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
      emitDownloadProgress(tabId, 100, "저장 완료", "done");
      return pageResult;
    }
    throw new Error(
      pageResult?.error || "이 영상은 받을 수 없습니다. 재생 후 다시 시도해 주세요"
    );
  }

  const hls = isRealHls(workUrl, workType);

  if (hls) {
    emitDownloadProgress(tabId, 6, "받는 중…", "playlist");
    try {
      const result = await withTimeout(
        withTabReferer(tabId, () =>
          runHlsDownload(tabId, workUrl, preferQuality, filename, workItem)
        ),
        40 * 60 * 1000,
        "다운로드 시간 초과"
      );
      if ((result.size || 0) < 100_000) throw new Error("파일이 너무 작습니다");
      if (result.downloadId == null) {
        throw new Error("파일이 저장되지 않았습니다");
      }
      emitDownloadProgress(tabId, 100, "저장 완료", "done");
      return result;
    } catch (e) {
      errors.push(friendlyFetchError(e));
    }

    // Page fallback
    emitDownloadProgress(tabId, 8, "다른 방법으로 시도…");
    try {
      const pageResult = await pageDownloadAllFrames(tabId, {
        url: workUrl,
        filename,
        preferQuality,
        mediaType: "stream",
        tabId
      });
      if (
        pageResult?.ok &&
        pageResult.downloadId != null &&
        (pageResult.size || 0) >= 100_000
      ) {
        emitDownloadProgress(tabId, 100, "저장 완료", "done");
        return pageResult;
      }
      errors.push(pageResult?.error || "페이지 병합 실패");
    } catch (e) {
      errors.push(friendlyFetchError(e));
    }

    throw new Error(errors[0] || "다운로드 실패");
  }

  // Direct file
  emitDownloadProgress(tabId, 15, "다운로드 시작…");
  try {
    const saved = await withTimeout(
      withTabReferer(tabId, () => downloadMedia(workUrl, filename)),
      90000,
      "다운로드 시간 초과"
    );
    emitDownloadProgress(tabId, 100, "저장 완료", "done");
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
    emitDownloadProgress(tabId, 100, "저장 완료", "done");
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
      if (tabId != null && msg.pageMeta) setTabMeta(tabId, msg.pageMeta);
      sendResponse({ ok: true });
      break;
    }
    case "PAGE_MEDIA": {
      if (tabId == null) break;
      if (msg.pageMeta) setTabMeta(tabId, msg.pageMeta);
      for (const item of msg.items || []) {
        addMedia(tabId, {
          ...item,
          source: item.source || "page",
          pageUrl: sender.tab?.url
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
                  if (!byLabel.has(lab) || (byLabel.get(lab).height || 0) < h) {
                    byLabel.set(lab, { id: lab, label: lab, height: h });
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
                sendResponse({ ok: true, qualities, source: "hls" });
                return;
              }
            } catch {
              /* fall through to ytdlp / empty */
            }
          }

          // YouTube / TikTok / hard sites
          if (needsYtDlpHelper(url, url) || msg.forceYtDlp) {
            const data = await YtDlp.listFormats(url);
            sendResponse({
              ok: true,
              qualities: data.qualities || [],
              heights: data.heights || [],
              title: data.title || "",
              source: "yt-dlp"
            });
            return;
          }

          // Unknown — only "best"
          sendResponse({
            ok: true,
            qualities: [{ id: "best", label: "최고" }],
            source: "default"
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
      // Download current page URL via yt-dlp (YouTube/TikTok/etc.)
      const tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || msg.url;
      if (!pageUrl) {
        sendResponse({ ok: false, error: "페이지 주소가 없습니다" });
        break;
      }
      const keep = startKeepAlive();
      const fname = safeDownloadName(
        msg.filename || resolveFilename(tid, { title: msg.title, pageTitle: msg.title }, pageUrl),
        "video/mp4"
      );
      downloadViaYtDlp(tid, pageUrl, pageUrl, fname, msg.preferQuality || "best")
        .then((r) => {
          stopKeepAlive(keep);
          sendResponse({ ok: true, ...r, filename: r.filename || fname });
        })
        .catch((err) => {
          stopKeepAlive(keep);
          sendResponse({ ok: false, error: String(err.message || err) });
        });
      return true;
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
      sendResponse({ ok: true, version: "1.9.5" });
      break;
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
      const tid = msg.tabId ?? tabId;
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

      const keep = setInterval(() => {
        try {
          chrome.runtime.getPlatformInfo(() => {});
        } catch {
          /* ignore */
        }
      }, 4000);

      const preferYtDlp =
        msg.preferYtDlp === true ||
        item?.isSiteDownload ||
        needsYtDlpHelper(url, msg.pageUrl || item?.pageUrl);

      downloadSmart(tid, url, fname, msg.preferQuality || "best", mediaType, item, {
        pageUrl: msg.pageUrl || item?.pageUrl,
        preferYtDlp
      })
        .then((r) => {
          clearInterval(keep);
          // yt-dlp writes files itself — no chrome.downloads id
          if (r?.method === "yt-dlp" || r?.ytdlp) {
            sendResponse({
              ok: true,
              ...r,
              filename: r.filename || fname
            });
            return;
          }
          // Browser path requires a real chrome.downloads id
          if (r == null || r.downloadId == null) {
            sendResponse({
              ok: false,
              error:
                r?.error ||
                "파일이 저장되지 않았습니다. chrome://downloads 를 확인해 주세요"
            });
            return;
          }
          sendResponse({
            ok: true,
            ...r,
            filename: r.filename || fname
          });
        })
        .catch((err) => {
          clearInterval(keep);
          sendResponse({ ok: false, error: String(err.message || err) });
        });
      return true;
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

console.log("[VideoDownloader] ready v1.9.5");
