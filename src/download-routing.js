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

  function hlsAttemptOrder(tryPageFirst) {
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
