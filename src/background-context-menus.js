(function initBackgroundContextMenus(root, factory) {
  const api = factory();
  root.UVDBackgroundContextMenus = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeContextMenus() {
  "use strict";

  function createController(deps) {
    let bound = false;

    function setupContextMenus() {
      deps.chrome.contextMenus.removeAll(() => {
        deps.chrome.contextMenus.create({
          id: "uvd-download-media",
          title: "이 미디어 다운로드",
          contexts: ["video", "audio"]
        });
        deps.chrome.contextMenus.create({
          id: "uvd-download-best",
          title: "이 페이지 영상 다운로드",
          contexts: ["page", "frame"]
        });
        deps.chrome.contextMenus.create({
          id: "uvd-download-link",
          title: "이 링크 영상 다운로드",
          contexts: ["link"]
        });
        deps.chrome.contextMenus.create({
          id: "uvd-download-selection",
          title: "선택한 링크로 영상 다운로드",
          contexts: ["selection"]
        });
      });
    }

    async function onClicked(info, tab) {
      const tabId = tab?.id;
      if (tabId == null) return;
      try {
        if (info.menuItemId === "uvd-download-media" && info.srcUrl) {
          deps.addMedia(tabId, {
            url: info.srcUrl,
            type: info.mediaType === "audio" ? "audio" : "video",
            source: "context-menu",
            title: tab.title || "",
            pageTitle: tab.title || "",
            pageUrl: tab.url || ""
          });
          const item = deps.getTabMap(tabId).get(info.srcUrl);
          const fname = deps.resolveFilename(tabId, item || {}, info.srcUrl);
          await deps.runTrackedDownloadAsync(
            {
              tabId,
              title: fname,
              pageUrl: tab.url,
              filename: fname
            },
            (jobId, runGeneration) =>
              deps.downloadSmart(
                tabId,
                info.srcUrl,
                fname,
                "best",
                item?.type || "video",
                item,
                { pageUrl: tab.url, jobId, runGeneration }
              )
          );
          return;
        }

        if (info.menuItemId === "uvd-download-link" && info.linkUrl) {
          await deps.runTrackedDownloadAsync(
            {
              tabId,
              title: "",
              pageUrl: info.linkUrl,
              filename: ""
            },
            (jobId, runGeneration) =>
              deps.downloadPageFromUi(
                tabId,
                info.linkUrl,
                "best",
                jobId,
                { runGeneration }
              )
          );
          return;
        }

        if (info.menuItemId === "uvd-download-selection" && info.selectionText) {
          const text = String(info.selectionText).trim();
          const m = text.match(/https?:\/\/[^\s]+/i);
          const link = m ? m[0] : text;
          if (!/^https?:\/\//i.test(link)) {
            throw new Error("선택한 텍스트에 링크가 없습니다");
          }
          await deps.runTrackedDownloadAsync(
            { tabId, title: "", pageUrl: link, filename: "" },
            (jobId, runGeneration) =>
              deps.downloadPageFromUi(
                tabId,
                link,
                "best",
                jobId,
                { runGeneration }
              )
          );
          return;
        }

        if (info.menuItemId === "uvd-download-best") {
          // Social page → dedicated download; else scan media list
          if (tab?.url && deps.needsYtDlpHelper(tab.url, tab.url)) {
            const filename = deps.lockSaveName({
              title: tab.title || "",
              pageTitle: tab.title || "",
              pageUrl: tab.url
            });
            await deps.runTrackedDownloadAsync(
              {
                tabId,
                title: tab.title || tab.url,
                pageUrl: tab.url,
                filename
              },
              (jobId, runGeneration) =>
                deps.downloadPageFromUi(
                  tabId,
                  tab.url,
                  "best",
                  jobId,
                  { runGeneration }
                )
            );
            return;
          }
          try {
            await deps.chrome.tabs.sendMessage(tabId, { type: "SCAN_NOW" });
          } catch {
            /* ignore */
          }
          await new Promise((resolve) => deps.setTimeout(resolve, 800));
          const best = (
            await deps.getMediaForTabAsync(tabId, { pageUrl: tab?.url })
          )[0];
          if (!best) throw new Error("감지된 영상이 없습니다");
          const filename =
            deps.resolveFilename(tabId, best, best.url) ||
            deps.lockSaveName({
              filenameHint: best.filename || "",
              title: best.title || best.pageTitle || tab.title || "",
              pageTitle: best.pageTitle || tab.title || "",
              pageUrl: tab.url,
              mediaUrl: best.url
            });
          await deps.runTrackedDownloadAsync(
            {
              tabId,
              title: best.title || best.filename,
              pageUrl: tab.url,
              filename
            },
            (jobId, runGeneration) =>
              deps.downloadSmart(
                tabId,
                best.url,
                filename,
                "best",
                best.type,
                best,
                { pageUrl: tab.url, jobId, runGeneration }
              )
          );
        }
      } catch (e) {
        deps.console.warn("[UVD] context menu", e);
        try {
          deps.chrome.notifications?.create?.({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "다운로드 실패",
            message: String(e?.message || e).slice(0, 120)
          });
        } catch {
          /* notifications optional */
        }
      }
    }

    function bind() {
      if (bound) return;
      bound = true;
      deps.chrome.runtime.onInstalled.addListener(setupContextMenus);
      deps.chrome.runtime.onStartup.addListener(setupContextMenus);
      setupContextMenus();
      deps.chrome.contextMenus.onClicked.addListener(onClicked);
    }

    return { setupContextMenus, onClicked, bind };
  }

  return { createController };
});
