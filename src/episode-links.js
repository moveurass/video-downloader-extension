(function initEpisodeLinks(root, factory) {
  const api = factory();
  root.UVDEpisodeLinks = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeEpisodeLinks() {
  "use strict";

  /**
   * Collect episode page links from a known-code site's LIST page
   * (series / genre / tag listing). The caller passes flattened anchors —
   * content.js maps `document.querySelectorAll("a[href]")` into
   * `{ href, text, alt }` — and this module keeps only absolute URLs that
   * classify as video watch pages, deduped in document order.
   *
   * Options: `min` (below this the caller should stay quiet) and `max`
   * (cap on returned entries). Defaults: 5 / 60.
   */
  function collectFromAnchors(anchors, selfUrl, options = {}, naming = null) {
    const globalScope = typeof globalThis !== "undefined" ? globalThis : null;
    const Naming =
      naming || (globalScope && globalScope.Naming) || null;
    if (!Naming || typeof Naming.isKnownCodeVideoPage !== "function") {
      return [];
    }
    const min = Math.max(1, Number(options.min) || 5);
    const max = Math.max(min, Number(options.max) || 60);
    const selfKey = urlKey(selfUrl);
    const seen = new Set();
    const episodes = [];
    for (const anchor of anchors || []) {
      const href = String(anchor?.href || "");
      if (!/^https?:\/\//i.test(href)) continue;
      if (!Naming.isKnownCodeVideoPage(href)) continue;
      const key = urlKey(href);
      if (!key || key === selfKey || seen.has(key)) continue;
      seen.add(key);
      episodes.push({
        url: href,
        title: cleanTitle(anchor, Naming),
        code: Naming.extractProductCode?.(href) || ""
      });
      if (episodes.length >= max) break;
    }
    return episodes.length >= min ? episodes : [];
  }

  /** Canonical identity of an episode link: origin + path, no query/hash. */
  function urlKey(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return "";
    }
  }

  function cleanTitle(anchor, Naming) {
    const text = String(anchor?.text || "").trim();
    const cleaned = text ? Naming.cleanPageTitle?.(text) || "" : "";
    if (cleaned && cleaned.length >= 2) return cleaned;
    const alt = String(anchor?.alt || "").trim();
    return alt ? Naming.cleanPageTitle?.(alt) || "" : "";
  }

  /** Loose identity shared with history entries: host + trimmed path. */
  function looseKey(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./i, "")}${
        parsed.pathname.replace(/\/+$/, "")
      }`.toLowerCase();
    } catch {
      return String(url || "").trim().toLowerCase();
    }
  }

  /**
   * Mark episodes whose page already appears in download history with
   * `downloaded: true` — the series banner renders a 받음 chip and unchecks
   * them automatically. Matching is by host+path so query strings differ.
   */
  function markDownloaded(episodes, history) {
    const keys = new Set();
    for (const item of history || []) {
      for (const url of [item?.url, item?.pageUrl]) {
        const key = looseKey(url);
        if (key) keys.add(key);
      }
    }
    return (episodes || []).map((episode) => {
      if (keys.has(looseKey(episode?.url))) {
        return { ...episode, downloaded: true };
      }
      return episode;
    });
  }

  /**
   * Merge freshly crawled episodes into the current set: existing entries
   * win, new ones append, duplicates collapse by urlKey, total capped.
   */
  function mergeEpisodes(existing, added, options = {}) {
    const max = Math.max(1, Number(options.max) || 60);
    const seen = new Set();
    const merged = [];
    for (const episode of [...(existing || []), ...(added || [])]) {
      const key = urlKey(episode?.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(episode);
    }
    return merged.slice(0, max);
  }

  return { collectFromAnchors, urlKey, markDownloaded, mergeEpisodes };
});
