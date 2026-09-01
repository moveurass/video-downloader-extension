(function initDirectDownloadMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundDirectDownloadMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDirectDownloadMessages() {
  "use strict";

  function createHandler(deps) {
    return function handleDirectDownloadMessage(msg, tabId, sendResponse) {
      if (msg?.type !== "DOWNLOAD" && msg?.type !== "DOWNLOAD_HLS") {
        return { handled: false, keepChannel: false };
      }

      const url = msg.url;
      const tid = msg.tabId ?? tabId;
      const pageUrl = msg.pageUrl || url;
      const item = tid != null ? deps.getTabMap(tid).get(url) : null;
      // Bind title/filename to THIS request only — ignore later tab navigation
      const boundTitle =
        deps.Naming.cleanPageTitle?.(msg.title || item?.title || item?.pageTitle || "") ||
        msg.title ||
        item?.title ||
        item?.pageTitle ||
        "";
      const fname = deps.lockSaveName({
        filenameHint: msg.filename || item?.filename || "",
        title: boundTitle,
        pageTitle: boundTitle,
        quality: msg.preferQuality || item?.quality || "",
        mediaMode: "video",
        pageUrl: pageUrl || item?.pageUrl || url
      });
      const mediaType =
        msg.mediaType ||
        item?.type ||
        (deps.isHlsUrl(url) ||
        /\.mpd(\?|$|#)/i.test(url || "") ||
        msg.type === "DOWNLOAD_HLS"
          ? "stream"
          : "video");

      const preferYtDlp =
        msg.preferYtDlp === true ||
        item?.isSiteDownload ||
        deps.needsYtDlpHelper(url, pageUrl || item?.pageUrl);

      const niceTitle =
        boundTitle ||
        (fname ? String(fname).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "") : "") ||
        "영상";

      // Snapshot item fields so long downloads don't pick up another video's meta
      const boundItem = {
        ...(item || {}),
        url,
        type: mediaType,
        isHls:
          deps.isHlsUrl(url) ||
          /\.mpd(\?|$|#)/i.test(url || "") ||
          mediaType === "stream",
        pageUrl: pageUrl || item?.pageUrl || url,
        title: boundTitle || item?.title,
        pageTitle: boundTitle || item?.pageTitle,
        filename: fname || item?.filename,
        quality: msg.preferQuality || item?.quality
      };

      deps.runTrackedDownload(
        {
          tabId: tid,
          title: niceTitle,
          pageUrl: pageUrl || item?.pageUrl || url,
          mediaUrl: url || "",
          filename: fname,
          quality: msg.preferQuality || "best"
        },
        async (jobId) => {
          let workTab = tid;
          let opened = false;
          // For HLS from watchlist: open the original page so Referer/cookies work (123av etc.)
          if (
            msg.openPageIfNeeded &&
            pageUrl &&
            /^https?:/i.test(pageUrl) &&
            (deps.isHlsUrl(url) || mediaType === "stream")
          ) {
            try {
              const found = await deps.findOrOpenTabForPage(pageUrl, tid);
              workTab = found.tabId;
              opened = found.opened;
            } catch {
              /* continue with original tab */
            }
          }
          try {
            const r = await deps.downloadSmart(
              workTab,
              url,
              fname,
              msg.preferQuality || "best",
              mediaType,
              boundItem,
              {
                pageUrl,
                preferYtDlp,
                jobId
              }
            );
            if (r?.method === "yt-dlp" || r?.ytdlp) {
              return { ...r, filename: r.filename || fname };
            }
            if (r == null || r.downloadId == null) {
              throw new Error(
                r?.error ||
                  "파일이 저장되지 않았습니다. chrome://downloads 를 확인해 주세요"
              );
            }
            return { ...r, filename: r.filename || fname };
          } finally {
            if (opened && workTab != null) {
              try {
                await new Promise((resolve) => deps.setTimeout(resolve, 400));
                await deps.chrome.tabs.remove(workTab);
              } catch {
                /* ignore */
              }
            }
          }
        },
        sendResponse
      );

      return { handled: true, keepChannel: true };
    };
  }

  return { createHandler };
});
