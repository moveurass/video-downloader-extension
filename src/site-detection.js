(function initSiteDetection(root, factory) {
  const api = factory();
  root.UVDSites = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSiteDetection() {
  "use strict";

  const MULTI_PART_PUBLIC_SUFFIXES = new Set([
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "co.jp",
    "ne.jp",
    "or.jp",
    "com.au",
    "net.au",
    "org.au",
    "co.kr",
    "or.kr",
    "go.kr",
    "com.br",
    "com.mx",
    "co.nz",
    "com.tw"
  ]);

  const KNOWN_CODE_HOST_SUFFIXES = [
    "123av.com",
    "missav.com",
    "missav.ws",
    "jable.tv",
    "avgle.com",
    "netflav.com",
    "supjav.com",
    "njav.tv",
    "javdb.com",
    "javlibrary.com",
    "thisav.com",
    "hanime.tv"
  ];

  const KNOWN_VIDEO_CDN_SUFFIXES = [
    "surrit.com",
    "javcdn.net",
    "javcdn.com",
    "javplayer.com",
    "m3u8s.com"
  ];

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function hostMatchesSuffix(host, suffix) {
    const h = String(host || "")
      .replace(/^www\./i, "")
      .toLowerCase();
    const s = String(suffix || "")
      .replace(/^www\./i, "")
      .toLowerCase();
    return !!h && !!s && (h === s || h.endsWith("." + s));
  }

  function hostMatchesAnySuffix(host, suffixes) {
    return (suffixes || []).some((suffix) => hostMatchesSuffix(host, suffix));
  }

  function registrableDomain(hostname) {
    const host = String(hostname || "")
      .replace(/\.$/, "")
      .replace(/^www\./i, "")
      .toLowerCase();
    if (!host || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      return host;
    }
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return host;
    const last2 = parts.slice(-2).join(".");
    if (MULTI_PART_PUBLIC_SUFFIXES.has(last2) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return last2;
  }

  function isSameRegistrableSite(hostA, hostB) {
    const a = registrableDomain(hostA);
    const b = registrableDomain(hostB);
    return !!a && !!b && a === b;
  }

  function isKnownCodeHost(host) {
    return hostMatchesAnySuffix(host, KNOWN_CODE_HOST_SUFFIXES);
  }

  function isKnownVideoCdnHost(host) {
    return hostMatchesAnySuffix(host, KNOWN_VIDEO_CDN_SUFFIXES);
  }

  /**
   * Credentialed thumbnail fetches must stay on the page's site, or on a
   * known video CDN when the page itself is a known-code host.
   */
  function isTrustedThumbUrl(pageUrl, imageUrl) {
    let pageHost = "";
    let imageHost = "";
    try {
      const page = new URL(pageUrl);
      const image = new URL(imageUrl);
      if (!/^https?:$/i.test(page.protocol) || !/^https?:$/i.test(image.protocol)) {
        return false;
      }
      pageHost = page.hostname;
      imageHost = image.hostname;
    } catch {
      return false;
    }
    if (isSameRegistrableSite(pageHost, imageHost)) return true;
    return isKnownCodeHost(pageHost) && isKnownVideoCdnHost(imageHost);
  }

  function isYoutubeUrl(url) {
    const host = hostOf(url);
    return !!host && (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    );
  }

  function youtubeVideoId(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "youtu.be") {
        return parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      }
      if (!isYoutubeUrl(url)) return "";
      return (
        parsed.searchParams.get("v") ||
        parsed.pathname.match(/\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1] ||
        ""
      );
    } catch {
      return "";
    }
  }

  function youtubeThumbnailForUrl(url) {
    const videoId = youtubeVideoId(url);
    return videoId
      ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
      : "";
  }

  function isTiktokUrl(url) {
    const host = hostOf(url);
    if (!host || /tiktokcdn|byteicdn|byteoversea|ibyteimg/i.test(host)) return false;
    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "vm.tiktok.com" ||
      host === "vt.tiktok.com" ||
      host === "m.tiktok.com" ||
      host === "tiktokv.com" ||
      host.endsWith(".tiktokv.com")
    );
  }

  function isInstagramHostUrl(url) {
    const host = hostOf(url);
    if (!host || /cdninstagram|fbcdn\.net|instagram\.fs/i.test(host)) return false;
    return (
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "instagr.am" ||
      host.endsWith(".instagr.am")
    );
  }

  const INSTAGRAM_POST_PATH =
    /\/(?:share\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/i;
  const INSTAGRAM_STORY_PATH = /\/stories\/(?:highlights\/)?[^/]+\/\d+/i;

  function isInstagramPostUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const path = parsed.pathname || "";
      if (host === "instagr.am") {
        return path.length > 2 || INSTAGRAM_POST_PATH.test(path) || INSTAGRAM_STORY_PATH.test(path);
      }
      if (host === "instagram.com" || host.endsWith(".instagram.com")) {
        return INSTAGRAM_POST_PATH.test(path) || INSTAGRAM_STORY_PATH.test(path);
      }
    } catch {
      // Fall through to the conservative string check.
    }
    return (
      /instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(url) ||
      /instagram\.com\/stories\/(?:highlights\/)?[^/?#]+\/\d+/i.test(url)
    );
  }

  const isInstagramUrl = isInstagramPostUrl;

  function isInstagramCdnUrl(url) {
    const value = url || "";
    if (!/^https?:/i.test(value)) return false;
    if (/\.(jpe?g|png|gif|webp|bmp|svg|js|css)(\?|$)/i.test(value)) return false;
    return (
      (/cdninstagram\.com|fbcdn\.net/i.test(value) &&
        (/\.mp4(\?|$)/i.test(value) || /video|\/v\/t/i.test(value))) ||
      (/\.mp4(\?|$)/i.test(value) && /instagram/i.test(value))
    );
  }

  function collectInstagramMediaUrlsFromText(text) {
    const found = [];
    const seen = new Set();
    const add = (raw) => {
      if (!raw || typeof raw !== "string") return;
      let value = raw
        .replace(/\\u0026/g, "&")
        .replace(/\\u002f/gi, "/")
        .replace(/\\\//g, "/");
      try {
        value = decodeURIComponent(value);
      } catch {
        // Keep the unescaped form.
      }
      if (!/^https?:\/\//i.test(value)) return;
      const clean = value.split("#")[0];
      if (!isInstagramCdnUrl(clean) || seen.has(clean)) return;
      seen.add(clean);
      found.push(clean);
    };
    const src = String(text || "")
      .replace(/\\u0026/g, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/");
    const re = /https?:\/\/[^"'\\\s]+(?:cdninstagram\.com|fbcdn\.net)[^"'\\\s]*/gi;
    let match;
    while ((match = re.exec(src)) !== null) add(match[0]);
    return found.slice(0, 20);
  }

  function isTiktokCdnUrl(url) {
    const value = url || "";
    if (!value || !/^https?:/i.test(value)) return false;
    if (/\.(js|css|json|map|html?|woff2?|jpe?g|png|gif|webp|bmp|svg|ico)(\?|$)/i.test(value)) {
      return false;
    }
    if (/\/webmssdk|webpack|chunk|runtime|analytics|sentry|cover|avatar|photo/i.test(value)) {
      return false;
    }
    if (/mime_type=video/i.test(value) || /\/video\/tos\//i.test(value)) return true;
    return /\.mp4(\?|$)/i.test(value) &&
      /tiktokcdn|byteicdn|byteoversea|tiktokv/i.test(value);
  }

  function looksLikeVideoFileUrl(url) {
    if (!url || !/^https?:/i.test(url)) return false;
    if (/\.(js|css|json|map|html?|woff2?|jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.test(url)) {
      return false;
    }
    if (/\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url)) return true;
    if (/mime_type=video|\/video\/tos\//i.test(url)) return true;
    return isTiktokCdnUrl(url) || isInstagramCdnUrl(url);
  }

  function isXUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "t.co") return true;
      if (
        host === "x.com" ||
        host.endsWith(".x.com") ||
        host === "twitter.com" ||
        host.endsWith(".twitter.com")
      ) {
        return /\/status\/\d+/i.test(parsed.pathname || "") ||
          /\/i\/status\/\d+/i.test(parsed.pathname || "");
      }
    } catch {
      // Fall through.
    }
    return /(?:x|twitter)\.com\/.+\/status\/\d+/i.test(url);
  }

  function isFacebookUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "fb.watch" || host === "fb.com" || host.endsWith(".fb.com")) return true;
      if (host.includes("facebook.com")) {
        return (
          /\/(watch|reel|reels|videos|share|story\.php)/i.test(parsed.pathname || "") ||
          parsed.searchParams.has("v") ||
          /\/posts\//i.test(parsed.pathname || "")
        );
      }
    } catch {
      // Fall through.
    }
    return /facebook\.com\/(watch|reel|videos)|fb\.watch\//i.test(url);
  }

  function isBilibiliUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "b23.tv") return true;
      if (host.includes("bilibili.com") || host.includes("bilibili.tv")) {
        return (
          /\/video\/(BV|av)/i.test(parsed.pathname || "") ||
          /\/bangumi\//i.test(parsed.pathname || "") ||
          /\/play\//i.test(parsed.pathname || "")
        );
      }
    } catch {
      // Fall through.
    }
    return /bilibili\.com\/video\/|b23\.tv\//i.test(url);
  }

  function needsYtDlpHelper(url, pageUrl) {
    if (isTiktokCdnUrl(url) && !isTiktokUrl(url)) return false;
    if (isInstagramCdnUrl(url) && !isInstagramPostUrl(url)) return false;
    return (
      isYoutubeUrl(url) ||
      isYoutubeUrl(pageUrl) ||
      isTiktokUrl(url) ||
      isTiktokUrl(pageUrl) ||
      isInstagramPostUrl(url) ||
      isInstagramPostUrl(pageUrl) ||
      isXUrl(url) ||
      isXUrl(pageUrl) ||
      isFacebookUrl(url) ||
      isFacebookUrl(pageUrl) ||
      isBilibiliUrl(url) ||
      isBilibiliUrl(pageUrl)
    );
  }

  function siteKind(url, pageUrl) {
    if (isYoutubeUrl(url) || isYoutubeUrl(pageUrl)) return "youtube";
    if (isTiktokUrl(url) || isTiktokUrl(pageUrl)) return "tiktok";
    if (isInstagramPostUrl(url) || isInstagramPostUrl(pageUrl)) return "instagram";
    if (isXUrl(url) || isXUrl(pageUrl)) return "x";
    if (isFacebookUrl(url) || isFacebookUrl(pageUrl)) return "facebook";
    if (isBilibiliUrl(url) || isBilibiliUrl(pageUrl)) return "bilibili";
    return null;
  }

  function siteDefaultTitle(kind) {
    const names = {
      youtube: "YouTube 영상",
      tiktok: "TikTok 영상",
      instagram: "Instagram 영상",
      x: "X 영상",
      facebook: "Facebook 영상",
      bilibili: "Bilibili 영상"
    };
    return names[kind] || "영상";
  }

  function isDownloadableSiteVideo(url) {
    if (!url) return false;
    if (isYoutubeUrl(url)) {
      try {
        const parsed = new URL(url);
        if (hostOf(url) === "youtu.be" && parsed.pathname.length > 1) return true;
        if (parsed.searchParams.get("v")) return true;
        return /\/(shorts|live|embed|clip)\/[\w-]+/i.test(parsed.pathname) ||
          /\/watch/i.test(parsed.pathname);
      } catch {
        return /[?&]v=|\/shorts\/[\w-]+|youtu\.be\/[\w-]+/i.test(url);
      }
    }
    if (isTiktokUrl(url)) {
      if (/vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) return true;
      return /\/@[\w.-]+\/video\/\d+|\/video\/\d+|\/t\//i.test(url);
    }
    if (isInstagramHostUrl(url)) return isInstagramPostUrl(url);
    if (isXUrl(url)) return true;
    if (isFacebookUrl(url)) {
      try {
        const parsed = new URL(url);
        if (hostOf(url) === "fb.watch") return true;
        return /\/(watch|reel|reels|videos|share|story\.php|posts)\b/i.test(parsed.pathname) ||
          parsed.searchParams.has("v");
      } catch {
        return /facebook\.com\/(watch|reel|videos)|fb\.watch\//i.test(url);
      }
    }
    return isBilibiliUrl(url);
  }

  function siteLabel(url, item = {}) {
    const value = url || item.url || item.pageUrl || "";
    const kind = item.site || siteKind(value, value);
    const names = {
      youtube: "YouTube",
      tiktok: "TikTok",
      instagram: "Instagram",
      x: "X",
      facebook: "Facebook",
      bilibili: "Bilibili"
    };
    return names[kind] || null;
  }

  function buildSiteItem(tab, fallbackUrl = "") {
    const pageUrl = tab?.url || fallbackUrl || "";
    if (!isDownloadableSiteVideo(pageUrl)) return null;
    const kind = siteKind(pageUrl, pageUrl);
    if (!kind) return null;
    let title = String(tab?.title || "")
      .replace(/^\(\d{1,4}\)\s*/, "")
      .replace(/\s*[-–—|]\s*(YouTube|TikTok|Instagram|X|Twitter|Facebook|bilibili)\s*$/i, "")
      .replace(/\s*[-–—|].*$/, "")
      .trim();
    if (!title || /^(youtube|tiktok|instagram|x|twitter|facebook|bilibili)$/i.test(title)) {
      title = siteDefaultTitle(kind);
    }
    const youtubeId = kind === "youtube" ? youtubeVideoId(pageUrl) : "";
    const thumbnail = youtubeId ? youtubeThumbnailForUrl(pageUrl) : "";
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
      filename: `${safeBase || siteLabel(pageUrl) || "영상"}.mp4`,
      thumbnail: thumbnail || undefined,
      provisionalIdentitySafe: !!youtubeId,
      quality: "",
      format: "MP4",
      host: hostOf(pageUrl) || kind
    };
  }

  return {
    hostOf,
    registrableDomain,
    isSameRegistrableSite,
    isKnownCodeHost,
    isKnownVideoCdnHost,
    isTrustedThumbUrl,
    isYoutubeUrl,
    youtubeVideoId,
    youtubeThumbnailForUrl,
    isTiktokUrl,
    isInstagramHostUrl,
    isInstagramPostUrl,
    isInstagramUrl,
    isInstagramCdnUrl,
    collectInstagramMediaUrlsFromText,
    isTiktokCdnUrl,
    looksLikeVideoFileUrl,
    isXUrl,
    isFacebookUrl,
    isBilibiliUrl,
    needsYtDlpHelper,
    siteKind,
    siteDefaultTitle,
    isDownloadableSiteVideo,
    siteLabel,
    buildSiteItem
  };
});
