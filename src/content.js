/**
 * Content script — scan media, friendly titles, thumbnails
 */

(function () {
  "use strict";

  /** @type {Map<string, { hasThumb: boolean, title: string }>} */
  const REPORTED = new Map();
  let scanTimer = null;

  function absUrl(src) {
    if (!src) return null;
    try {
      return new URL(src, location.href).href;
    } catch {
      return src;
    }
  }

  function qualityFromHeight(h) {
    if (!h) return undefined;
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    if (h >= 240) return "240p";
    return `${h}p`;
  }

  /** Guess height from m3u8/CDN path tokens */
  function heightFromUrl(url) {
    const s = String(url || "");
    let m = s.match(
      /(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)/
    );
    if (m) return parseInt(m[1], 10);
    m = s.match(/[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(
      /[?&](?:quality|res|resolution|h|height)=?(2160|1440|1080|720|480|360|240)\b/i
    );
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  /** Largest playing / loaded <video> dimensions on the page */
  function bestPlayerDimensions() {
    let best = { width: 0, height: 0 };
    document.querySelectorAll("video").forEach((el) => {
      const w = el.videoWidth || 0;
      const h = el.videoHeight || 0;
      if (h >= 240 && h * w >= best.height * best.width) {
        best = { width: w, height: h };
      }
    });
    return best;
  }

  function cleanPageTitle(title) {
    if (!title) return "";
    let t = String(title).trim();
    t = t
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\u3000/g, " ");
    // Drop player/CDN host titles (useless as names)
    if (/^(javplayer|surrit|cloudflare|cdn|player)(\.|$)/i.test(t.replace(/^www\./, ""))) {
      return "";
    }
    if (/\.(com|cc|net|tv|io|me|app|xyz)(\s|$)/i.test(t) && t.length < 28) {
      return "";
    }
    // Tab counters
    t = t.replace(/^\(\d{1,4}\)\s*/, "").replace(/^\[\d{1,4}\]\s*/, "");
    // Product code at start → uppercase
    t = t.replace(
      /^\[?\s*([A-Za-z]{2,12})[-_ ]?(\d{2,5})\s*\]?\s*/i,
      (_, p, n) => `${p.toUpperCase()}-${n} `
    );
    // Strip leak / marketing tags (123av etc.; may be glued as Leaked_720p)
    t = t.replace(/[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi, " ");
    t = t.replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ");
    t = t.replace(
      /[-–—|·•:_\s]*(No\s*Mosaic|Demosaic|Uncut|Raw)(?=[_\s\-–—.]|$)/gi,
      " "
    );
    t = t.replace(/[-–—|·•:_\s]*Chinese\s*Subtitles?/gi, " ");
    t = t.replace(
      /\s*[\-|–—|·•:]\s*(YouTube|Vimeo|Twitter|X|Instagram|Facebook|TikTok|Naver|다음|카카오|Twitch|Netflix|Watcha|TVING|웨이브|Disney\+|Prime Video|Bilibili|SOOP|Chzzk|아프리카TV|123AV|123av\.com|123av|MissAV|Jable|Avgle|JavLibrary|JavDB|ThisAV|Netflav|javplayer|Shorts|njav|javdb).*$/i,
      ""
    );
    t = t.replace(/\s*[\-|–—|·•]\s*Watch\s*(Free|Online|Full).*$/i, "");
    // Fancy dashes → space so "CODE — title" stays scannable
    t = t.replace(/[\u2010-\u2015\u2212|·•]+/g, " ");
    t = t.replace(/\s+-\s+/g, " ");
    return t
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function titleFromLocation() {
    try {
      const segs = (location.pathname || "").split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = decodeURIComponent(segs[i]);
        // SSIS-001, START-123, abc-123
        if (/^[a-z]{2,12}-\d{2,5}$/i.test(s)) return s.toUpperCase();
        if (/^[a-z]{2,10}\d{2,5}[a-z]?$/i.test(s) && s.length >= 5 && s.length <= 16) {
          return s.toUpperCase();
        }
      }
      const u = new URL(location.href);
      for (const k of ["v", "id", "code", "video", "no"]) {
        const val = u.searchParams.get(k);
        if (val && /^[a-z]{2,12}-\d{2,5}$/i.test(val)) return val.toUpperCase();
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  function isPlayerFrame() {
    try {
      if (window !== window.top) {
        const h = location.hostname.replace(/^www\./, "");
        if (/javplayer|player|embed|surrit|cloudfront|cdn/i.test(h)) return true;
      }
    } catch {
      return true;
    }
    return false;
  }

  /**
   * Human-readable video name for list + save.
   * Prefer real page title / h1 / product code — never player domain.
   */
  function pageTitle() {
    // In embed/player iframes, don't invent names from javplayer.cc
    if (isPlayerFrame()) {
      return ""; // background will use tab title from main page
    }

    const og =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content;
    const h1 =
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector(".title, [class*='video-title'], [class*='detail-title']")?.textContent?.trim();
    const code = titleFromLocation();

    const raw = [h1, og, document.title]
      .map((t) => cleanPageTitle(t || ""))
      .filter((t) => t && t.length >= 2 && !/^(home|index|video|watch)$/i.test(t));

    if (!raw.length && code) return code;
    if (!raw.length) return "";

    // Prefer longest descriptive title
    let best = raw.sort((a, b) => b.length - a.length)[0];

    // Ensure product code is at the front when available (easy to identify)
    if (code && !best.toUpperCase().includes(code.toUpperCase())) {
      best = `${code} ${best}`;
    } else if (code) {
      // Normalize: CODE + rest
      const rest = best.replace(new RegExp(code, "i"), "").trim();
      best = rest ? `${code} ${rest}` : code;
    }

    return cleanPageTitle(best);
  }

  function pageThumbnail() {
    const candidates = [
      document.querySelector('meta[property="og:image"]')?.content,
      document.querySelector('meta[property="og:image:url"]')?.content,
      document.querySelector('meta[property="og:image:secure_url"]')?.content,
      document.querySelector('meta[name="twitter:image"]')?.content,
      document.querySelector('meta[property="og:video:poster"]')?.content,
      document.querySelector('link[rel="image_src"]')?.href,
      document.querySelector("video[poster]")?.getAttribute("poster"),
      document.querySelector(".vjs-poster img, .plyr__poster, [class*='poster'] img")?.src,
      document.querySelector("img[class*='cover' i], img[class*='thumb' i], img[class*='poster' i]")?.src,
      // largest content image heuristic
      ...[...document.querySelectorAll("img[src]")]
        .filter((img) => (img.naturalWidth || img.width || 0) >= 200)
        .sort(
          (a, b) =>
            (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0) -
            (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0)
        )
        .slice(0, 3)
        .map((img) => img.currentSrc || img.src)
    ];
    for (const c of candidates) {
      const u = absUrl(c);
      if (!u || u.startsWith("data:")) continue;
      if (/\.svg(\?|$)/i.test(u)) continue;
      if (/sprite|icon|logo|avatar|badge|1x1|pixel/i.test(u)) continue;
      return u;
    }
    return null;
  }

  /** poster / og:image first — no play required */
  function captureVideoThumb(video) {
    if (!(video instanceof HTMLVideoElement)) return pageThumbnail();

    if (video.poster) {
      const p = absUrl(video.poster);
      if (p) return p;
    }
    const wrap = video.closest("[class*='player'], [class*='video'], figure, .video");
    const img = wrap?.querySelector("img[src]");
    if (img?.src && (!img.naturalWidth || img.naturalWidth > 40)) {
      const u = absUrl(img.src);
      if (u) return u;
    }

    try {
      if (video.videoWidth && video.readyState >= 2) {
        const maxW = 240;
        const scale = Math.min(1, maxW / video.videoWidth);
        const w = Math.max(1, Math.round(video.videoWidth * scale));
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          return canvas.toDataURL("image/jpeg", 0.62);
        }
      }
    } catch {
      /* tainted */
    }
    return pageThumbnail();
  }

  function mediaLabel(el) {
    // Always prefer page-level title (what the video is about)
    const page = pageTitle();
    if (page && page.length >= 2) return page;

    if (!el) return "";
    const aria = el.getAttribute("aria-label") || el.getAttribute("title");
    if (aria && aria.length > 2 && aria.length < 160) {
      const c = cleanPageTitle(aria);
      if (c.length > 2) return c;
    }
    const root =
      el.closest("article, section, [class*='player'], [class*='video'], figure") ||
      el.parentElement;
    const near = root?.querySelector("h1, h2, h3, [class*='title']");
    const t = near?.textContent?.trim();
    if (t && t.length > 2 && t.length < 160) {
      const c = cleanPageTitle(t);
      if (c.length > 2) return c;
    }
    return "";
  }

  function buildFilename(title, quality, ext) {
    let base = cleanPageTitle(title) || "동영상";
    // Match extension Naming style: CODE 제목_720p.mp4
    let q =
      quality && !/^(best|all|unknown|highest|default)$/i.test(String(quality))
        ? String(quality).replace(/[()]/g, "").trim()
        : "";
    if (q && base.includes(q)) q = "";
    const body = q ? `${base}_${q}` : base;
    return `${body}.${ext || "mp4"}`
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  }

  function sendItems(items) {
    if (!items.length) return;
    const fresh = [];
    for (const i of items) {
      if (!i.url) continue;
      const prev = REPORTED.get(i.url);
      const hasThumb = !!(i.thumbnail && String(i.thumbnail).length > 8);
      if (
        !prev ||
        (hasThumb && !prev.hasThumb) ||
        (i.title && i.title !== prev.title)
      ) {
        REPORTED.set(i.url, { hasThumb, title: i.title || prev?.title || "" });
        fresh.push(i);
      }
    }
    if (!fresh.length) return;
    chrome.runtime
      .sendMessage({
        type: "PAGE_MEDIA",
        items: fresh,
        pageMeta: {
          title: pageTitle(),
          thumbnail: pageThumbnail(),
          host: location.hostname
        }
      })
      .catch(() => {});
  }

  function isLikelyAdEl(el, url) {
    const w = el.videoWidth || el.clientWidth || 0;
    const h = el.videoHeight || el.clientHeight || 0;
    if (w > 0 && h > 0 && w * h <= 480 * 280) return true;
    if (h > 0 && h <= 272 && w <= 500) return true;
    if (url && /\d+_\d{2,4}x\d{2,4}/i.test(url)) return true;
    // Nested in ad containers
    if (el.closest?.('[class*="ad" i], [id*="ad" i], [class*="ads" i], [class*="banner" i], ins.adsbygoogle')) {
      return true;
    }
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0 && dur < 5) return true;
    return false;
  }

  function extractFromMediaEl(el) {
    const items = [];
    const urls = new Set();
    const title = mediaLabel(el);
    const thumb = captureVideoThumb(el) || pageThumbnail();
    const host = location.hostname;

    const push = (url, extra = {}) => {
      const u = absUrl(url);
      if (!u || urls.has(u)) return;
      if (isLikelyAdEl(el, u)) return;
      urls.add(u);
      const w = el.videoWidth || undefined;
      const h = el.videoHeight || undefined;
      const quality = qualityFromHeight(h);
      const isStream = /\.m3u8(\?|$|#)/i.test(u) || /\.mpd(\?|$|#)/i.test(u);
      const isAudio = el.tagName === "AUDIO";
      const ext = isAudio ? "mp3" : "mp4";
      // Always use page title for filename, never CDN path
      const niceTitle = title || pageTitle();
      items.push({
        url: u,
        title: niceTitle,
        pageTitle: pageTitle(),
        pageUrl: location.href,
        host,
        filename: buildFilename(niceTitle, quality, ext),
        type: isAudio ? "audio" : isStream ? "stream" : "video",
        source: "page",
        width: w,
        height: h,
        quality,
        isHls: /\.m3u8(\?|$|#)/i.test(u),
        duration: Number.isFinite(el.duration) ? el.duration : undefined,
        thumbnail: thumb || undefined,
        ...extra
      });
    };

    if (el.currentSrc) push(el.currentSrc);
    if (el.src) push(el.src);
    el.querySelectorAll("source").forEach((s) => {
      if (s.src) push(s.src, { mime: s.type || undefined });
    });

    return items;
  }

  /**
   * Max-style: sniff m3u8/mp4 URLs from inline scripts & HTML (123av / missav / javplayer).
   */
  function sniffUrlsFromPageText() {
    const found = new Set();
    const add = (u) => {
      try {
        const abs = absUrl(u);
        if (!abs || abs.startsWith("blob:")) return;
        if (!/\.m3u8(\?|$|#)|playlist\.m3u8|master\.m3u8|\.mp4(\?|$|#)/i.test(abs)) return;
        // skip tiny ad-looking names
        if (/\d+_\d{2,4}x\d{2,4}/i.test(abs)) return;
        found.add(abs);
      } catch {
        /* ignore */
      }
    };

    // 1) All script tags (inline)
    document.querySelectorAll("script").forEach((sc) => {
      const t = sc.textContent || "";
      if (t.length < 20 || t.length > 2_000_000) return;
      // absolute urls
      const reAbs =
        /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
      let m;
      while ((m = reAbs.exec(t))) add(m[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/"));
      // escaped JSON urls
      const reEsc = /https?:\\\/\\\/[^"'\\]+?\.(?:m3u8|mp4)/gi;
      while ((m = reEsc.exec(t))) {
        add(m[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/"));
      }
      // relative playlist paths
      const reRel = /["']([^"']*?(?:playlist|master|index)[^"']*\.m3u8[^"']*)["']/gi;
      while ((m = reRel.exec(t))) add(m[1]);
      // uuid + playlist pattern (missav/surrit style)
      // e.g. surrit.com/xxxxxxxx-xxxx.../playlist.m3u8 or /uuid/720p/video.m3u8
      const reUuid =
        /["'](https?:\/\/[^"']+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^"']*\.m3u8[^"']*)["']/gi;
      while ((m = reUuid.exec(t))) add(m[1]);
      // source: '...' patterns
      const reSrc = /(?:src|source|file|url|hls|playlist)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/gi;
      while ((m = reSrc.exec(t))) add(m[1]);
    });

    // 2) HTML attributes
    const html = document.documentElement?.innerHTML || "";
    if (html.length < 3_000_000) {
      const reAbs =
        /https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>]*)?/gi;
      let m;
      while ((m = reAbs.exec(html))) {
        if (m[0].length < 500) add(m[0]);
      }
    }

    // 3) performance resources already loaded
    try {
      performance.getEntriesByType("resource").forEach((e) => {
        if (/\.m3u8|\.mp4/i.test(e.name)) add(e.name);
      });
    } catch {
      /* ignore */
    }

    return [...found];
  }

  function scanPage() {
    const items = [];
    const title = pageTitle();
    const thumb = pageThumbnail();
    const host = location.hostname;

    document.querySelectorAll("video, audio").forEach((el) => {
      items.push(...extractFromMediaEl(el));
    });

    document
      .querySelectorAll("[data-video-url], [data-src*='.mp4'], [data-src*='.m3u8']")
      .forEach((el) => {
        const u = el.getAttribute("data-video-url") || el.getAttribute("data-src");
        if (!u) return;
        const url = absUrl(u);
        const isStream = /\.m3u8/i.test(u);
        let localThumb =
          absUrl(el.getAttribute("data-poster") || el.getAttribute("poster")) ||
          (el.querySelector?.("img") && absUrl(el.querySelector("img").src)) ||
          thumb;
        items.push({
          url,
          title,
          pageTitle: title,
          host,
          filename: buildFilename(title, null, "mp4"),
          type: isStream ? "stream" : "video",
          source: "page",
          isHls: isStream,
          thumbnail: localThumb || undefined
        });
      });

    const og = document.querySelector(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
    );
    if (og?.content) {
      items.push({
        url: absUrl(og.content),
        title,
        pageTitle: title,
        host,
        filename: buildFilename(title, null, "mp4"),
        type: "video",
        source: "page",
        thumbnail: thumb || undefined
      });
    }

    // Script sniff — critical for 123av / missav-style players
    const playerDim = bestPlayerDimensions();
    for (const u of sniffUrlsFromPageText()) {
      const isHls = /\.m3u8/i.test(u);
      const fromUrl = heightFromUrl(u);
      const h = fromUrl || playerDim.height || 0;
      const q = qualityFromHeight(h);
      items.push({
        url: u,
        title,
        pageTitle: title,
        host,
        filename: buildFilename(title, q, "mp4"),
        type: isHls ? "stream" : "video",
        source: "script-sniff",
        isHls,
        width: h ? playerDim.width || undefined : undefined,
        height: h || undefined,
        quality: q,
        thumbnail: thumb || undefined
      });
    }

    // If page has a loaded player but sniff/items lack height, stamp max height
    if (playerDim.height >= 240) {
      const q = qualityFromHeight(playerDim.height);
      for (const it of items) {
        if (!(it.height >= 240) && (it.isHls || it.type === "stream" || /\.m3u8/i.test(it.url || ""))) {
          it.height = playerDim.height;
          it.width = playerDim.width || it.width;
          it.quality = q;
          it.filename = buildFilename(it.title || title, q, "mp4");
        }
      }
    }

    // TikTok: pull play URLs from embedded page JSON (works while watching)
    if (/tiktok\.com$/i.test(host.replace(/^www\./, "")) || host.includes("tiktok")) {
      for (const u of extractTikTokPlayUrls()) {
        items.push({
          url: u,
          title,
          pageTitle: title,
          host,
          filename: buildFilename(title, null, "mp4"),
          type: "video",
          source: "tiktok-page",
          isHls: false,
          isSiteDownload: false,
          site: "tiktok",
          thumbnail: thumb || undefined
        });
      }
    }

    chrome.runtime
      .sendMessage({
        type: "PAGE_META",
        pageMeta: { title, thumbnail: thumb, host }
      })
      .catch(() => {});

    sendItems(items.filter((i) => i.url));
  }

  /**
   * TikTok — same strategy as SnapTik-class tools:
   * walk __UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE for playAddr/downloadAddr/url_list.
   */
  function extractTikTokPlayUrls() {
    const found = new Set();

    function normalizeUrl(raw) {
      if (!raw) return null;
      let u = String(raw)
        .replace(/\\u002F/g, "/")
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/&amp;/g, "&");
      try {
        u = decodeURIComponent(u);
      } catch {
        /* keep */
      }
      if (!/^https?:\/\//i.test(u)) return null;
      // Never treat scripts / APIs as video
      if (/\.(js|css|json|map|woff2?)(\?|$)/i.test(u)) return null;
      if (/\/webmssdk|\/webapp-desktop|runtime|chunk|webpack|sentry|analytics/i.test(u)) {
        return null;
      }
      if (!/tiktokcdn|byteicdn|tiktokv|byteoversea|musical\.ly|tiktok\.com\/aweme|\/video\/tos\//i.test(u)) {
        return null;
      }
      if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) && !/video|play|media|mime_type=video/i.test(u)) {
        return null;
      }
      // Prefer media-looking paths
      if (
        !/\.mp4(\?|$)/i.test(u) &&
        !/mime_type=video|\/video\/tos\/|play_addr|download_addr|\/play\//i.test(u) &&
        !/media-video|aweme\/v1/i.test(u)
      ) {
        // still allow tiktokcdn hosts without clear path if not js
        if (!/tiktokcdn|byteicdn/i.test(u)) return null;
      }
      return u.split("#")[0];
    }

    function addUrl(raw) {
      const u = normalizeUrl(raw);
      if (u) found.add(u);
    }

    function walk(obj, depth) {
      if (!obj || depth > 35) return;
      if (typeof obj === "string") {
        addUrl(obj);
        return;
      }
      if (Array.isArray(obj)) {
        for (const x of obj.slice(0, 300)) walk(x, depth + 1);
        return;
      }
      if (typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const kl = String(k).toLowerCase();
        if (
          [
            "playaddr",
            "downloadaddr",
            "play_addr",
            "download_addr",
            "play",
            "hdplay",
            "wmplay"
          ].includes(kl) &&
          typeof v === "string"
        ) {
          addUrl(v);
        } else if ((kl === "url_list" || kl === "urllist") && Array.isArray(v)) {
          for (const x of v) addUrl(x);
        } else {
          walk(v, depth + 1);
        }
      }
    }

    // Primary: structured page JSON (SnapTik / scrapers do this)
    const scripts = document.querySelectorAll(
      'script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE, script[id*="SIGI"], script[type="application/json"]'
    );
    scripts.forEach((s) => {
      const t = (s.textContent || "").trim();
      if (t.length < 80) return;
      try {
        walk(JSON.parse(t), 0);
      } catch {
        // regex fallback on raw text
        const re =
          /https?:\\\/\\\/[^"'\\\s]+|https?:\/\/[^"'\s]{30,}/g;
        let m;
        while ((m = re.exec(t)) !== null) addUrl(m[0]);
      }
    });

    // video element (non-blob)
    document.querySelectorAll("video").forEach((v) => {
      const src = v.currentSrc || v.src;
      if (src && !src.startsWith("blob:")) addUrl(src);
      // source children
      v.querySelectorAll("source").forEach((s) => addUrl(s.src));
    });

    return [...found].slice(0, 12);
  }

  /**
   * Instagram: og:video + page JSON video_url / video_versions (when present).
   */
  function extractInstagramPlayUrls() {
    const found = new Set();
    function add(raw) {
      if (!raw || typeof raw !== "string") return;
      let u = raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      try {
        u = decodeURIComponent(u);
      } catch {
        /* keep */
      }
      if (!/^https?:\/\//i.test(u)) return;
      if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(u)) return;
      if (!/\.mp4(\?|$)/i.test(u) && !/cdninstagram|fbcdn\.net/i.test(u)) return;
      if (/\.mp4(\?|$)/i.test(u) || /video/i.test(u)) found.add(u.split("#")[0]);
    }

    document
      .querySelectorAll(
        'meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"]'
      )
      .forEach((m) => add(m.content));

    document.querySelectorAll("video").forEach((v) => {
      if (v.currentSrc && !v.currentSrc.startsWith("blob:")) add(v.currentSrc);
      if (v.src && !v.src.startsWith("blob:")) add(v.src);
      v.querySelectorAll("source").forEach((s) => add(s.src));
    });

    // Walk JSON blobs in scripts
    function walk(obj, depth) {
      if (!obj || depth > 30) return;
      if (typeof obj === "string") {
        if (/\.mp4/i.test(obj) || /cdninstagram|fbcdn\.net.*video/i.test(obj)) add(obj);
        return;
      }
      if (Array.isArray(obj)) {
        for (const x of obj.slice(0, 200)) walk(x, depth + 1);
        return;
      }
      if (typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const kl = String(k).toLowerCase();
        if (
          ["video_url", "video_src", "playback_url", "content_url", "src"].includes(kl) &&
          typeof v === "string"
        ) {
          add(v);
        } else if (kl === "video_versions" && Array.isArray(v)) {
          for (const x of v) {
            if (x && typeof x.url === "string") add(x.url);
          }
        } else {
          walk(v, depth + 1);
        }
      }
    }

    document.querySelectorAll('script[type="application/ld+json"], script').forEach((s) => {
      const t = (s.textContent || "").trim();
      if (t.length < 80 || t.length > 2_000_000) return;
      if (!/video|cdninstagram|fbcdn|\.mp4/i.test(t)) return;
      try {
        if (t.startsWith("{") || t.startsWith("[")) walk(JSON.parse(t), 0);
      } catch {
        const re = /https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi;
        let m;
        while ((m = re.exec(t)) !== null) add(m[0]);
      }
    });

    return [...found].slice(0, 10);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 400);
  }

  // Skip MutationObserver on TikTok/Instagram — DOM churn lags players
  if (!isTikTokHost() && !isInstagramHost()) {
    const mo = new MutationObserver(() => scheduleScan());
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "poster"]
    });
  }

  document.addEventListener(
    "loadedmetadata",
    (e) => {
      if (e.target instanceof HTMLMediaElement) {
        if (e.target.currentSrc) REPORTED.delete(e.target.currentSrc);
        if (e.target.src) REPORTED.delete(e.target.src);
        scheduleScan();
      }
    },
    true
  );
  document.addEventListener(
    "loadeddata",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        if (e.target.currentSrc) REPORTED.delete(e.target.currentSrc);
        scheduleScan();
      }
    },
    true
  );
  document.addEventListener(
    "play",
    (e) => {
      if (e.target instanceof HTMLMediaElement) {
        if (e.target.currentSrc) REPORTED.delete(e.target.currentSrc);
        scheduleScan();
      }
    },
    true
  );
  // After seek/play, frame may be ready for canvas thumb
  document.addEventListener(
    "seeked",
    (e) => {
      if (e.target instanceof HTMLVideoElement) {
        if (e.target.currentSrc) REPORTED.delete(e.target.currentSrc);
        scheduleScan();
      }
    },
    true
  );

  function isTikTokHost() {
    const h = (location.hostname || "").toLowerCase();
    return h.includes("tiktok.com") || h.includes("tiktokv.com");
  }

  function isYouTubeHost() {
    const h = (location.hostname || "").toLowerCase();
    return h.includes("youtube.com") || h === "youtu.be" || h.includes("youtube-nocookie.com");
  }

  function isInstagramHost() {
    const h = (location.hostname || "").toLowerCase();
    return h.includes("instagram.com") || h.includes("instagr.am");
  }

  function injectPageScript() {
    // Never inject MSE/fetch hooks on major social sites — breaks playback
    if (isTikTokHost() || isYouTubeHost() || isInstagramHost()) return;
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("src/injected.js");
      s.onload = () => s.remove();
      (document.documentElement || document.head).appendChild(s);
    } catch {
      /* ignore */
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "universal-video-downloader") return;
    if (data.type === "FOUND_MEDIA" && Array.isArray(data.items)) {
      const title = pageTitle();
      const thumb = pageThumbnail();
      // Prefer real URLs over blob noise in listing later; still report both
      sendItems(
        data.items
          .filter((i) => {
            const url = i.url || "";
            // skip pure tiny segment noise from inject
            if (i.type === "segment") return false;
            return !!url;
          })
          .map((i) => {
            const url = absUrl(i.url) || i.url;
            const isHls = /\.m3u8/i.test(url || "");
            return {
              ...i,
              url,
              title,
              pageTitle: title,
              pageUrl: location.href,
              host: location.hostname,
              filename: buildFilename(title, i.quality, isHls ? "mp4" : "mp4"),
              source: "injected",
              thumbnail: thumb || undefined,
              isHls: isHls || i.isHls
            };
          })
      );
    }
  });

  /**
   * Fetch another page on this site (same cookies / origin context) and
   * scrape og:image + title. Also judges whether the page is a real video.
   */
  async function probePageMeta(targetUrl, expectedKey) {
    const url = String(targetUrl || "").trim();
    if (!url || !/^https?:/i.test(url)) {
      return { ok: false, exists: false, error: "bad url" };
    }
    // Same-site only from content script (avoid leaking cookies cross-site)
    try {
      const a = new URL(url);
      const b = new URL(location.href);
      if (a.hostname.replace(/^www\./, "") !== b.hostname.replace(/^www\./, "")) {
        return { ok: false, exists: false, error: "cross-origin" };
      }
    } catch {
      return { ok: false, exists: false, error: "bad url" };
    }
    try {
      const res = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      const finalUrl = res.url || url;
      const status = res.status;
      if (!res.ok) {
        return {
          ok: false,
          exists: false,
          status,
          url,
          finalUrl,
          error: `HTTP ${status}`
        };
      }
      const html = await res.text();
      if (!html || html.length < 200) {
        return {
          ok: false,
          exists: false,
          status,
          url,
          finalUrl,
          error: "empty"
        };
      }
      const pickMeta = (...pats) => {
        for (const re of pats) {
          const m = html.match(re);
          if (m?.[1]) return m[1].trim();
        }
        return "";
      };
      let thumb =
        pickMeta(
          /property=["']og:image(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i,
          /content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url|:url)?["']/i,
          /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
          /content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i,
          /rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
          /<video[^>]+poster=["']([^"']+)["']/i
        ) || "";
      // Cover/thumb img heuristics (123av card grids & players)
      if (!thumb) {
        const imgs = [
          ...html.matchAll(
            /<img[^>]+(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["'][^>]+src=["']([^"']+)["']/gi
          ),
          ...html.matchAll(
            /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["']/gi
          )
        ];
        for (const m of imgs) {
          const u = m[1];
          if (u && !/\.svg(\?|$)/i.test(u) && !/sprite|icon|logo|avatar|1x1|pixel/i.test(u)) {
            thumb = u;
            break;
          }
        }
      }
      let title =
        pickMeta(
          /property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
          /content=["']([^"']+)["'][^>]*property=["']og:title["']/i,
          /<title[^>]*>([^<]{2,200})<\/title>/i
        ) || "";
      // Decode common entities
      const dec = (s) =>
        String(s || "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");
      thumb = dec(thumb);
      title = dec(title);
      if (thumb && thumb.startsWith("//")) thumb = location.protocol + thumb;
      if (thumb && thumb.startsWith("/")) {
        try {
          thumb = new URL(thumb, location.origin).href;
        } catch {
          /* ignore */
        }
      }
      if (thumb && !/^https?:|^data:/i.test(thumb)) {
        try {
          thumb = new URL(thumb, finalUrl || url).href;
        } catch {
          thumb = "";
        }
      }

      // ── existence heuristics (avoid listing phantom product codes) ──
      const bodySample = html.slice(0, 8000);
      const blocked =
        /just a moment|cf-browser-verification|attention required|checking your browser|enable javascript|access denied|captcha/i.test(
          title + " " + bodySample
        );
      const notFound =
        status === 404 ||
        /not\s*found|404|페이지를\s*찾을|존재하지\s*않|no\s*results?|검색\s*결과\s*없|video\s*not\s*found|deleted|removed/i.test(
          title + " " + bodySample
        );
      const isSearch =
        /\/search/i.test(finalUrl) ||
        /[?&](q|keyword|query|search)=/i.test(finalUrl);
      const key = String(expectedKey || "").trim();
      const keyU = key.toUpperCase();
      const keyLoose = keyU.replace(/[-_\s]/g, "");
      const hay = `${title} ${finalUrl}`.toUpperCase().replace(/[-_\s]/g, "");
      const keyInPage =
        !key ||
        hay.includes(keyU.replace(/[-_\s]/g, "")) ||
        (keyLoose.length >= 4 && hay.includes(keyLoose));
      // Soft-404: site returns 200 home/search without the code
      const looksVideoPath = /\/(v|video|watch|dm\d*\/v|en\/v|ja\/v)\//i.test(
        finalUrl
      );
      let exists = !blocked && !notFound && !isSearch;
      if (exists && key && !keyInPage) {
        // Allow if we clearly landed on a video path with a poster
        exists = looksVideoPath && !!thumb;
      }
      if (exists && isSearch) exists = false;
      // Prefer requiring the product code in title/url for JAV codes
      if (exists && key && keyLoose.length >= 5 && !keyInPage && !thumb) {
        exists = false;
      }

      return {
        ok: true,
        exists,
        status,
        url,
        finalUrl,
        thumbnail: thumb || "",
        title: title || "",
        keyInPage,
        isSearch,
        notFound,
        blocked,
        source: "content-fetch"
      };
    } catch (e) {
      return {
        ok: false,
        exists: false,
        error: String(e?.message || e)
      };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SCAN_NOW") {
      REPORTED.clear();
      scanPage();
      sendResponse({
        ok: true,
        pageMeta: {
          title: pageTitle(),
          thumbnail: pageThumbnail(),
          host: location.hostname
        }
      });
      return false;
    }

    // Player videoHeight for quality chips when m3u8 has no RESOLUTION
    if (msg.type === "GET_PLAYER_HEIGHT") {
      const dim = bestPlayerDimensions();
      const h = dim.height || 0;
      sendResponse({
        ok: h >= 240,
        height: h,
        width: dim.width || 0,
        quality: qualityFromHeight(h) || ""
      });
      return false;
    }

    if (msg.type === "PROBE_PAGE_META") {
      probePageMeta(msg.url || msg.pageUrl, msg.expectedKey || msg.key || "")
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({
            ok: false,
            exists: false,
            error: String(e?.message || e)
          })
        );
      return true;
    }

    // Same-site image → data URL (CDN covers that block extension origin)
    if (msg.type === "FETCH_THUMB_PAGE") {
      (async () => {
        try {
          const url = String(msg.url || "").trim();
          if (!url || !/^https?:/i.test(url)) {
            sendResponse({ ok: false, error: "bad url" });
            return;
          }
          const res = await fetch(url, {
            credentials: "include",
            redirect: "follow"
          });
          if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            return;
          }
          const blob = await res.blob();
          if (!blob || blob.size < 80 || blob.size > 2_500_000) {
            sendResponse({ ok: false, error: "size" });
            return;
          }
          if (blob.type && !blob.type.startsWith("image/") && blob.type !== "application/octet-stream") {
            sendResponse({ ok: false, error: "not image" });
            return;
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }

    if (msg.type === "EXTRACT_TIKTOK") {
      const urls = extractTikTokPlayUrls();
      // Also re-scan so background store gets them
      if (urls.length) {
        const title = pageTitle();
        sendItems(
          urls.map((url) => ({
            url,
            title,
            pageTitle: title,
            host: location.hostname,
            filename: buildFilename(title, null, "mp4"),
            type: "video",
            source: "tiktok-page",
            site: "tiktok"
          }))
        );
      }
      sendResponse({
        ok: urls.length > 0,
        urls,
        title: pageTitle(),
        pageUrl: location.href
      });
      return false;
    }

    if (msg.type === "EXTRACT_INSTAGRAM") {
      const urls = extractInstagramPlayUrls();
      if (urls.length) {
        const title = pageTitle();
        sendItems(
          urls.map((url) => ({
            url,
            title,
            pageTitle: title,
            host: location.hostname,
            filename: buildFilename(title, null, "mp4"),
            type: "video",
            source: "instagram-page",
            site: "instagram"
          }))
        );
      }
      sendResponse({
        ok: urls.length > 0,
        urls,
        title: pageTitle(),
        pageUrl: location.href
      });
      return false;
    }

    if (msg.type === "PING_CONTENT") {
      sendResponse({
        ok: true,
        hasDownload: !!(window.__UVD_PAGE_DOWNLOAD__ && window.__UVD_PAGE_DOWNLOAD__.smartDownload)
      });
      return false;
    }

    if (msg.type === "STOP_DOWNLOAD") {
      // User paused/cancelled — abort in-page HLS if active
      window.__UVD_STOP_DOWNLOAD__ = true;
      window.__UVD_STOP_JOB_ID__ = msg.jobId || null;
      try {
        window.__UVD_PAGE_DOWNLOAD__?.abort?.();
      } catch {
        /* ignore */
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "SMART_DOWNLOAD") {
      const api = window.__UVD_PAGE_DOWNLOAD__;
      if (!api?.smartDownload) {
        sendResponse({ ok: false, error: "다운로드 모듈 로드 실패 — 페이지를 새로고침 하세요" });
        return false;
      }
      window.__UVD_STOP_DOWNLOAD__ = false;
      window.__UVD_STOP_JOB_ID__ = null;
      const jobId = msg.jobId || null;
      api
        .smartDownload(
          {
            url: msg.url,
            filename: msg.filename,
            preferQuality: msg.preferQuality || "best",
            type: msg.mediaType || msg.type,
            jobId
          },
          (p) => {
            if (window.__UVD_STOP_DOWNLOAD__) {
              throw new Error("CANCELLED");
            }
            chrome.runtime
              .sendMessage({
                type: "HLS_PROGRESS",
                tabId: msg.tabId,
                progress: {
                  ...p,
                  // Bind to tracked download job (stops bar thrash across retries)
                  jobId: jobId || p.jobId || null,
                  percent:
                    typeof p.percent === "number" ? p.percent : undefined
                }
              })
              .catch(() => {});
          }
        )
        .then((result) => {
          if (window.__UVD_STOP_DOWNLOAD__) {
            sendResponse({ ok: false, error: "CANCELLED" });
            return;
          }
          sendResponse(result);
        })
        .catch((err) =>
          sendResponse({ ok: false, error: String(err?.message || err) })
        );
      return true;
    }

    if (msg.type === "CAPTURE_BLOB") {
      captureBlobFromPage(msg.url)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }

    if (msg.type === "GET_PAGE_META") {
      sendResponse({
        title: pageTitle(),
        thumbnail: pageThumbnail(),
        host: location.hostname
      });
      return false;
    }

    return false;
  });

  async function captureBlobFromPage(blobUrl) {
    const videos = [...document.querySelectorAll("video, audio")];
    let el = videos.find((v) => v.currentSrc === blobUrl || v.src === blobUrl);
    if (!el && videos.length === 1) el = videos[0];

    const title = mediaLabel(el) || pageTitle();
    const q =
      el instanceof HTMLVideoElement ? qualityFromHeight(el.videoHeight) : undefined;

    const tryBlob = async (url) => {
      const res = await fetch(url);
      const blob = await res.blob();
      if (!blob.size) throw new Error("empty");
      const dataUrl = await blobToDataUrl(blob);
      const ext = mimeToExt(blob.type);
      return {
        ok: true,
        dataUrl,
        filename: buildFilename(title, q, ext),
        size: blob.size,
        mime: blob.type
      };
    };

    if (el) {
      try {
        return await tryBlob(blobUrl || el.currentSrc);
      } catch {
        /* fallthrough */
      }
    }
    if (blobUrl?.startsWith("blob:")) {
      try {
        return await tryBlob(blobUrl);
      } catch (e) {
        return { ok: false, error: "Cannot read blob: " + e.message };
      }
    }
    return { ok: false, error: "No capturable blob video found on page" };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function mimeToExt(mime) {
    if (!mime) return "mp4";
    if (mime.includes("webm")) return "webm";
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("ogg")) return "ogv";
    if (mime.includes("audio/mpeg")) return "mp3";
    return "mp4";
  }

  injectPageScript();
  // Thumbnail/title ASAP so popup list is not empty of covers
  chrome.runtime
    .sendMessage({
      type: "PAGE_META",
      pageMeta: {
        title: pageTitle(),
        thumbnail: pageThumbnail(),
        host: location.hostname
      }
    })
    .catch(() => {});

  // TikTok: minimal presence — do NOT run aggressive scan loops (player breaks)
  if (isTikTokHost()) {
    // Light meta only; downloads use pasted link + helper
    return;
  }

  // Instagram: light scan only (og:video / <video>) — no aggressive hooks
  if (isInstagramHost()) {
    scanPage();
    setTimeout(scanPage, 1500);
    return;
  }

  scanPage();
  setTimeout(scanPage, 800);
  setTimeout(scanPage, 2000);
  setTimeout(scanPage, 5000);
})();
