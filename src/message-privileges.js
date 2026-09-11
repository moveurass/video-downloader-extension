(function initMessagePrivileges(root, factory) {
  const api = factory();
  root.UVDMessagePrivileges = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeMessagePrivileges() {
  "use strict";

  /**
   * Content scripts may only report page facts and stream save chunks.
   * Settings, helper, queue control, backups, and thumbs stay on extension pages.
   */
  const CONTENT_MESSAGE_TYPES = new Set([
    "PAGE_MEDIA",
    "PAGE_META",
    "HLS_PROGRESS",
    "VIDEO_CHUNK",
    "VIDEO_CHUNK_FINISH"
  ]);

  function senderUrl(sender) {
    return String(sender?.url || sender?.origin || sender?.tab?.url || "");
  }

  function isExtensionSender(sender) {
    const url = senderUrl(sender);
    if (url.startsWith("chrome-extension://")) return true;
    // Popup / SW messages have no tab. A content script always has sender.tab.
    return !sender?.tab;
  }

  function isContentScriptSender(sender) {
    if (!sender?.tab) return false;
    const url = senderUrl(sender);
    if (url.startsWith("chrome-extension://")) return false;
    return true;
  }

  function senderMaySend(type, sender) {
    if (CONTENT_MESSAGE_TYPES.has(type)) return true;
    return isExtensionSender(sender);
  }

  return {
    CONTENT_MESSAGE_TYPES,
    senderUrl,
    isExtensionSender,
    isContentScriptSender,
    senderMaySend
  };
});
