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

  function isBadCodePrefix(p) {
    return /^(http|https|www|mp4|HD|FHD|4K|AVC|HEVC|dm|cdn|img|www\d)$/i.test(
      p || ""
    );
  }

  /**
   * Match product code in a single path/token.
   * Prefer hyphenated "SNOS-309". Reject site folders like "dm14".
   */
  function matchCodeToken(token) {
    const seg = String(token || "").trim();
    if (!seg) return "";
    // Hyphen / underscore form: SNOS-309, sone_791
    let m = seg.match(/^([A-Za-z]{2,12})[-_](\d{2,5})(?:[a-z])?$/i);
    if (m && !isBadCodePrefix(m[1])) {
      return `${m[1].toUpperCase()}-${m[2]}`;
    }
    // Glued only when letters are longer (SSIS001) — not dm14
    m = seg.match(/^([A-Za-z]{3,12})(\d{3,5})(?:[a-z])?$/i);
    if (m && !isBadCodePrefix(m[1])) {
      return `${m[1].toUpperCase()}-${m[2]}`;
    }
    return "";
  }

  /** Pull JAV-style product code if present */
  function extractProductCode(text) {
    const s = String(text || "");
    // Prefer path segment style: /snos-309/ at end of URL path
    try {
      if (/^https?:\/\//i.test(s)) {
        const u = new URL(s);
        const segs = u.pathname.split("/").filter(Boolean);
        for (let i = segs.length - 1; i >= 0; i--) {
          const code = matchCodeToken(decodeURIComponent(segs[i]));
          if (code) return code;
        }
        for (const k of ["v", "id", "code", "video", "no"]) {
          const val = u.searchParams.get(k);
          const code = matchCodeToken(val);
          if (code) return code;
        }
        return ""; // URL with no product code — do not scan host/path junk
      }
    } catch {
      /* fall through */
    }
    // Free text: prefer hyphenated codes first
    let m = s.match(/\b([A-Za-z]{2,12})-(\d{2,5})\b/);
    if (m && !isBadCodePrefix(m[1])) {
      return `${m[1].toUpperCase()}-${m[2]}`;
    }
    m = s.match(/\b([A-Za-z]{3,12})(\d{3,5})\b/);
    if (m && !isBadCodePrefix(m[1])) {
      return `${m[1].toUpperCase()}-${m[2]}`;
    }
    return "";
  }

  /**
   * Bind a human title to the page being downloaded.
   * If title belongs to a different product code than pageUrl, discard it.
   * Always prefix with the page's product code when known.
   */
  function bindTitleToPage(pageUrl, title) {
    const urlCode = extractProductCode(pageUrl || "") || "";
    let t = cleanPageTitle(title || "") || "";
    const titleCode = extractProductCode(t) || "";

    // Title is clearly for another video → keep only the URL code
    if (urlCode && titleCode && urlCode.toUpperCase() !== titleCode.toUpperCase()) {
      return urlCode;
    }

    if (urlCode) {
      if (!t) return urlCode;
      // Strip any code from body then re-prefix with page code
      const rest = t
        .replace(new RegExp(urlCode.replace("-", "[-_ ]?"), "i"), " ")
        .replace(new RegExp((titleCode || "NOPE").replace("-", "[-_ ]?"), "i"), " ")
        .replace(/\s+/g, " ")
        .trim();
      // Drop leftover episode counters like "6/100" or "6_100"
      const body = rest
        .replace(/\b\d{1,3}\s*[/／]\s*\d{1,3}\b/g, " ")
        .replace(/\b\d{1,3}_\d{2,3}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return body ? `${urlCode} ${body}` : urlCode;
    }

    // No code in URL — clean title, still drop episode counters
    if (!t) return "";
    t = t
      .replace(/\b\d{1,3}\s*[/／]\s*\d{1,3}\b/g, " ")
      .replace(/\b\d{1,3}_\d{2,3}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return t;
  }

  /**
   * Strip common site suffixes / leak tags so names stay scannable.
   * Input often looks like:
   *   "SNOS-309 -Uncensored-Leaked — 대규모 정전이 일어난 밤..."
   * Output goal:
   *   "SNOS-309 대규모 정전이 일어난 밤"
   */
  function cleanPageTitle(title) {
    if (!title) return "";
    let t = String(title).trim();
    // HTML entities / fullwidth spaces
    t = t
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u3000/g, " ");

    // Broken Chrome uniquify / double-ext: "a.mp4 (1).mp4", "a.mp4.mp4"
    t = t.replace(
      /\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*\.(mp4|webm|mkv|mp3|m4a)$/i,
      ""
    );
    t = t.replace(/\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*$/i, "");
    t = t.replace(/\s*\(\d{1,3}\)\s*(?=\.[a-z0-9]{2,5}$)/i, "");
    t = t.replace(/\.(mp4|webm|mkv|mp3|m4a|ts|m3u8)+$/i, "");
    t = t.replace(/\s*\(\d{1,3}\)\s*$/g, "");

    // Browser / site notification counts: "(2) Video title"
    t = t.replace(/^\(\d{1,4}\)\s*/, "");
    t = t.replace(/^[\(\[]?\d{1,3}[\)\]]\s+/, "");

    // Normalize product code at start: [ssis-001] / ssis_001 / SSIS 001
    t = t.replace(
      /^\[?\s*([A-Za-z]{2,12})[-_ ]?(\d{2,5})\s*\]?\s*/i,
      (_, p, n) => `${p.toUpperCase()}-${n} `
    );

    // Remove English leak / marketing tags (anywhere, common on 123av titles)
    // Note: no \b after Leaked — titles often continue as Leaked_720p
    t = t.replace(
      /[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi,
      " "
    );
    t = t.replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ");
    t = t.replace(
      /[-–—|·•:_\s]*(No\s*Mosaic|Demosaic|Uncut|Raw)(?=[_\s\-–—.]|$)/gi,
      " "
    );
    t = t.replace(/[-–—|·•:_\s]*Chinese\s*Subtitles?/gi, " ");

    // Remove site brand suffixes (adult tubes included)
    t = t.replace(
      /\s*[\-|–—|·•:]\s*(YouTube|Vimeo|Twitter|X|Instagram|Facebook|TikTok|Naver|다음|카카오|Twitch|Netflix|Watcha|TVING|웨이브|Disney\+|Prime Video|Bilibili|nico(?:nico)?|SOOP|Chzzk|아프리카TV|123AV|123av\.com|123av|JavLibrary|JavDB|MissAV|Jable|Avgle|ThisAV|Netflav|Supjav|Reels|njav|javdb).*$/i,
      ""
    );
    t = t.replace(/\s*[\-|–—|·•]\s*Watch\s*(Free|Online|Full).*$/i, "");
    t = t.replace(/\s*[\-|–—|·•]\s*Free\s*Porn.*$/i, "");

    // Collapse fancy dashes to space so "CODE — title" → "CODE title"
    t = t.replace(/[\u2010-\u2015\u2212|·•]+/g, " ");
    t = t.replace(/\s*[-]{2,}\s*/g, " ");
    // Single hyphen used as separator between code and English junk already stripped
    t = t.replace(/\s+-\s+/g, " ");

    // Episode / progress junk: "6/100", "6／100", "Part 1/2"
    t = t.replace(/\b(?:part|ep|episode|vol\.?)\s*\d{1,3}\s*[/／]\s*\d{1,3}\b/gi, " ");
    t = t.replace(/\b\d{1,3}\s*[/／]\s*\d{1,3}\b/g, " ");
    t = t.replace(/\b\d{1,3}_\d{2,3}\b/g, " ");

    // Drop leftover leading/trailing punctuation / quality glued with underscore only
    t = t.replace(/^[\s\-–—|:·•._]+|[\s\-–—|:·•._]+$/g, "");
    t = t.replace(/\s+/g, " ").trim();
    // "CODE _720p" / "CODE_" leftovers after tag strip
    t = t.replace(/\s+_\s*/g, " ").replace(/_+$/g, "").trim();

    // Ensure product code is uppercase at front if present mid-string only once
    const code = extractProductCode(t);
    if (code) {
      const rest = t
        .replace(new RegExp(code.replace("-", "[-_ ]?"), "i"), " ")
        .replace(/\s+/g, " ")
        .trim();
      t = rest ? `${code} ${rest}` : code;
    }

    return sanitize(t, 72);
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

  function extFromFilename(filename, fallback = "mp4") {
    const match = String(filename || "").match(/\.([a-z0-9]{2,5})$/i);
    if (!match) return fallback;
    const ext = match[1].toLowerCase();
    if (ext === "m3u8" || ext === "mpd" || ext === "ts" || ext === "m4s") {
      return fallback;
    }
    return [
      "mp4", "webm", "mkv", "mov", "m4v", "mp3", "m4a", "aac", "wav",
      "ogg", "ogv"
    ].includes(ext)
      ? ext
      : fallback;
  }

  /**
   * Last-resort identity for a naked media URL. Page/video titles always win;
   * this only prevents indistinguishable generic names when no title exists.
   */
  function titleFromUrl(url) {
    const pathBase = cleanPageTitle(baseFromUrl(url));
    if (pathBase && !isUglyBase(pathBase)) return pathBase;
    try {
      const parsed = new URL(url);
      for (const key of ["title", "name", "filename", "v", "video", "id"]) {
        const value = cleanPageTitle(parsed.searchParams.get(key) || "");
        if (value && !isUglyBase(value)) return value;
      }
      const host = parsed.hostname.replace(/^www\./i, "").split(".")[0];
      return sanitize(host ? `${host} video` : "Downloaded video", 72);
    } catch {
      return "Downloaded video";
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
   * (no Uncensored-Leaked / em-dash noise)
   */
  function buildFilename(opts = {}) {
    const {
      title = "",
      pageTitle = "",
      quality = "",
      type = "video",
      host = "",
      existing = "",
      index = 0,
      pageUrl = "",
      url = "",
      extension = ""
    } = opts;

    const isAudio = type === "audio";
    const ext = isAudio
      ? "mp3"
      : extFromFilename(
          extension ? `file.${String(extension).replace(/^\./, "")}` : existing,
          extFromUrl(url, "mp4")
        );

    // Bind title to the page/url being saved so we never use another video's name
    const pageRef = pageUrl || url || "";
    const boundTitle = pageRef
      ? bindTitleToPage(pageRef, title || pageTitle || existing)
      : "";
    const boundPage = pageRef
      ? bindTitleToPage(pageRef, pageTitle || title || "")
      : "";
    const boundExisting = pageRef
      ? bindTitleToPage(
          pageRef,
          String(existing || "").replace(/\.[a-z0-9]{2,5}$/i, "")
        )
      : String(existing || "").replace(/\.[a-z0-9]{2,5}$/i, "");

    let base =
      pickBestTitle(boundTitle, boundPage, boundExisting, title, pageTitle) ||
      "";

    // If page has a product code, force it as identity even when titles empty
    if (!base && pageRef) {
      base = extractProductCode(pageRef) || "";
    }

    if (!base) {
      base = isAudio ? "오디오" : "영상";
    }

    // One more cleanup pass (existing may still carry leak tags)
    base = cleanPageTitle(base) || base;
    if (pageRef) {
      base = bindTitleToPage(pageRef, base) || base;
    }

    // Drop bare "영상"/"video" if we still have a better existing candidate
    if (/^(영상|동영상|video|media)$/i.test(base)) {
      const fromExisting = cleanPageTitle(
        String(existing || "").replace(/\.[a-z0-9]{2,5}$/i, "")
      );
      if (fromExisting && !/^(영상|동영상|video|media)$/i.test(fromExisting)) {
        base = fromExisting;
      }
    }

    // Prefer short readable body; keep product code + meaning
    // Aim: "SNOS-309 대규모 정전이 일어난 밤" (~40 chars body after code)
    if (base.length > 52) {
      const code = extractProductCode(base);
      if (code && base.toUpperCase().startsWith(code)) {
        const rest = base.slice(code.length).trim();
        const shortRest =
          rest.length > 36
            ? rest.slice(0, 34).replace(/\s+\S*$/, "") || rest.slice(0, 34)
            : rest;
        base = shortRest ? `${code} ${shortRest}` : code;
      } else {
        base = base.slice(0, 50).replace(/\s+\S*$/, "") || base.slice(0, 50);
      }
    }

    // Only keep real resolution labels — not "best" / "all"
    let q =
      quality && quality !== "unknown"
        ? String(quality).replace(/[()]/g, "").trim()
        : "";
    if (/^(best|all|unknown|highest|default)$/i.test(q)) q = "";
    // Strip quality if already in title
    if (q) {
      base = base.replace(new RegExp(`[_\\s-]*${q}\\b`, "i"), "").trim();
    }

    base = base.replace(/^\(\d{1,4}\)\s*/, "").trim() || base;
    // Remove accidental double extensions from prior names
    base = base.replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "").trim();

    let body = q ? `${base}_${q}` : base;
    if (index > 0) body = `${body}_${index + 1}`;

    let full = `${body}.${ext}`;
    full = full
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (full.length > 100) {
      const e = `.${ext}`;
      full = `${body.slice(0, 100 - e.length).trim()}${e}`;
    }
    return full;
  }

  /**
   * Series-aware filename:
   *  playlist → "Playlist - 03. Title.mp4"
   *  product  → "SSIS-003 Title.mp4"
   */
  function buildSeriesFilename(opts = {}) {
    const {
      title = "",
      pageTitle = "",
      quality = "",
      type = "video",
      seriesKey = "",
      playlistTitle = "",
      index = 0, // 1-based preferred; 0 = omit number
      total = 0
    } = opts;
    const isAudio = type === "audio";
    const ext = isAudio ? "mp3" : "mp4";

    let base =
      pickBestTitle(title, pageTitle) || (isAudio ? "오디오" : "영상");
    base = cleanPageTitle(base) || base;
    base = base.replace(/^\(\d{1,4}\)\s*/, "").trim() || base;

    const key = String(seriesKey || extractProductCode(base) || "").trim();
    const pl = sanitize(cleanPageTitle(playlistTitle || "") || playlistTitle || "", 36);
    const idx = Number(index) > 0 ? Number(index) : 0;
    const pad = total >= 100 ? 3 : 2;

    // Drop redundant key/playlist prefix already in title
    if (key && base.toUpperCase().startsWith(key.toUpperCase())) {
      /* keep as-is */
    } else if (key && !new RegExp(key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i").test(base)) {
      base = `${key} ${base}`;
    }

    if (pl) {
      const num = idx > 0 ? `${String(idx).padStart(pad, "0")}. ` : "";
      // Avoid "PL - PL - title"
      if (!base.toLowerCase().startsWith(pl.toLowerCase())) {
        base = `${pl} - ${num}${base}`;
      } else if (idx > 0 && !/\d{2,3}\.\s/.test(base.slice(0, 12))) {
        const plEsc = pl.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        base = base.replace(
          new RegExp(`^${plEsc}\\s*-\\s*`, "i"),
          `${pl} - ${num}`
        );
      }
    } else if (idx > 0 && !key) {
      base = `${String(idx).padStart(pad, "0")}. ${base}`;
    }

    let q = quality && !/^(best|all|unknown|highest|default)$/i.test(String(quality))
      ? String(quality).replace(/[()]/g, "").trim()
      : "";
    if (q && base.includes(q)) q = "";
    if (base.length > 72) {
      base = base.slice(0, 70).replace(/\s+\S*$/, "") || base.slice(0, 70);
    }
    let body = q ? `${base}_${q}` : base;
    let full = `${body}.${ext}`;
    full = full
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (full.length > 110) {
      full = `${body.slice(0, 100).trim()}.${ext}`;
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
    extractProductCode,
    bindTitleToPage,
    isUglyBase,
    extFromUrl,
    extFromFilename,
    titleFromUrl,
    buildFilename,
    buildSeriesFilename,
    displayTitle,
    isJunkMedia,
    mediaScore
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.Naming = Naming;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Naming;
}
