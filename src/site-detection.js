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
  function isTikTokImageCdnHost(host) {
    const h = String(host || "")
      .replace(/^www\./i, "")
      .toLowerCase();
    if (!h) return false;
    return (
      /(?:^|\.)tiktokcdn(?:-[a-z0-9]+)?\.com$/i.test(h) ||
      /(?:^|\.)ibyteimg\.com$/i.test(h) ||
      /(?:^|\.)byteicdn\.com$/i.test(h) ||
      /(?:^|\.)byteoversea\.com$/i.test(h) ||
      /(?:^|\.)muscdn\.com$/i.test(h) ||
      /(?:^|\.)tiktokv\.com$/i.test(h)
    );
  }

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
    // TikTok covers live on ByteDance image CDNs (often no .jpg in the path).
    // Explore/FYP tabs are still first-party TikTok, so page-credentialed
    // FETCH_THUMB_PAGE must be allowed for those hosts.
    if (isTiktokUrl(pageUrl) && isTikTokImageCdnHost(imageHost)) return true;
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

  const TIKTOK_NEED_PERMALINK =
    "TikTok 탐색·팔로잉·라이브·검색 페이지는 받을 수 없습니다. /@사용자/video/숫자 또는 공유 링크를 붙여 넣어 주세요";

  const TIKTOK_NON_VIDEO_SEGMENTS = new Set([
    "explore",
    "foryou",
    "following",
    "live",
    "search",
    "discover",
    "feedback",
    "messages",
    "activity"
  ]);

  function tiktokPermalinkError() {
    return TIKTOK_NEED_PERMALINK;
  }

  function tiktokPathname(url) {
    try {
      return new URL(url).pathname || "/";
    } catch {
      return "";
    }
  }

  function isTiktokShareUrl(url) {
    if (!isTiktokUrl(url)) return false;
    const host = hostOf(url);
    const path = tiktokPathname(url);
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
      return /\/[A-Za-z0-9]+\/?$/.test(path) && path !== "/";
    }
    return /\/t\/[A-Za-z0-9]+/i.test(path);
  }

  function isTiktokCanonicalVideoUrl(url) {
    if (!isTiktokUrl(url) || isTiktokShareUrl(url)) return false;
    return /\/@[\w.-]+\/video\/\d+|\/video\/\d+/i.test(tiktokPathname(url) || url);
  }

  function isTiktokVideoUrl(url) {
    if (!isTiktokUrl(url)) return false;
    return isTiktokCanonicalVideoUrl(url) || isTiktokShareUrl(url);
  }

  function isTiktokNonVideoSurface(url) {
    if (!isTiktokUrl(url) || isTiktokVideoUrl(url)) return false;
    const path = (tiktokPathname(url) || "/").replace(/\/+$/, "") || "/";
    if (path === "/") return true;
    const first = path.split("/").filter(Boolean)[0] || "";
    return TIKTOK_NON_VIDEO_SEGMENTS.has(first.toLowerCase());
  }

  function tiktokVideoId(url) {
    const match = String(url || "").match(/\/(?:@[^/?#]+\/)?video\/(\d+)/i);
    return match ? match[1] : "";
  }

  function tiktokShareCode(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const path = parsed.pathname || "";
      if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
        return path.replace(/^\/|\/$/g, "");
      }
      return path.match(/\/t\/([A-Za-z0-9]+)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function sameTiktokVideo(left, right) {
    const idA = tiktokVideoId(left);
    const idB = tiktokVideoId(right);
    if (idA && idB) return idA === idB;
    const codeA = tiktokShareCode(left);
    const codeB = tiktokShareCode(right);
    return !!(codeA && codeB && codeA.toLowerCase() === codeB.toLowerCase());
  }

  function normalizeTiktokUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      parsed.search = "";
      parsed.hash = "";
      if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
        if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
        return parsed.href;
      }
      const path = parsed.pathname || "/";
      const video = path.match(/(\/@[\w.-]+\/video\/\d+)/i);
      const share = path.match(/(\/t\/[A-Za-z0-9]+)/i);
      const bare = path.match(/(\/video\/\d+)/i);
      if (video) parsed.pathname = video[1];
      else if (share) parsed.pathname = share[1];
      else if (bare) parsed.pathname = bare[1];
      if (/tiktok\.com$/i.test(host) && host !== "vm.tiktok.com" && host !== "vt.tiktok.com") {
        parsed.hostname = "www.tiktok.com";
      }
      return parsed.href;
    } catch {
      return raw;
    }
  }

  function preferDownloadTargetUrl(targetUrl, tabUrl) {
    const target = String(targetUrl || "").trim();
    const tab = String(tabUrl || "").trim();
    if (isTiktokVideoUrl(target)) return normalizeTiktokUrl(target);
    if (isTiktokUrl(target)) return normalizeTiktokUrl(target);
    if (isTiktokVideoUrl(tab) && !target) return normalizeTiktokUrl(tab);
    return target || tab;
  }

  const TIKTOK_COVER_KEYS = new Set([
    "cover",
    "origincover",
    "origin_cover",
    "origincov",
    "dynamiccover",
    "dynamic_cover",
    "zoomcover",
    "zoom_cover",
    "sharecover",
    "share_cover",
    "thumbnail",
    "thumbnailurl",
    "thumbnail_url",
    "poster",
    "coverurl",
    "cover_url"
  ]);

  const TIKTOK_AVATAR_OBJECT_KEYS = new Set([
    "author",
    "authorstats",
    "authorinfo",
    "user",
    "uniqueid",
    "avatarthumb",
    "avatarmedium",
    "avatarlarger",
    "avatar300x300",
    "avatar168x168",
    "avatar100x100",
    "imprint",
    "verifiedinfo",
    "followstatus"
  ]);

  function isTiktokAvatarThumbUrl(url) {
    const value = String(url || "").trim();
    if (!value || value.startsWith("data:")) return false;
    const hay = value.toLowerCase();
    if (
      /avatar|user-avatar|imprint|follow[-_]?btn|\/avt[-_/]|-avt-|tos-[a-z0-9-]*avt[-_]/i.test(
        hay
      )
    ) {
      return true;
    }
    const crop = hay.match(/cropcenter:(\d+):(\d+)/i);
    if (crop) {
      const width = Number(crop[1]);
      const height = Number(crop[2]);
      const max = Math.max(width, height);
      if (
        width &&
        height &&
        max > 0 &&
        Math.abs(width - height) / max < 0.08 &&
        width <= 1080 &&
        /avt|avatar|imprint/i.test(hay)
      ) {
        return true;
      }
    }
    return false;
  }

  function tiktokCoverKeyScore(key) {
    const kl = String(key || "").toLowerCase();
    if (/origin_?cover|origincov/.test(kl)) return 50;
    if (/dynamic_?cover/.test(kl)) return 40;
    if (/zoom_?cover|photomode/.test(kl)) return 35;
    if (/share_?cover/.test(kl)) return 25;
    if (kl === "cover" || kl === "coverurl" || kl === "cover_url") return 20;
    if (/thumb|poster/.test(kl)) return 10;
    return 1;
  }

  function isTiktokVideoCoverThumbUrl(url) {
    const value = String(url || "").trim();
    if (!value || isTiktokAvatarThumbUrl(value)) return false;
    const hay = value.toLowerCase();
    if (
      /origincov|origin_cover|dynamiccover|dynamic_cover|zoomcover|zoom_cover|sharecover|share_cover|photomode|tplv-[a-z0-9-]*cover/i.test(
        hay
      )
    ) {
      return true;
    }
    if (/\/tos-[a-z0-9-]+-p-\d+/i.test(hay)) return true;
    return /tiktokcdn|byteicdn|ibyteimg|byteoversea|muscdn/i.test(hay);
  }

  function tiktokCoverUrlScore(url) {
    const hay = String(url || "").toLowerCase();
    if (!hay) return 0;
    if (/origin_?cover|origincov|tplv-[a-z0-9-]*origin/.test(hay)) return 50;
    if (/dynamic_?cover|dcover/.test(hay)) return 40;
    if (/zoom_?cover|photomode/.test(hay)) return 35;
    if (/share_?cover/.test(hay)) return 25;
    if (/\/cover(?:[/?#]|$)|tplv-[a-z0-9-]*cover/.test(hay)) return 20;
    return 1;
  }

  function collectTiktokCoverUrls(value, out, score) {
    if (!value) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) out.push({ url: value, score });
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 20)) {
        collectTiktokCoverUrls(entry, out, score);
      }
      return;
    }
    if (typeof value !== "object") return;
    if (typeof value.url === "string") {
      collectTiktokCoverUrls(value.url, out, score);
    }
    if (Array.isArray(value.url_list)) {
      collectTiktokCoverUrls(value.url_list, out, score);
    }
    if (Array.isArray(value.urlList)) {
      collectTiktokCoverUrls(value.urlList, out, score);
    }
  }

  function walkTiktokCoverCandidates(obj, out, depth, inAvatarBranch) {
    if (!obj || depth > 35) return;
    if (typeof obj === "string") return;
    if (Array.isArray(obj)) {
      for (const entry of obj.slice(0, 200)) {
        walkTiktokCoverCandidates(entry, out, depth + 1, inAvatarBranch);
      }
      return;
    }
    if (typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      const kl = String(key).toLowerCase();
      const avatarBranch =
        inAvatarBranch ||
        TIKTOK_AVATAR_OBJECT_KEYS.has(kl) ||
        kl.startsWith("avatar");
      if (avatarBranch) {
        walkTiktokCoverCandidates(value, out, depth + 1, true);
        continue;
      }
      if (TIKTOK_COVER_KEYS.has(kl)) {
        collectTiktokCoverUrls(value, out, tiktokCoverKeyScore(kl));
      }
      walkTiktokCoverCandidates(value, out, depth + 1, false);
    }
  }

  function pickTiktokCoverFromCandidates(candidates) {
    const list = (Array.isArray(candidates) ? candidates : [])
      .map((entry) => {
        if (typeof entry === "string") return { url: entry, score: 1 };
        return {
          url: String(entry?.url || ""),
          score: Number(entry?.score) || 1
        };
      })
      .filter((entry) => entry.url && !isTiktokAvatarThumbUrl(entry.url));
    if (!list.length) return "";
    list.sort((left, right) => {
      const rightTotal =
        (right.score || 0) + tiktokCoverUrlScore(right.url);
      const leftTotal = (left.score || 0) + tiktokCoverUrlScore(left.url);
      if (rightTotal !== leftTotal) return rightTotal - leftTotal;
      return (
        Number(isTiktokVideoCoverThumbUrl(right.url)) -
        Number(isTiktokVideoCoverThumbUrl(left.url))
      );
    });
    return list[0].url;
  }

  function pickTiktokCoverFromPageData(data) {
    const found = [];
    walkTiktokCoverCandidates(data, found, 0, false);
    return pickTiktokCoverFromCandidates(found);
  }

  function preferTiktokPreviewThumbnail(current, candidate, opts = {}) {
    const cur = String(current || "").trim();
    const next = String(candidate || "").trim();
    if (isTiktokAvatarThumbUrl(next)) {
      return isTiktokAvatarThumbUrl(cur) ? "" : cur;
    }
    if (!next) {
      return isTiktokAvatarThumbUrl(cur) ? "" : cur;
    }
    if (opts.fromFormats) return next;
    if (isTiktokAvatarThumbUrl(cur)) return next;
    if (cur.startsWith("data:image/")) return cur;
    if (!cur) return next;
    if (isTiktokVideoCoverThumbUrl(next) && !isTiktokVideoCoverThumbUrl(cur)) {
      return next;
    }
    return cur;
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

  function decodeInstagramEfg(efg) {
    const raw = String(efg || "");
    if (!raw) return "";
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    try {
      if (typeof atob === "function") return atob(withPad);
      if (typeof Buffer !== "undefined") {
        return Buffer.from(withPad, "base64").toString("binary");
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  function instagramEfgLooksLikeDash(url) {
    try {
      const efg = new URL(url).searchParams.get("efg");
      if (!efg) return false;
      if (/dash/i.test(efg)) return true;
      return /dash/i.test(decodeInstagramEfg(efg));
    } catch {
      return /[?&]efg=[^&]*(?:dash|Rhc2h|ZGFza)/i.test(url || "");
    }
  }

  function isInstagramDashFragmentUrl(url) {
    const value = url || "";
    if (!/^https?:/i.test(value)) return false;
    if (/\.(?:m4s|mpd)(?:\?|$)/i.test(value)) return true;
    if (/(?:^|[/_-])(?:init|init-stream|dashinit|dash_init)(?:[._-]|\.mp4)/i.test(value)) {
      return true;
    }
    if (/[?&](?:bytestart|byteend|start_byte|end_byte)=/i.test(value)) return true;
    if (/\/dash(?:\/|_)/i.test(value)) return true;
    if (/[?&](?:cmfaz|fragment_type|dash_manifest)=/i.test(value)) return true;
    return instagramEfgLooksLikeDash(value);
  }

  function isInstagramCdnUrl(url) {
    const value = url || "";
    if (!/^https?:/i.test(value)) return false;
    if (isInstagramDashFragmentUrl(value)) return false;
    if (/\.(jpe?g|png|gif|webp|bmp|svg|js|css|mpd|m4s)(\?|$)/i.test(value)) return false;
    return (
      (/cdninstagram\.com|fbcdn\.net/i.test(value) &&
        (/\.mp4(\?|$)/i.test(value) || /video|\/v\/t/i.test(value))) ||
      (/\.mp4(\?|$)/i.test(value) && /instagram/i.test(value))
    );
  }

  function instagramMediaUrlScore(url) {
    const value = String(url || "");
    if (!isInstagramCdnUrl(value)) return -1;
    let score = 10;
    if (/browser_native_hd/i.test(value)) score += 50;
    if (/browser_native_sd/i.test(value)) score += 35;
    try {
      const efg = new URL(value).searchParams.get("efg") || "";
      const decoded = decodeInstagramEfg(efg);
      if (/progressive/i.test(efg) || /progressive/i.test(decoded)) score += 30;
    } catch {
      if (/[?&]efg=[^&]*progressive/i.test(value)) score += 30;
    }
    if (/\.mp4(\?|$)/i.test(value)) score += 20;
    if (/\/o1\/v\/t16\//i.test(value)) score += 8;
    return score;
  }

  function rankInstagramMediaUrls(urls) {
    const seen = new Set();
    return (urls || [])
      .map((url) => String(url || "").split("#")[0])
      .filter((url) => {
        if (!url || seen.has(url) || instagramMediaUrlScore(url) < 0) return false;
        seen.add(url);
        return true;
      })
      .sort((a, b) => instagramMediaUrlScore(b) - instagramMediaUrlScore(a));
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
    if (isInstagramDashFragmentUrl(url)) return false;
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
    if (isTiktokUrl(url)) return isTiktokVideoUrl(url);
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
    isTikTokImageCdnHost,
    isTrustedThumbUrl,
    isYoutubeUrl,
    youtubeVideoId,
    youtubeThumbnailForUrl,
    isTiktokUrl,
    isTiktokShareUrl,
    isTiktokCanonicalVideoUrl,
    isTiktokVideoUrl,
    isTiktokNonVideoSurface,
    tiktokVideoId,
    tiktokShareCode,
    sameTiktokVideo,
    normalizeTiktokUrl,
    preferDownloadTargetUrl,
    isTiktokAvatarThumbUrl,
    isTiktokVideoCoverThumbUrl,
    pickTiktokCoverFromCandidates,
    pickTiktokCoverFromPageData,
    preferTiktokPreviewThumbnail,
    tiktokPermalinkError,
    isInstagramHostUrl,
    isInstagramPostUrl,
    isInstagramUrl,
    isInstagramCdnUrl,
    isInstagramDashFragmentUrl,
    rankInstagramMediaUrls,
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
