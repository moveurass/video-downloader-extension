(function initBackgroundMediaUtils(root, factory) {
  const api = factory();
  root.UVDBackgroundMediaUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeMediaUtils() {
  "use strict";

  function qualityLabel(height) {
    const value = height || 0;
    if (value >= 2160) return "4K";
    if (value >= 1440) return "1440p";
    if (value >= 1080) return "1080p";
    if (value >= 720) return "720p";
    if (value >= 480) return "480p";
    if (value >= 360) return "360p";
    if (value > 0) return `${value}p`;
    return null;
  }

  function hashUrl(url) {
    let hash = 0;
    for (let index = 0; index < url.length; index += 1) {
      hash = (Math.imul(31, hash) + url.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  function createAlternativeSelector(deps) {
    return function bestNonBlobAlternative(tabId, excludeUrl) {
      const items = deps.getTabItems(tabId).filter(
        (item) =>
          item.url &&
          item.url !== excludeUrl &&
          !item.url.startsWith("blob:") &&
          !deps.Naming.isJunkMedia(item)
      );
      items.sort((first, second) => {
        if (typeof deps.Naming.compareMediaCandidates === "function") {
          const ranked = deps.Naming.compareMediaCandidates(first, second);
          if (ranked) return ranked;
        } else {
          const duration = (item) =>
            typeof item.duration === "number" && item.duration > 0
              ? item.duration
              : 0;
          const durDelta = duration(second) - duration(first);
          if (durDelta) return durDelta;
          const heightDelta =
            (Number(second.height) || 0) - (Number(first.height) || 0);
          if (heightDelta) return heightDelta;
          const bytes = (item) =>
            Number(item.estimatedSize || item.size) || 0;
          const sizeDelta = bytes(second) - bytes(first);
          if (sizeDelta) return sizeDelta;
          const segDelta =
            (Number(second.segmentCount) || 0) -
            (Number(first.segmentCount) || 0);
          if (segDelta) return segDelta;
        }
        const score = (item) =>
          (/\.m3u8/i.test(item.url || "") ? 500 : 0) +
          deps.Naming.mediaScore(item);
        return score(second) - score(first);
      });
      return items[0] || null;
    };
  }

  return { qualityLabel, hashUrl, createAlternativeSelector };
});
