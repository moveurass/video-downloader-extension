(function initDownloadMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundDownloadMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDownloadMessages() {
  "use strict";

  function createHandler(deps) {
    async function startPageDownload(message, tabId, sendResponse) {
      const pageUrl = message.pageUrl || message.url;
      if (message.type === "DOWNLOAD_PAGE" && !pageUrl) {
        sendResponse({ ok: false, error: "페이지 주소가 없습니다" });
        return false;
      }
      if (message.type === "DOWNLOAD_PAGE" && !/^https?:\/\//i.test(pageUrl)) {
        sendResponse({ ok: false, error: "http(s) 링크만 가능합니다" });
        return false;
      }
      try {
        const settings = await deps.UVD.getSettings();
        const displayTitle =
          (message.title &&
            !deps.UVD.isGenericSaveName(message.title) &&
            (deps.Naming.cleanPageTitle?.(message.title) || message.title)) ||
          "";
        const filename = deps.lockSaveName({
          filenameHint: message.filename || "",
          title: displayTitle || message.title || "",
          pageTitle: displayTitle || message.title || "",
          quality: message.preferQuality,
          mediaMode: settings.mediaMode,
          pageUrl
        });
        const title =
          displayTitle ||
          (filename ? String(filename).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "") : "") ||
          "영상";
        deps.runTrackedDownload(
          {
            tabId,
            title,
            pageUrl,
            filename: filename || "",
            mediaMode: settings.mediaMode,
            quality: message.preferQuality || "best",
            audioTrackId: message.audioTrackId || "",
            subtitleLanguages: Array.isArray(message.subtitleLanguages)
              ? message.subtitleLanguages
              : []
          },
          async (jobId, runGeneration) => {
            const result = await deps.downloadPageFromUi(
              tabId,
              pageUrl,
              message.preferQuality || "best",
              jobId,
              {
                mediaMode: settings.mediaMode,
                mediaUrl: message.mediaUrl || "",
                title: message.title || title,
                filename: filename || "",
                ...(runGeneration != null ? { runGeneration } : {}),
                audioTrackId: message.audioTrackId || "",
                subtitleLanguages: Array.isArray(message.subtitleLanguages)
                  ? message.subtitleLanguages
                  : []
              }
            );
            if (message.type === "DOWNLOAD_PAGE" && result?.ok === false) {
              throw new Error(result.error || "다운로드 실패");
            }
            return { ...result, filename: result?.filename || filename };
          },
          sendResponse
        );
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return true;
    }

    return function handleDownloadMessage(message, tabId, sendResponse) {
      if (message?.type !== "DOWNLOAD_PAGE" && message?.type !== "DOWNLOAD_CURRENT_PAGE") {
        return { handled: false, keepChannel: false };
      }
      startPageDownload(message, message.tabId ?? tabId, sendResponse);
      return { handled: true, keepChannel: true };
    };
  }

  return { createHandler };
});
