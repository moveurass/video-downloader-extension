/**
 * Shared helpers for popup + service worker (no DOM).
 * Loaded via importScripts in SW and <script> in popup.
 */
const UVD = (() => {
  const DEFAULT_SETTINGS = {
    subfolder: "VideoDownloader",
    // "legacy" = human title + optional _quality (readable old style)
    filenameTemplate: "legacy",
    mediaMode: "video", // video | audio | video_subs
    maxHistory: 50,
    /** Show OS notification when a download finishes (default on) */
    notifyOnComplete: true,
    /** Opt-in: watch clipboard for social links while popup is open */
    clipboardWatch: false,
    /** Warn when the same video URL was already downloaded */
    warnDuplicates: true,
    /**
     * Per-site default quality id — always "best" (최고).
     * User can still pick another chip per download.
     */
    qualityBySite: {
      default: "best",
      youtube: "best",
      tiktok: "best",
      instagram: "best",
      x: "best",
      facebook: "best",
      bilibili: "best"
    },
    /**
     * Codec preference for yt-dlp format selection:
     * - best: highest quality (VP9/AV1 ok, often MKV)
     * - h264: prefer H.264 for wide playback
     * - compat: H.264 + AAC → MP4 (max compatibility)
     */
    codecPref: "best",
    /** Save cover image as .jpg next to the video */
    saveThumbnail: true,
    /** Compact popup UI (less padding / meta, more CTA above fold) */
    compactUi: true
  };

  const HISTORY_KEY = "uvdHistory";
  const SETTINGS_KEY = "uvdSettings";
  const WATCHLIST_KEY = "uvdWatchlist";

  function mergeSettings(raw) {
    const next = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    // Always use readable legacy filenames (title + optional _quality)
    if (
      !next.filenameTemplate ||
      next.filenameTemplate === "{title}_{quality}" ||
      next.filenameTemplate === "{title}" ||
      String(next.filenameTemplate).includes("{id}")
    ) {
      next.filenameTemplate = "legacy";
    }
    // One-time: default quality is always highest (chips still change per download)
    if (next._qualityDefaultVer !== 3) {
      const qbs = {
        ...(next.qualityBySite && typeof next.qualityBySite === "object"
          ? next.qualityBySite
          : {})
      };
      for (const k of Object.keys(DEFAULT_SETTINGS.qualityBySite)) {
        qbs[k] = "best";
      }
      qbs.default = "best";
      next.qualityBySite = qbs;
      next._qualityDefaultVer = 3;
    }
    return next;
  }

  async function getSettings() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      const raw = data[SETTINGS_KEY];
      const next = mergeSettings(raw);
      // Persist one-time quality/filename migrations
      if (
        raw &&
        (raw._qualityDefaultVer !== next._qualityDefaultVer ||
          raw.filenameTemplate !== next.filenameTemplate)
      ) {
        try {
          await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        } catch {
          /* ignore */
        }
      }
      return next;
    } catch {
      return { ...DEFAULT_SETTINGS, _qualityDefaultVer: 3 };
    }
  }

  async function setSettings(patch) {
    const cur = await getSettings();
    const next = mergeSettings({ ...cur, ...patch });
    // sanitize
    next.subfolder = String(next.subfolder || "VideoDownloader")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.\./g, "")
      .slice(0, 80) || "VideoDownloader";
    next.filenameTemplate = String(
      next.filenameTemplate != null && next.filenameTemplate !== ""
        ? next.filenameTemplate
        : "legacy"
    ).slice(0, 80);
    if (!["video", "audio", "video_subs"].includes(next.mediaMode)) {
      next.mediaMode = "video";
    }
    next.maxHistory = Math.min(100, Math.max(10, Number(next.maxHistory) || 50));
    next.notifyOnComplete = next.notifyOnComplete !== false;
    next.clipboardWatch = !!next.clipboardWatch;
    next.warnDuplicates = next.warnDuplicates !== false;
    next.saveThumbnail = next.saveThumbnail !== false;
    next.compactUi = next.compactUi !== false;
    if (!["best", "h264", "compat"].includes(String(next.codecPref || ""))) {
      next.codecPref = "best";
    }
    const qbs = next.qualityBySite && typeof next.qualityBySite === "object"
      ? next.qualityBySite
      : {};
    next.qualityBySite = {
      ...DEFAULT_SETTINGS.qualityBySite,
      ...qbs
    };
    // sanitize quality ids
    for (const k of Object.keys(next.qualityBySite)) {
      const v = String(next.qualityBySite[k] || "best").trim();
      next.qualityBySite[k] = v || "best";
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async function getHistory() {
    try {
      const data = await chrome.storage.local.get(HISTORY_KEY);
      return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
    } catch {
      return [];
    }
  }

  async function appendHistory(entry) {
    const settings = await getSettings();
    const list = await getHistory();
    const item = {
      id: entry.id || `h_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: entry.title || entry.filename || "영상",
      filename: entry.filename || "",
      url: entry.url || entry.pageUrl || "",
      pageUrl: entry.pageUrl || entry.url || "",
      path: entry.path || "",
      downloadId: entry.downloadId ?? null,
      status: entry.status || "done", // done | error
      error: entry.error || null,
      errorCode: entry.errorCode || classifyError(entry.error || "").code,
      size: entry.size || 0,
      method: entry.method || "",
      quality: entry.quality || "",
      mediaMode: entry.mediaMode || "video",
      site: entry.site || "",
      thumbnail: entry.thumbnail || "",
      at: entry.at || Date.now()
    };
    const next = [item, ...list.filter((x) => x.id !== item.id)].slice(
      0,
      settings.maxHistory || 50
    );
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
    try {
      chrome.runtime
        .sendMessage({ type: "HISTORY_UPDATED", history: next })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return next;
  }

  async function clearHistory() {
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
    return [];
  }

  /** Last N successful downloads (for quick strip) */
  async function getRecentDone(limit = 3) {
    const list = await getHistory();
    return list.filter((h) => h && h.status === "done").slice(0, Math.max(1, limit));
  }

  async function getWatchlist() {
    try {
      const data = await chrome.storage.local.get(WATCHLIST_KEY);
      return Array.isArray(data[WATCHLIST_KEY]) ? data[WATCHLIST_KEY] : [];
    } catch {
      return [];
    }
  }

  async function addWatchlist(entry) {
    const url = entry?.url || entry?.pageUrl || "";
    if (!/^https?:/i.test(url)) throw new Error("유효한 링크가 아닙니다");
    const list = await getWatchlist();
    const key = normalizeUrlKey(url);
    const filtered = list.filter((x) => normalizeUrlKey(x.url || x.pageUrl || "") !== key);
    const mediaUrl =
      entry.mediaUrl && /^https?:/i.test(entry.mediaUrl) ? entry.mediaUrl : "";
    const item = {
      id: entry.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: entry.title || entry.filename || "나중에 받을 영상",
      url,
      pageUrl: entry.pageUrl || url,
      // Captured m3u8/mp4 so 123av 등 일반 사이트도 나중 받기 가능
      mediaUrl: mediaUrl || "",
      thumbnail: entry.thumbnail || "",
      quality: entry.quality || "",
      site: entry.site || siteFromUrl(url),
      // Optional deferred download (ms epoch). 0 / missing = manual only
      scheduleAt: Number(entry.scheduleAt) > 0 ? Number(entry.scheduleAt) : 0,
      scheduleLabel: entry.scheduleLabel || "",
      at: entry.at || Date.now()
    };
    const next = [item, ...filtered].slice(0, 100);
    await chrome.storage.local.set({ [WATCHLIST_KEY]: next });
    try {
      chrome.runtime
        .sendMessage({ type: "WATCHLIST_UPDATED", watchlist: next })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return next;
  }

  async function removeWatchlist(idOrUrl) {
    const list = await getWatchlist();
    const key = normalizeUrlKey(idOrUrl);
    const next = list.filter(
      (x) => x.id !== idOrUrl && normalizeUrlKey(x.url || x.pageUrl || "") !== key
    );
    await chrome.storage.local.set({ [WATCHLIST_KEY]: next });
    try {
      chrome.runtime
        .sendMessage({ type: "WATCHLIST_UPDATED", watchlist: next })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return next;
  }

  async function clearWatchlist() {
    await chrome.storage.local.set({ [WATCHLIST_KEY]: [] });
    try {
      chrome.runtime
        .sendMessage({ type: "WATCHLIST_UPDATED", watchlist: [] })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return [];
  }

  /** Reorder watchlist by ordered ids (drag-and-drop). */
  async function reorderWatchlist(orderedIds) {
    const list = await getWatchlist();
    if (!Array.isArray(orderedIds) || !orderedIds.length) return list;
    const map = new Map(list.map((x) => [x.id, x]));
    const next = [];
    for (const id of orderedIds) {
      const item = map.get(id);
      if (item) {
        next.push(item);
        map.delete(id);
      }
    }
    for (const item of map.values()) next.push(item);
    await chrome.storage.local.set({ [WATCHLIST_KEY]: next });
    try {
      chrome.runtime
        .sendMessage({ type: "WATCHLIST_UPDATED", watchlist: next })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return next;
  }

  /** Patch one watchlist item by id */
  async function updateWatchlistItem(id, patch) {
    const list = await getWatchlist();
    const next = list.map((x) =>
      x.id === id ? { ...x, ...(patch || {}), id: x.id } : x
    );
    await chrome.storage.local.set({ [WATCHLIST_KEY]: next });
    try {
      chrome.runtime
        .sendMessage({ type: "WATCHLIST_UPDATED", watchlist: next })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return next;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(d = new Date()) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }

  function sanitizeNamePart(s, max = 60) {
    let t = String(s || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") || t.slice(0, max);
    return t || "video";
  }

  /**
   * Generic / unreadable save names that should NOT be forced onto yt-dlp
   * (let extractor use the real video title instead).
   */
  function isGenericSaveName(name) {
    const s = String(name || "")
      .replace(/\.(mp4|webm|mkv|mp3|m4a|ts)$/i, "")
      .trim();
    if (!s || s.length < 2) return true;
    if (/^(영상|동영상|video|media|audio|file|download)$/i.test(s)) return true;
    // Site_id junk: YouTube_xxxx, TikTok_123, X_123, Bilibili_BVxx …
    if (
      /^(YouTube|TikTok|Instagram|Facebook|Bilibili|X|Twitter|YT|TT|IG|FB)([_-][A-Za-z0-9_-]+)?$/i.test(
        s
      )
    ) {
      return true;
    }
    // bare YouTube-style ids only (not product codes like SSIS-001)
    if (
      /^[A-Za-z0-9_-]{11}$/.test(s) &&
      !/[가-힣]/.test(s) &&
      !/\s/.test(s) &&
      !/[A-Za-z]{2,}-\d{2,}/i.test(s)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Human-readable filename base (no extension).
   * Default "legacy": "영상 제목_1080p" — spaces kept so names are readable.
   * Custom templates: {title} {quality} {site} {date} {mode}
   */
  function applyFilenameTemplate(template, ctx = {}) {
    const quality =
      ctx.quality && !/^(best|all|unknown)$/i.test(String(ctx.quality))
        ? String(ctx.quality)
        : "";
    let title = String(ctx.title || "").trim();
    if (isGenericSaveName(title)) title = "";

    const tpl = (template || "legacy").trim();
    // Old readable style (preferred default)
    if (!tpl || /^legacy$/i.test(tpl) || tpl === "{title}_{quality}") {
      // Keep spaces in title for readability (old behavior)
      let base = title
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (base.length > 70) {
        base = base.slice(0, 68).replace(/\s+\S*$/, "") || base.slice(0, 68);
      }
      if (!base) return ""; // signal: let yt-dlp pick real title
      if (quality && !base.includes(quality)) base = `${base}_${quality}`;
      return base;
    }

    const mode =
      ctx.mediaMode === "audio"
        ? "audio"
        : ctx.mediaMode === "video_subs"
          ? "subs"
          : "";
    let name = tpl
      .replace(/\{title\}/gi, sanitizeNamePart(title || "영상", 70))
      .replace(/\{quality\}/gi, quality)
      .replace(/\{site\}/gi, sanitizeNamePart(ctx.site || "", 20))
      .replace(/\{date\}/gi, formatDate())
      .replace(/\{mode\}/gi, mode);
    name = name
      .replace(/[_\s.-]{2,}/g, "_")
      .replace(/^[_\s.-]+|[_\s.-]+$/g, "")
      .replace(/[<>:"/\\|?*]/g, "");
    if (isGenericSaveName(name)) return "";
    return sanitizeNamePart(name || "", 90);
  }

  function downloadRelPath(subfolder, filename) {
    const folder = String(subfolder || "VideoDownloader")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "") || "VideoDownloader";
    const file = String(filename || "video.mp4").replace(/^\/+/, "");
    return `${folder}/${file}`;
  }

  /**
   * Extract http(s) URLs from free text (multi-line paste).
   */
  function parseUrlsFromText(text) {
    const raw = String(text || "");
    const found = [];
    const re = /https?:\/\/[^\s<>"')\]]+/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
      let u = m[0].replace(/[.,;]+$/, "");
      try {
        const parsed = new URL(u);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        found.push(parsed.href);
      } catch {
        /* skip */
      }
    }
    // bare social links without scheme
    for (const line of raw.split(/[\n\r]+/)) {
      const s = line.trim();
      if (!s || /^https?:/i.test(s)) continue;
      if (/^(www\.)?(youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok|instagram\.com|instagr\.am)/i.test(s)) {
        try {
          found.push(new URL("https://" + s).href);
        } catch {
          /* skip */
        }
      }
    }
    // unique preserve order
    const seen = new Set();
    return found.filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  }

  function isPlaylistUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.searchParams.has("list")) return true;
      if (/\/playlist/i.test(u.pathname)) return true;
      if (/youtube\.com\/(channel|c|@)/i.test(u.href) && /videos/i.test(u.pathname)) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function classifyError(msg) {
    const s = String(msg || "");
    if (/도우미|8787|yt-dlp not|start\.command|install_autostart|연결할 수 없/i.test(s)) {
      return {
        code: "helper",
        label: "로컬 도우미 필요",
        hint: "helper/install_autostart.command 를 실행해 주세요",
        actions: ["helper", "retry"]
      };
    }
    if (/login|cookie|로그인|not logged|인증|Instagram 인증/i.test(s)) {
      return {
        code: "login",
        label: "로그인 필요",
        hint: "브라우저에서 해당 사이트에 로그인한 뒤 다시 시도하세요",
        actions: ["login", "retry"]
      };
    }
    if (/403|401|접근 거부|Segment HTTP|CDN이 접근|조각 접근/i.test(s)) {
      return {
        code: "forbidden",
        label: "접근 거부 (403)",
        hint: "페이지에서 영상을 재생한 직후 다시 받아 주세요",
        actions: ["open_page", "retry"]
      };
    }
    if (/DRM|SAMPLE-AES|Widevine|보호된 영상/i.test(s)) {
      return {
        code: "drm",
        label: "보호된 영상",
        hint: "DRM이 걸린 영상은 받을 수 없습니다",
        actions: []
      };
    }
    if (/시간 초과|timeout/i.test(s)) {
      return {
        code: "timeout",
        label: "시간 초과",
        hint: "네트워크를 확인한 뒤 다시 시도하세요",
        actions: ["retry"]
      };
    }
    if (/Unsupported URL|지원하지 않는|게시물 링크가 아니/i.test(s)) {
      return {
        code: "bad_url",
        label: "잘못된 주소",
        hint: "게시물/영상 페이지 주소를 확인해 주세요",
        actions: ["open_page"]
      };
    }
    if (/너무 작|세그먼트 부족|유효한 세그먼트/i.test(s)) {
      return {
        code: "incomplete",
        label: "불완전한 다운로드",
        hint: "재생 후 다시 시도해 주세요",
        actions: ["open_page", "retry"]
      };
    }
    return {
      code: "other",
      label: "다운로드 실패",
      hint: s.slice(0, 100) || "다시 시도해 주세요",
      actions: ["retry", "open_page"]
    };
  }

  function siteFromUrl(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      if (h.includes("youtube") || h === "youtu.be") return "youtube";
      if (h.includes("tiktok")) return "tiktok";
      if (h.includes("instagram") || h.includes("instagr.am")) return "instagram";
      if (h === "x.com" || h.endsWith(".x.com") || h.includes("twitter.com") || h === "t.co") {
        return "x";
      }
      if (
        h.includes("facebook.com") ||
        h.includes("fb.watch") ||
        h === "fb.com" ||
        h.endsWith(".fb.com") ||
        h.includes("fbcdn.net")
      ) {
        return "facebook";
      }
      if (h.includes("bilibili.com") || h === "b23.tv" || h.includes("bilibili.tv")) {
        return "bilibili";
      }
      return h.split(".")[0] || "";
    } catch {
      return "";
    }
  }

  /**
   * Stable key for "same video" checks (dedupe).
   * Strips tracking params; keeps v= / reel id / tiktok video id.
   */
  function normalizeUrlKey(url) {
    if (!url || typeof url !== "string") return "";
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      const path = (u.pathname || "/").replace(/\/+$/, "") || "/";

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
        if (list) return `yt:list:${list}`;
        return `yt:${path}`;
      }
      if (host.includes("tiktok")) {
        const m = path.match(/\/@[^/]+\/video\/(\d+)/i);
        if (m) return `tt:${m[1]}`;
        const t = path.match(/\/t\/([^/?#]+)/i);
        if (t) return `tt:t:${t[1]}`;
        return `tt:${path}`;
      }
      if (host.includes("instagram") || host.includes("instagr.am")) {
        const m = path.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
        if (m) return `ig:${m[1]}:${m[2]}`;
        return `ig:${path}`;
      }
      if (
        host === "x.com" ||
        host.endsWith(".x.com") ||
        host.includes("twitter.com") ||
        host === "t.co"
      ) {
        const m = path.match(/\/status\/(\d+)/i);
        if (m) return `x:${m[1]}`;
        return `x:${path}`;
      }
      if (
        host.includes("facebook.com") ||
        host.includes("fb.watch") ||
        host === "fb.com" ||
        host.endsWith(".fb.com")
      ) {
        const v = u.searchParams.get("v");
        if (v) return `fb:v:${v}`;
        const m = path.match(/\/(videos|reel|reels|watch)\/([^/?#]+)/i);
        if (m) return `fb:${m[1]}:${m[2]}`;
        return `fb:${path}`;
      }
      if (host.includes("bilibili.com") || host === "b23.tv" || host.includes("bilibili.tv")) {
        const m = path.match(/\/video\/(BV[\w]+|av\d+)/i);
        if (m) return `bili:${m[1]}`;
        return `bili:${path}`;
      }
      return `${host}${path}`.toLowerCase();
    } catch {
      return String(url).trim().toLowerCase().slice(0, 200);
    }
  }

  /**
   * Preferred quality id for a page URL.
   * Default product behavior: always highest ("best").
   * Per-site map still honored if user set something other than best.
   */
  function qualityForSite(settings, url) {
    const map = (settings && settings.qualityBySite) || DEFAULT_SETTINGS.qualityBySite;
    const site = siteFromUrl(url);
    const q = (site && map[site]) || map.default || "best";
    return String(q || "best") || "best";
  }

  /**
   * Find a successful history entry for the same video URL.
   * @returns {object|null}
   */
  async function findDuplicateDone(url) {
    const key = normalizeUrlKey(url);
    if (!key) return null;
    const list = await getHistory();
    return (
      list.find(
        (h) =>
          h &&
          h.status === "done" &&
          normalizeUrlKey(h.pageUrl || h.url || "") === key
      ) || null
    );
  }

  /** Failed history items that still have a retryable URL */
  async function getFailedRetryable() {
    const list = await getHistory();
    const seen = new Set();
    const out = [];
    for (const h of list) {
      if (!h || h.status !== "error") continue;
      const u = h.pageUrl || h.url || "";
      if (!/^https?:/i.test(u)) continue;
      const key = normalizeUrlKey(u);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
    return out;
  }

  function mediaModeLabel(mode) {
    if (mode === "audio") return "오디오";
    if (mode === "video_subs") return "영상+자막";
    return "영상";
  }

  return {
    DEFAULT_SETTINGS,
    HISTORY_KEY,
    SETTINGS_KEY,
    WATCHLIST_KEY,
    getSettings,
    setSettings,
    getHistory,
    appendHistory,
    clearHistory,
    getRecentDone,
    getWatchlist,
    addWatchlist,
    removeWatchlist,
    clearWatchlist,
    reorderWatchlist,
    updateWatchlistItem,
    applyFilenameTemplate,
    isGenericSaveName,
    downloadRelPath,
    parseUrlsFromText,
    isPlaylistUrl,
    classifyError,
    siteFromUrl,
    normalizeUrlKey,
    qualityForSite,
    findDuplicateDone,
    getFailedRetryable,
    mediaModeLabel,
    sanitizeNamePart,
    formatDate
  };
})();

// CommonJS-ish global for both environments
if (typeof globalThis !== "undefined") {
  globalThis.UVD = UVD;
}
