(function initDownloadRouting(root, factory) {
  const api = factory(root.UVDSites);
  root.UVDDownloadRouting = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeRouting(Sites) {
  "use strict";

  if (!Sites && typeof require === "function") {
    Sites = require("./site-detection.js");
  }

  function shouldUseHelper({ url, pageUrl, item, preferHelper = false }) {
    return !!(
      preferHelper ||
      item?.isSiteDownload ||
      item?.site === "youtube" ||
      item?.site === "tiktok" ||
      Sites.needsYtDlpHelper(url, pageUrl)
    );
  }

  /**
   * @param {boolean} tryPageFirst site heuristics prefer page-context fetches
   * @param {{hasCheckpoint?: boolean}} [options] only the worker path can reuse
   *   IndexedDB segment checkpoints, so a resumed job must start there.
   */
  function hlsAttemptOrder(tryPageFirst, options = {}) {
    if (options.hasCheckpoint) return ["worker", "page"];
    return tryPageFirst ? ["page", "worker"] : ["worker", "page"];
  }

  function isLikelyHls(url, mediaType) {
    const value = String(url || "");
    return (
      mediaType === "stream" ||
      /\.m3u8(?:[?#]|$)/i.test(value) ||
      (/m3u8/i.test(value) && /playlist|format=m3u8/i.test(value))
    );
  }

  return { shouldUseHelper, hlsAttemptOrder, isLikelyHls };
});
