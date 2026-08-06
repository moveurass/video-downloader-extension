/**
 * Shared helpers for popup + service worker (no DOM).
 * Loaded via importScripts in SW and <script> in popup.
 */
const UVD = (() => {
  const DEFAULT_SETTINGS = {
    subfolder: "VideoDownloader",
    filenameTemplate: "{title}_{quality}",
    mediaMode: "video", // video | audio | video_subs
    maxHistory: 50,
    /** Show OS notification when a download finishes (default on) */
    notifyOnComplete: true,
    /** Opt-in: watch clipboard for YT/TT/IG links while popup is open */
    clipboardWatch: false
  };

  const HISTORY_KEY = "uvdHistory";
  const SETTINGS_KEY = "uvdSettings";

  function mergeSettings(raw) {
    return { ...DEFAULT_SETTINGS, ...(raw || {}) };
  }

  async function getSettings() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      return mergeSettings(data[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
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
    next.filenameTemplate = String(next.filenameTemplate || "{title}_{quality}").slice(0, 80);
    if (!["video", "audio", "video_subs"].includes(next.mediaMode)) {
      next.mediaMode = "video";
    }
    next.maxHistory = Math.min(100, Math.max(10, Number(next.maxHistory) || 50));
    next.notifyOnComplete = next.notifyOnComplete !== false;
    next.clipboardWatch = !!next.clipboardWatch;
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
   * Apply filename template. Placeholders: {title} {quality} {site} {date} {mode}
   * Extension is NOT included in template — caller adds .mp4/.mp3
   */
  function applyFilenameTemplate(template, ctx = {}) {
    const tpl = template || DEFAULT_SETTINGS.filenameTemplate;
    const quality =
      ctx.quality && !/^(best|all|unknown)$/i.test(ctx.quality) ? ctx.quality : "";
    const mode =
      ctx.mediaMode === "audio"
        ? "audio"
        : ctx.mediaMode === "video_subs"
          ? "subs"
          : "";
    let name = tpl
      .replace(/\{title\}/gi, sanitizeNamePart(ctx.title || "영상", 52))
      .replace(/\{quality\}/gi, quality)
      .replace(/\{site\}/gi, sanitizeNamePart(ctx.site || "", 20))
      .replace(/\{date\}/gi, formatDate())
      .replace(/\{mode\}/gi, mode);
    // collapse empty underscore/space leftovers
    name = name
      .replace(/[_\s.-]{2,}/g, "_")
      .replace(/^[_\s.-]+|[_\s.-]+$/g, "")
      .replace(/[<>:"/\\|?*]/g, "");
    return sanitizeNamePart(name || "video", 90);
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
      return h.split(".")[0] || "";
    } catch {
      return "";
    }
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
    getSettings,
    setSettings,
    getHistory,
    appendHistory,
    clearHistory,
    applyFilenameTemplate,
    downloadRelPath,
    parseUrlsFromText,
    isPlaylistUrl,
    classifyError,
    siteFromUrl,
    mediaModeLabel,
    sanitizeNamePart,
    formatDate
  };
})();

// CommonJS-ish global for both environments
if (typeof globalThis !== "undefined") {
  globalThis.UVD = UVD;
}
