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
    compactUi: true,
    /**
     * UI density: full | compact | ultra
     * (compactUi kept for older builds; prefer uiDensity)
     */
    uiDensity: "compact",
    /** Popup width: narrow 320 · normal 380 · wide 440 */
    popupWidth: "normal",
    /** Show count badge on extension icon while downloading */
    showBadge: true,
    /** Auto-suggest series complete after a download */
    seriesComplete: true,
    /** Max next episodes to queue in series complete mode */
    seriesCompleteCount: 5
  };

  const HISTORY_KEY = "uvdHistory";
  const SETTINGS_KEY = "uvdSettings";
  const WATCHLIST_KEY = "uvdWatchlist";
  const SITE_PACKS_KEY = "uvdSitePacks";

  /**
   * Built-in site packs — adaptive download hints per host.
   * Custom packs merge on top via storage.
   */
  const BUILTIN_SITE_PACKS = [
    {
      id: "jav-hls",
      name: "JAV HLS (123av/missav 계열)",
      enabled: true,
      hosts: [
        "123av.com",
        "missav.com",
        "missav.ws",
        "jable.tv",
        "javplayer",
        "netflav.com",
        "supjav.com",
        "thisav.com",
        "spankbang.com",
        "hanime.tv",
        "njav.tv"
      ],
      rules: {
        tryPageFirst: true,
        preferPageHls: true,
        needPlayFirst: true,
        seriesMode: "product_code",
        note: "재생 후 스트림 캡처 · 403 시 페이지 우선"
      }
    },
    {
      id: "youtube",
      name: "YouTube",
      enabled: true,
      hosts: ["youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"],
      rules: {
        needYtDlp: true,
        seriesMode: "playlist",
        note: "재생목록·시리즈는 목록 받기 권장"
      }
    },
    {
      id: "social",
      name: "소셜 (TT/IG/X/FB)",
      enabled: true,
      hosts: [
        "tiktok.com",
        "instagram.com",
        "instagr.am",
        "x.com",
        "twitter.com",
        "facebook.com",
        "fb.watch",
        "fb.com"
      ],
      rules: {
        needYtDlp: true,
        needCookies: true,
        note: "로그인 쿠키 권장"
      }
    },
    {
      id: "bilibili",
      name: "Bilibili",
      enabled: true,
      hosts: ["bilibili.com", "bilibili.tv", "b23.tv"],
      rules: {
        needYtDlp: true,
        seriesMode: "playlist",
        note: "yt-dlp 경로"
      }
    }
  ];

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
    next.showBadge = next.showBadge !== false;
    next.seriesComplete = next.seriesComplete !== false;
    next.seriesCompleteCount = Math.min(
      20,
      Math.max(1, Number(next.seriesCompleteCount) || 5)
    );
    if (!["full", "compact", "ultra"].includes(String(next.uiDensity || ""))) {
      next.uiDensity = next.compactUi === false ? "full" : "compact";
    }
    if (!["narrow", "normal", "wide"].includes(String(next.popupWidth || ""))) {
      next.popupWidth = "normal";
    }
    // Keep boolean in sync with density
    next.compactUi = next.uiDensity !== "full";
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

  /**
   * Extract series / product code from a title for library grouping & complete mode.
   * e.g. "SSIS-001 …" → { key: "SSIS-001", prefix: "SSIS", num: 1, pad: 3 }
   */
  function extractSeriesInfo(title) {
    const t = String(title || "");
    // JAV-style: ABC-123, ABCD-001, abc_012
    let m = t.match(/\b([A-Za-z]{2,8})[-_ ]?(\d{2,5})\b/);
    if (m && !/^(http|https|www|mp4|HD|FHD|4K)$/i.test(m[1])) {
      const prefix = m[1].toUpperCase();
      const num = parseInt(m[2], 10);
      const pad = m[2].length;
      if (Number.isFinite(num) && num > 0 && num < 100000) {
        return {
          key: `${prefix}-${String(num).padStart(pad, "0")}`,
          prefix,
          num,
          pad,
          kind: "product_code"
        };
      }
    }
    // Season episode: S01E02
    m = t.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (m) {
      const season = parseInt(m[1], 10);
      const ep = parseInt(m[2], 10);
      return {
        key: `S${String(season).padStart(2, "0")}E${String(ep).padStart(2, "0")}`,
        prefix: `S${String(season).padStart(2, "0")}E`,
        num: ep,
        pad: Math.max(2, String(ep).length),
        kind: "season_ep",
        season
      };
    }
    // Episode N
    m = t.match(/(?:ep|episode|제)\s*(\d{1,4})\b/i);
    if (m) {
      const num = parseInt(m[1], 10);
      return {
        key: `EP-${num}`,
        prefix: "EP",
        num,
        pad: String(m[1]).length,
        kind: "episode"
      };
    }
    return null;
  }

  function nextSeriesKeys(info, count = 5) {
    if (!info || !info.prefix || !Number.isFinite(info.num)) return [];
    const out = [];
    for (let i = 1; i <= count; i++) {
      const n = info.num + i;
      if (info.kind === "season_ep") {
        out.push({
          key: `S${String(info.season).padStart(2, "0")}E${String(n).padStart(info.pad, "0")}`,
          label: `S${String(info.season).padStart(2, "0")}E${String(n).padStart(info.pad, "0")}`,
          num: n
        });
      } else if (info.kind === "episode") {
        out.push({
          key: `EP-${n}`,
          label: `Episode ${n}`,
          num: n
        });
      } else {
        out.push({
          key: `${info.prefix}-${String(n).padStart(info.pad, "0")}`,
          label: `${info.prefix}-${String(n).padStart(info.pad, "0")}`,
          num: n
        });
      }
    }
    return out;
  }

  /**
   * Highest product-code number already in history for a prefix (e.g. SSIS → 42).
   * Used for "continue series from library".
   */
  function maxSeriesNumInHistory(historyList, prefix) {
    const p = String(prefix || "").toUpperCase();
    if (!p) return null;
    let max = null;
    let pad = 3;
    let kind = "product_code";
    let season = null;
    for (const h of historyList || []) {
      if (!h || h.status !== "done") continue;
      const info =
        extractSeriesInfo(h.title || "") ||
        (h.seriesKey ? extractSeriesInfo(h.seriesKey) : null);
      if (!info) continue;
      if (String(info.prefix || "").toUpperCase() !== p) continue;
      if (info.kind === "season_ep") {
        if (season == null) season = info.season;
        if (info.season !== season) continue;
      }
      if (max == null || info.num > max) {
        max = info.num;
        pad = info.pad || pad;
        kind = info.kind || kind;
        if (info.season != null) season = info.season;
      }
    }
    if (max == null) return null;
    return { prefix: p, num: max, pad, kind, season };
  }

  /** Auto tags from title/site for library */
  function autoTags(title, site, pageUrl) {
    const tags = new Set();
    if (site) tags.add(String(site));
    const info = extractSeriesInfo(title);
    if (info) {
      tags.add("series");
      tags.add(info.prefix);
      tags.add(info.key);
    }
    if (/playlist|재생목록/i.test(title || "") || isPlaylistUrl(pageUrl || "")) {
      tags.add("playlist");
    }
    if (/\b(4K|2160p|UHD)\b/i.test(title || "")) tags.add("4K");
    if (/\b(FHD|1080p)\b/i.test(title || "")) tags.add("1080p");
    return [...tags].slice(0, 12);
  }

  async function appendHistory(entry) {
    const settings = await getSettings();
    const list = await getHistory();
    const title = entry.title || entry.filename || "영상";
    const pageUrl = entry.pageUrl || entry.url || "";
    const site = entry.site || siteFromUrl(pageUrl) || "";
    const series = extractSeriesInfo(title);
    const mergedTags = [
      ...new Set(
        [
          ...autoTags(title, site, pageUrl),
          ...(Array.isArray(entry.tags) ? entry.tags : []),
          entry.seriesId || "",
          entry.seriesKey || series?.key || ""
        ]
          .filter(Boolean)
          .map(String)
      )
    ].slice(0, 16);
    const item = {
      id: entry.id || `h_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      filename: entry.filename || "",
      url: entry.url || pageUrl,
      pageUrl,
      path: entry.path || "",
      downloadId: entry.downloadId ?? null,
      status: entry.status || "done", // done | error
      error: entry.error || null,
      errorCode: entry.errorCode || classifyError(entry.error || "").code,
      size: entry.size || 0,
      method: entry.method || "",
      quality: entry.quality || "",
      mediaMode: entry.mediaMode || "video",
      site,
      thumbnail: entry.thumbnail || "",
      tags: mergedTags,
      seriesKey: series?.key || entry.seriesKey || "",
      seriesPrefix: series?.prefix || entry.seriesPrefix || "",
      seriesId: entry.seriesId || "",
      seriesIndex: entry.seriesIndex || 0,
      note: entry.note || "",
      at: entry.at || Date.now()
    };
    // Library: keep more successful items (up to 200)
    const cap = Math.max(settings.maxHistory || 50, 200);
    const next = [item, ...list.filter((x) => x.id !== item.id)].slice(0, cap);
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

  async function updateHistoryItem(id, patch) {
    const list = await getHistory();
    const next = list.map((x) =>
      x.id === id ? { ...x, ...(patch || {}), id: x.id } : x
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

  /**
   * Library query: filter history (default: done only).
   * @param {{ q?: string, site?: string, series?: string, tag?: string, status?: string }} opts
   */
  async function queryLibrary(opts = {}) {
    const list = await getHistory();
    const q = String(opts.q || "")
      .trim()
      .toLowerCase();
    const site = String(opts.site || "").trim().toLowerCase();
    const series = String(opts.series || "").trim().toUpperCase();
    const tag = String(opts.tag || "").trim().toLowerCase();
    const status = opts.status || "done";
    return list.filter((h) => {
      if (!h) return false;
      if (status !== "all" && h.status !== status) return false;
      if (site && String(h.site || "").toLowerCase() !== site) return false;
      if (series) {
        const sk = String(h.seriesKey || h.seriesPrefix || "").toUpperCase();
        if (!sk.includes(series) && !String(h.title || "").toUpperCase().includes(series)) {
          return false;
        }
      }
      if (tag) {
        const tags = (h.tags || []).map((t) => String(t).toLowerCase());
        if (!tags.includes(tag) && !String(h.title || "").toLowerCase().includes(tag)) {
          return false;
        }
      }
      if (q) {
        const blob = [
          h.title,
          h.filename,
          h.site,
          h.seriesKey,
          h.note,
          ...(h.tags || [])
        ]
          .join(" ")
          .toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }

  async function getSitePacks() {
    try {
      const data = await chrome.storage.local.get(SITE_PACKS_KEY);
      const custom = Array.isArray(data[SITE_PACKS_KEY]) ? data[SITE_PACKS_KEY] : [];
      // Merge: custom overrides same id, then builtins not overridden
      const byId = new Map();
      for (const p of BUILTIN_SITE_PACKS) byId.set(p.id, { ...p, builtin: true });
      for (const p of custom) {
        if (p && p.id) byId.set(p.id, { ...byId.get(p.id), ...p, builtin: !!byId.get(p.id)?.builtin });
      }
      return [...byId.values()];
    } catch {
      return BUILTIN_SITE_PACKS.map((p) => ({ ...p, builtin: true }));
    }
  }

  async function setSitePacks(packs) {
    const custom = (Array.isArray(packs) ? packs : []).filter((p) => p && p.id && !p.builtin);
    // Also store enabled overrides for builtins
    const overrides = (Array.isArray(packs) ? packs : [])
      .filter((p) => p && p.id)
      .map((p) => ({
        id: p.id,
        enabled: p.enabled !== false,
        hosts: p.hosts,
        rules: p.rules,
        name: p.name
      }));
    await chrome.storage.local.set({ [SITE_PACKS_KEY]: overrides });
    return getSitePacks();
  }

  /** Match first enabled pack for a URL */
  async function getSitePackForUrl(url) {
    const packs = await getSitePacks();
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return null;
    }
    for (const p of packs) {
      if (p.enabled === false) continue;
      const hosts = p.hosts || [];
      if (hosts.some((h) => host === h || host.endsWith("." + h) || host.includes(h))) {
        return p;
      }
    }
    return null;
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
    const series =
      entry.seriesKey || extractSeriesInfo(entry.title || "")?.key || "";
    const seriesId = entry.seriesId || (series ? `series:code:${String(series).split("-")[0]}` : "");
    const tags = [
      ...new Set(
        [
          ...(Array.isArray(entry.tags) ? entry.tags : []),
          seriesId,
          series,
          "series"
        ]
          .filter(Boolean)
          .map(String)
      )
    ].slice(0, 16);
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
      tags,
      seriesId: seriesId || "",
      seriesKey: series || entry.seriesKey || "",
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

  /**
   * Pure playlist page (not a single watch video with &list=).
   * e.g. youtube.com/playlist?list=…  or  music.youtube.com/playlist?list=…
   */
  function isPlaylistOnlyUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./i, "").toLowerCase();
      const path = u.pathname || "";
      if (/youtube\.com|youtu\.be|music\.youtube/i.test(h)) {
        if (/\/playlist/i.test(path) && u.searchParams.has("list")) return true;
        // list without v= on non-watch pages
        if (u.searchParams.has("list") && !u.searchParams.get("v") && !/\/watch/i.test(path)) {
          return true;
        }
      }
      // Bilibili multi-part is not handled here
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Single video that is part of a playlist (watch?v=…&list=…) */
  function isWatchInPlaylistUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return !!(u.searchParams.get("v") && u.searchParams.get("list"));
    } catch {
      return false;
    }
  }

  function classifyError(msg) {
    const s = String(msg || "");
    if (/도우미|8787|yt-dlp not|start\.command|install_autostart|연결할 수 없|헬퍼/i.test(s)) {
      return {
        code: "helper",
        label: "로컬 도우미 필요",
        hint: "아래 「도우미 실행」으로 안내·다시 확인하세요",
        actions: ["helper_start", "helper", "retry"]
      };
    }
    if (/login|cookie|로그인|not logged|인증|Instagram 인증/i.test(s)) {
      return {
        code: "login",
        label: "로그인 필요",
        hint: "사이트에 로그인한 뒤 「다시 받기」를 누르세요",
        actions: ["login", "retry"]
      };
    }
    if (/403|401|접근 거부|Segment HTTP|CDN이 접근|조각 접근/i.test(s)) {
      return {
        code: "forbidden",
        label: "접근 거부 (403)",
        hint: "페이지를 열어 재생한 직후 다시 받으세요",
        actions: ["play_retry", "open_page", "retry"]
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
    if (/Unsupported URL|지원하지 않는|게시물 링크가 아니|감지된 영상이 없/i.test(s)) {
      return {
        code: "bad_url",
        label: "주소·감지 문제",
        hint: "영상 페이지를 연 뒤 재생하고 다시 받아 주세요",
        actions: ["play_retry", "open_page", "retry"]
      };
    }
    if (/너무 작|세그먼트 부족|유효한 세그먼트/i.test(s)) {
      return {
        code: "incomplete",
        label: "불완전한 다운로드",
        hint: "재생 후 다시 시도해 주세요",
        actions: ["play_retry", "open_page", "retry"]
      };
    }
    if (/PAUSED|일시정지/i.test(s)) {
      return {
        code: "paused",
        label: "일시정지",
        hint: "다시 시작으로 이어서 받을 수 있습니다",
        actions: ["resume"]
      };
    }
    if (/CANCELLED|취소/i.test(s)) {
      return {
        code: "cancelled",
        label: "취소됨",
        hint: "원하면 다시 받기 하세요",
        actions: ["retry"]
      };
    }
    return {
      code: "other",
      label: "다운로드 실패",
      hint: s.slice(0, 100) || "다시 시도해 주세요",
      actions: ["retry", "open_page", "helper"]
    };
  }

  function formatSpeed(bps) {
    if (bps == null || !Number.isFinite(Number(bps)) || Number(bps) <= 0) return "";
    const n = Number(bps);
    if (n < 1024) return `${Math.round(n)} B/s`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB/s`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
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

  /**
   * Whether a history row matches a series preview entry (url / yt id / product key).
   */
  function historyMatchesEntry(h, entry) {
    if (!h || !entry) return false;
    const eUrl = entry.url || entry.pageUrl || "";
    const eKey = String(entry.key || entry.id || entry.seriesKey || "").toUpperCase();
    const hUrl = h.pageUrl || h.url || "";
    if (eUrl && hUrl) {
      const a = normalizeUrlKey(eUrl);
      const b = normalizeUrlKey(hUrl);
      if (a && b && a === b) return true;
    }
    // YouTube id match
    const idFrom = (u) => {
      try {
        const x = new URL(u);
        if (/youtu\.be/i.test(x.hostname)) {
          return x.pathname.replace(/^\//, "").split("/")[0] || "";
        }
        return x.searchParams.get("v") || "";
      } catch {
        return "";
      }
    };
    const eid = String(entry.id || entry.key || idFrom(eUrl) || "");
    const hid = idFrom(hUrl);
    if (eid && hid && eid === hid && /^[\w-]{11}$/.test(eid)) return true;
    // Product / series key
    if (eKey && (String(h.seriesKey || "").toUpperCase() === eKey ||
        String(h.title || "").toUpperCase().includes(eKey))) {
      return true;
    }
    return false;
  }

  /** Mark series preview rows that already exist as done in history. */
  function annotateSeriesDownloaded(entries, historyList) {
    const list = Array.isArray(historyList) ? historyList : [];
    const done = list.filter((h) => h && h.status === "done");
    return (entries || []).map((e) => {
      const hit = done.find((h) => historyMatchesEntry(h, e));
      if (hit) {
        return {
          ...e,
          downloaded: true,
          selected: false,
          doneTitle: hit.title || e.title
        };
      }
      return { ...e, downloaded: !!e.downloaded };
    });
  }

  /** Failed history items that still have a retryable URL */
  async function getFailedRetryable(opts = {}) {
    const list = await getHistory();
    const seriesId = String(opts.seriesId || "").trim();
    const seen = new Set();
    const out = [];
    for (const h of list) {
      if (!h || h.status !== "error") continue;
      const u = h.pageUrl || h.url || "";
      if (!/^https?:/i.test(u)) continue;
      if (seriesId) {
        const tags = Array.isArray(h.tags) ? h.tags : [];
        const sid = String(h.seriesId || "");
        const ok =
          sid === seriesId ||
          tags.includes(seriesId) ||
          tags.some((t) => String(t) === seriesId || String(t).startsWith(seriesId));
        if (!ok) continue;
      }
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
    SITE_PACKS_KEY,
    BUILTIN_SITE_PACKS,
    getSettings,
    setSettings,
    getHistory,
    appendHistory,
    updateHistoryItem,
    clearHistory,
    getRecentDone,
    queryLibrary,
    extractSeriesInfo,
    nextSeriesKeys,
    maxSeriesNumInHistory,
    autoTags,
    getSitePacks,
    setSitePacks,
    getSitePackForUrl,
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
    isPlaylistOnlyUrl,
    isWatchInPlaylistUrl,
    classifyError,
    formatSpeed,
    siteFromUrl,
    normalizeUrlKey,
    qualityForSite,
    findDuplicateDone,
    getFailedRetryable,
    historyMatchesEntry,
    annotateSeriesDownloaded,
    mediaModeLabel,
    sanitizeNamePart,
    formatDate
  };
})();

// CommonJS-ish global for both environments
if (typeof globalThis !== "undefined") {
  globalThis.UVD = UVD;
}
