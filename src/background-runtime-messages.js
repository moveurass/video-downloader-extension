(function initBackgroundRuntimeMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundRuntimeMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeRuntimeMessages() {
  "use strict";

  const DEDICATED_MESSAGE_TYPES = new Set([
    "SAVE_PAGE_DONE",
    "OFFSCREEN_SAVE",
    "OFFSCREEN_SAVE_IDB",
    "OFFSCREEN_CHUNK",
    "OFFSCREEN_FINISH"
  ]);

  function createDispatcher(deps) {
    function dispatch(message, sender, sendResponse) {
      if (DEDICATED_MESSAGE_TYPES.has(message?.type)) return false;

      const tabId = message.tabId ?? sender.tab?.id;
      const downloadMessage = deps.handleDownloadMessage(message, sendResponse);
      if (downloadMessage.handled) return downloadMessage.keepChannel;

      const routedMessage = deps.routeBackgroundMessage(message, sendResponse);
      if (routedMessage.handled) return routedMessage.keepChannel;

      if (message.type === "LIST_QUALITIES") {
        deps.handleQualityMessage(message, tabId)
          .then(sendResponse)
          .catch((error) =>
            sendResponse({
              ok: false,
              error: String(error?.message || error),
              qualities: [{ id: "best", label: "최고" }]
            })
          );
        return true;
      }

      for (const handler of [
        deps.handleBackgroundDownloadMessage,
        deps.handleBackgroundSeriesMessage,
        (msg, id, respond) => deps.handleMediaMessage(msg, id, sender, respond),
        deps.handleHelperMessage,
        (msg, _id, respond) => deps.handleChunkAssembly(msg, respond),
        deps.handleDirectDownloadMessage
      ]) {
        const result = handler(message, tabId, sendResponse);
        if (result.handled) return result.keepChannel;
      }
      return false;
    }

    return { dispatch };
  }

  return { createDispatcher, DEDICATED_MESSAGE_TYPES };
});
