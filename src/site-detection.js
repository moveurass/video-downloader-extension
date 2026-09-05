(function initSiteDetection(root, factory) {
  const api = factory();
  root.UVDSites = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSiteDetection() {
  "use strict";

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
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

  function isInstagramPostUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "instagr.am") return (parsed.pathname || "/").length > 2;
      if (host === "instagram.com" || host.endsWith(".instagram.com")) {
        return /\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(parsed.pathname || "");
      }
    } catch {
      // Fall through to the conservative string check.
    }
    return /instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(url);
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
    isYoutubeUrl,
    youtubeVideoId,
    youtubeThumbnailForUrl,
    isTiktokUrl,
    isInstagramHostUrl,
    isInstagramPostUrl,
    isInstagramUrl,
    isInstagramCdnUrl,
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
