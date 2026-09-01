(function initPopupSeriesUi(root, factory) {
  const api = factory();
  root.UVDPopupSeriesUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSeriesUi() {
  "use strict";

  function normalizeThumbSrc(src) {
    if (!src || typeof src !== "string") return "";
    const value = src.trim();
    if (!value) return "";
    if (value.startsWith("//")) return `https:${value}`;
    return /^(https?:|data:|blob:)/i.test(value) ? value : "";
  }

  function rewriteThumbForSeriesKey(thumbUrl, fromKey, toKey) {
    const source = normalizeThumbSrc(thumbUrl);
    if (!source || /^(data:|blob:)/.test(source) || !fromKey || !toKey || fromKey === toKey) {
      return "";
    }
    const variants = (key) => {
      const value = String(key);
      const lower = value.toLowerCase();
      const upper = value.toUpperCase();
      const compact = value.replace(/[-_]/g, "");
      return [
        value, lower, upper, lower.replace(/-/g, "_"), upper.replace(/-/g, "_"),
        lower.replace(/-/g, ""), upper.replace(/-/g, ""),
        compact.toLowerCase(), compact.toUpperCase()
      ];
    };
    const from = variants(fromKey);
    const to = variants(toKey);
    let output = source;
    let changed = false;
    from.forEach((value, index) => {
      if (value.length >= 3 && output.includes(value)) {
        output = output.split(value).join(to[index] || to[0]);
        changed = true;
      }
    });
    return changed && output !== source ? output : "";
  }

  function shortUrlDisplay(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const value = parsed.hostname.replace(/^www\./, "") +
        (parsed.pathname + parsed.search).replace(/\/+$/, "");
      return value.length > 48 ? `${value.slice(0, 46)}…` : value;
    } catch {
      return String(url).slice(0, 48);
    }
  }

  function isYouTubeVideoId(raw) {
    const id = String(raw || "").trim();
    if (!id || /^[A-Z]{2,12}[-_ ]?\d{2,6}$/i.test(id)) return false;
    if (/^(PL|UU|LL|FL|OL|RD|SD|UL)[\w-]{10,}$/i.test(id)) return false;
    return /^[\w-]{11}$/.test(id);
  }

  function youtubeVideoIdFromThumbUrl(url) {
    const match = String(url || "").match(
      /(?:ytimg\.com|img\.youtube\.com)\/vi\/([\w-]{11})\//i
    );
    return match && isYouTubeVideoId(match[1]) ? match[1] : "";
  }

  function youtubeVideoIdFromItem(item) {
    if (!item) return "";
    const tryId = (raw) => isYouTubeVideoId(raw) ? String(raw).trim() : "";
    let id = tryId(item.id) || tryId(item.key) || tryId(item.videoId);
    if (id) return id;
    const url = String(item.url || item.pageUrl || item.webpage_url || "");
    if (url) {
      if (tryId(url)) return tryId(url);
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
        if (host === "youtu.be") {
          id = tryId(parsed.pathname.replace(/^\//, "").split("/")[0]);
          if (id) return id;
        }
        if (/youtube\.com|youtube-nocookie\.com|music\.youtube\.com/.test(host)) {
          id = tryId(parsed.searchParams.get("v"));
          if (id) return id;
          const match = parsed.pathname.match(/\/(?:shorts|embed|live|v|watch)\/([\w-]{11})/i);
          if (match && tryId(match[1])) return match[1];
        }
      } catch {
        // Try conservative string matches below.
      }
      const query = url.match(/[?&]v=([\w-]{11})/i);
      if (query && tryId(query[1])) return query[1];
      const short = url.match(/youtu\.be\/([\w-]{11})/i);
      if (short && tryId(short[1])) return short[1];
    }
    return youtubeVideoIdFromThumbUrl(item.thumbnail);
  }

  function youtubePosterUrl(videoId, quality = "hqdefault") {
    return isYouTubeVideoId(videoId)
      ? `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`
      : "";
  }

  function normalizePlaylistEntry(entry, index = 0) {
    const raw = entry || {};
    let id =
      (isYouTubeVideoId(raw.id) && String(raw.id).trim()) ||
      (isYouTubeVideoId(raw.key) && String(raw.key).trim()) ||
      youtubeVideoIdFromItem(raw) ||
      "";
    let url = String(raw.url || raw.webpage_url || "").trim();
    if (id && (!url || !/^https?:/i.test(url))) {
      url = `https://www.youtube.com/watch?v=${id}`;
    } else if (url && !id) {
      id = youtubeVideoIdFromItem({ ...raw, url, id: "", key: "" }) || "";
    }
    return {
      title: raw.title || id || `영상 ${index + 1}`,
      url: url || raw.url || "",
      key: id || raw.key || raw.id || "",
      id: id || raw.id || "",
      duration: raw.duration || 0,
      thumbnail: id ? youtubePosterUrl(id) : normalizeThumbSrc(raw.thumbnail),
      uploader: raw.uploader || "",
      destNote: raw.destNote || "재생목록",
      selected: raw.selected !== false,
      softThumb: false
    };
  }

  function rangeLimit(pref) {
    if (pref === "all") return 999;
    const value = parseInt(pref, 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
  }

  function resolveSeriesId(payload, now = Date.now()) {
    if (payload?.seriesId) return String(payload.seriesId);
    if (payload?.mode === "product_code") {
      return `series:code:${payload.seriesKey || payload.seriesPrefix || "series"}`;
    }
    try {
      const list = new URL(payload?.listUrl || payload?.pageUrl || "").searchParams.get("list");
      if (list) return `series:pl:${list}`;
    } catch {
      // Fall through.
    }
    return `series:${now}`;
  }

  function buildVisibleItems(pending, history, annotate) {
    const all = pending?.allItems || pending?.items || [];
    let annotated = all;
    try {
      if (annotate) annotated = annotate(all, history || []);
    } catch {
      annotated = all;
    }
    const pool = pending?.missingOnly
      ? annotated.filter((item) => !item.downloaded)
      : annotated;
    const previous = new Map(
      (pending?.items || []).map((item, index) => [
        String(item.id || item.key || item.url || index),
        item.selected
      ])
    );
    const items = pool.slice(0, rangeLimit(pending?.rangePref)).map((item, index) => {
      const key = String(item.id || item.key || item.url || index);
      let selected = previous.has(key) ? previous.get(key) : item.selected;
      if (item.downloaded && !previous.has(key)) selected = false;
      if (selected == null) selected = !item.downloaded;
      if (pending?.missingOnly && !previous.has(key)) selected = true;
      return {
        ...item,
        index,
        seriesIndex: item.seriesIndex || index + 1,
        selected: selected !== false
      };
    });
    return { allItems: annotated, items };
  }

  return {
    normalizeThumbSrc,
    rewriteThumbForSeriesKey,
    shortUrlDisplay,
    isYouTubeVideoId,
    youtubeVideoIdFromThumbUrl,
    youtubeVideoIdFromItem,
    youtubePosterUrl,
    normalizePlaylistEntry,
    rangeLimit,
    resolveSeriesId,
    buildVisibleItems
  };
});
