/**
 * Shared friendly filename helpers (service worker via importScripts).
 */
const Naming = (() => {
  function sanitize(name, max = 80) {
    return String(name || "")
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[\u{2600}-\u{27BF}]/gu, "")
      .replace(/[♥❤💕💗💖💘💙💚💛💜🖤🤍🤎❣️⭐✨]/g, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, max);
  }

  /** Strip common site suffixes from document titles */
  function cleanPageTitle(title) {
    if (!title) return "";
    let t = String(title).trim();
    // HTML entities
    t = t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    // Remove site brand suffixes (adult tubes included)
    t = t.replace(
      /\s*[\-|–—|·•:]\s*(YouTube|Vimeo|Twitter|X|Instagram|Facebook|TikTok|Naver|다음|카카오|Twitch|Netflix|Watcha|TVING|웨이브|Disney\+|Prime Video|Bilibili|nico(?:nico)?|SOOP|Chzzk|아프리카TV|123AV|123av\.com|123av|JavLibrary|JavDB|MissAV|Jable|Avgle|ThisAV|Netflav|Supjav).*$/i,
      ""
    );
    t = t.replace(/\s*[\-|–—|·•]\s*Watch\s*(Free|Online|Full).*$/i, "");
    t = t.replace(/\s*[\-|–—|·•]\s*Free\s*Porn.*$/i, "");
    // Generic trailing site brand
    t = t.replace(/\s*[\-|–—|·•]\s*[^|\-–—·•]{1,40}$/u, (m, _o, s) => {
      if (s.length > 22 && m.length < 32) return "";
      return m;
    });
    // Normalize product code spacing: "ssis-001title" → keep as-is if already fine
    t = t.replace(/^\[?([A-Za-z]{2,12}-\d{2,5})\]?\s*/i, (_, code) => code.toUpperCase() + " ");
    return sanitize(t, 80);
  }

  function isUglyBase(base) {
    if (!base || base.length < 2) return true;
    const b = String(base).trim();

    // Player / CDN hostnames (javplayer.cc etc.) — not a video name
    if (/javplayer|surrit|cloudfront|akamai|fastly|cloudflare/i.test(b)) return true;
    if (/^(www\.)?[a-z0-9-]+\.(com|cc|net|tv|io|me|app|xyz|co|to|site)$/i.test(b)) {
      return true;
    }
    if (/\.(com|cc|net|tv|io|me)\b/i.test(b) && b.length < 32 && !/[가-힣]/.test(b)) {
      return true;
    }

    // Resolution-style CDN names: 2_480x270, video_1280x720
    if (/\d+x\d+/i.test(b)) return true;
    if (/^\d+[_-]\d+/i.test(b)) return true;

    // UUIDs, long hashes
    if (/^[a-f0-9]{16,}$/i.test(b)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(b)) return true;

    if (
      /^(chunk|segment|seg|init|playlist|index|master|manifest|video|media|stream|audio|track|file|download|source|src|clip|tmp|temp|player|embed)[-_]?\d*$/i.test(
        b
      )
    ) {
      return true;
    }

    if (/^\d{1,8}$/.test(b)) return true;
    if (/^[a-z]{1,3}\d{2,}$/i.test(b) && b.length < 12) return true;

    if (
      /^[A-Za-z0-9_-]{20,}$/.test(b) &&
      !/[가-힣]/.test(b) &&
      !/[a-z]{5,}/i.test(b.replace(/[_-]/g, " "))
    ) {
      return true;
    }

    if (/^(4k|2160p|1440p|1080p|720p|480p|360p|240p|hd|sd|fhd|uhd)$/i.test(b)) return true;
    if (/^동영상$|^영상$|^video$|^media$|^audio$/i.test(b)) return true;

    return false;
  }

  function extFromUrl(url, fallback = "mp4") {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const m = path.match(/\.([a-z0-9]{2,5})(?:$|[?#])/);
      if (!m) return fallback;
      const e = m[1];
      if (e === "m3u8" || e === "mpd") return fallback;
      if (["mp4", "webm", "mkv", "mov", "m4v", "ts", "mp3", "m4a", "aac", "wav", "ogg", "ogv"].includes(e)) {
        return e;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  function baseFromUrl(url) {
    try {
      let name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      name = name.split("?")[0];
      if (!name || name === "/") return "";
      return name.replace(/\.[a-z0-9]{2,5}$/i, "");
    } catch {
      return "";
    }
  }

  /**
   * Pick the most descriptive title among candidates.
   * Prefer longer human titles over short codes/hosts.
   */
  function pickBestTitle(...candidates) {
    const cleaned = candidates
      .map((c) => cleanPageTitle(c || ""))
      .filter((c) => c && c.length >= 2 && !isUglyBase(c));
    if (!cleaned.length) return "";
    // Prefer title that includes a product code + text
    const withCode = cleaned.find((c) => /[A-Z]{2,12}-\d{2,5}/i.test(c) && c.length > 12);
    if (withCode) return withCode;
    // Else longest descriptive
    return cleaned.sort((a, b) => b.length - a.length)[0];
  }

  /**
   * Easy filename people can recognize:
   * "SSIS-001 이복여동생 이야기_720p.mp4"
   */
  function buildFilename(opts = {}) {
    const {
      title = "",
      pageTitle = "",
      quality = "",
      type = "video",
      host = "",
      existing = "",
      index = 0
    } = opts;

    const isAudio = type === "audio";
    const ext = isAudio ? "mp3" : "mp4";

    let base = pickBestTitle(title, pageTitle, existing?.replace(/\.[a-z0-9]{2,5}$/i, ""));

    if (!base) {
      base = isAudio ? "오디오" : "영상";
    }

    // Keep enough of the title to know what it is (not tiny)
    if (base.length > 55) {
      base = base.slice(0, 53).replace(/\s+\S*$/, "") || base.slice(0, 53);
    }

    let q = quality && quality !== "unknown" ? String(quality).replace(/[()]/g, "") : "";
    if (q && base.includes(q)) q = "";

    let body = q ? `${base}_${q}` : base;
    if (index > 0) body = `${body}_${index + 1}`;

    let full = `${body}.${ext}`;
    full = full
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (full.length > 100) {
      full = `${body.slice(0, 90).trim()}.${ext}`;
    }
    return full;
  }

  function displayTitle(opts = {}) {
    const { title = "", pageTitle = "", type = "video" } = opts;
    let base = pickBestTitle(title, pageTitle);
    if (!base) base = type === "audio" ? "오디오" : "영상";
    if (base.length > 64) base = base.slice(0, 62) + "…";
    return base;
  }

  /**
   * Detect junk / ad / preview media that should not appear in the list.
   */
  function isJunkMedia(item = {}) {
    const url = item.url || "";
    if (!url) return true;

    const w = item.width || 0;
    const h = item.height || 0;
    const dur = item.duration;
    const size = item.size || 0;
    const path = (() => {
      try {
        return new URL(url).pathname + new URL(url).search;
      } catch {
        return url;
      }
    })();

    // Segments alone
    if (item.type === "segment") return true;

    // DASH not fully supported
    if (/\.mpd(\?|$|#)/i.test(url)) return true;

    // Known ad / tracker hosts
    if (
      /doubleclick|googlesyndication|googlevideo\.com\/videoplayback\?.*&oad|adsystem|adnxs|adservice|exoclick|trafficjunky|tsyndicate|popads|adserver|ad\.|\/ads\/|\/ad[s]?\//i.test(
        url
      )
    ) {
      return true;
    }

    // CDN ad-style filenames: 2_480x270.mp4, video_300x250.webm
    if (/\d+_\d{2,4}x\d{2,4}/i.test(path)) return true;
    if (/\/\d{2,4}x\d{2,4}\.(mp4|webm)/i.test(path)) return true;

    // Common ad/preview path tokens
    if (
      /\/(preroll|midroll|postroll|promo|banner|splash|teaser|preview|trailer[_-]?ad|advert|vast|vmap|ima)[\/._-]/i.test(
        path
      )
    ) {
      return true;
    }

    // Tiny resolution = almost always ad overlay / bumper
    // 480x270 is classic ad unit on adult tubes
    if (w > 0 && h > 0) {
      const pixels = w * h;
      if (pixels > 0 && pixels <= 480 * 280) return true;
      if (h > 0 && h <= 272 && w <= 500) return true;
    }

    // Zero / tiny duration on progressive files (not live HLS)
    if (!item.isHls && item.type !== "stream") {
      if (dur === 0) return true;
      if (typeof dur === "number" && dur > 0 && dur < 8) return true;
      if (size > 0 && size < 250_000) return true;
    }
    // Short clips even when typed as stream without playlist URL
    if (item.type === "video" && typeof dur === "number" && dur > 0 && dur < 15 && (w * h || 0) < 900 * 500) {
      return true;
    }

    // HLS variant leaves (keep master only) — parentMaster set
    if (item.source === "hls-variant") return true;

    // DRM methods
    const method = (item.encryptionMethod || "").toUpperCase();
    if (method && method !== "NONE" && method !== "AES-128") return true;

    return false;
  }

  /** Score for ranking main content higher */
  function mediaScore(item = {}) {
    let s = 0;
    if (item.type === "stream" || item.isHls) s += 120;
    if (item.type === "video") s += 100;
    if (item.type === "audio") s += 40;
    if (item.source === "page") s += 25;
    if (item.variants?.length) s += 40;
    if (item.segmentCount) s += Math.min(item.segmentCount, 30);
    if (item.size) s += Math.min(item.size / 1e6, 80);
    if (item.width && item.height) s += (item.width * item.height) / 80_000;
    if (item.duration && item.duration > 60) s += Math.min(item.duration / 10, 40);
    if (item.thumbnail) s += 5;
    // Prefer page-titled items
    if (item.title && !isUglyBase(item.title)) s += 15;
    if (item.pageTitle && !isUglyBase(item.pageTitle)) s += 10;
    return s;
  }

  return {
    sanitize,
    cleanPageTitle,
    isUglyBase,
    extFromUrl,
    buildFilename,
    displayTitle,
    isJunkMedia,
    mediaScore
  };
})();
