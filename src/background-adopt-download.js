(function initBackgroundAdoptDownload(root, factory) {
  const api = factory();
  root.UVDBackgroundAdoptDownload = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeAdoptDownload() {
  "use strict";

  const MAX_TRACKED_IDS = 500;

  /**
   * The picked download folder only exists on the helper side — the
   * browser's chrome.downloads API cannot write outside its own Downloads
   * tree. Browser saves (HLS merges, small-file fallbacks) therefore land
   * in Downloads/<subfolder> first, and this watcher moves each completed
   * file into the picked folder via POST /adopt-download. Anything that
   * misses (helper down, TCC denial) keeps the legacy location, exactly
   * like before this feature existed.
   */
  function createManager(deps) {
    const { chrome, UVD, YtDlp } = deps;
    const adoptedIds = new Set();

    async function downloadById(id) {
      try {
        const [item] = await chrome.downloads.search({ id });
        return item || null;
      } catch {
        return null;
      }
    }

    function browserSaveMarker(subfolder) {
      return `/Downloads/${subfolder || "VideoDownloader"}/`;
    }

    async function maybeAdopt(downloadId) {
      if (adoptedIds.has(downloadId)) return;
      if (adoptedIds.size > MAX_TRACKED_IDS) adoptedIds.clear();
      const item = await downloadById(downloadId);
      if (!item?.filename) return;
      adoptedIds.add(downloadId);
      const settings = await UVD.getSettings().catch(() => ({}));
      const downloadDir = String(settings?.downloadDir || "");
      if (!downloadDir) return; // no picked folder — browser location is final
      const subfolder = String(settings?.subfolder || "VideoDownloader");
      // Never touch downloads outside our own browser-save tree
      if (!String(item.filename).includes(browserSaveMarker(subfolder))) {
        return;
      }
      const result = await YtDlp.adoptDownload(
        item.filename,
        subfolder,
        downloadDir
      ).catch(() => null);
      if (!result?.ok || !result?.moved) {
        console.warn(
          "[VideoDownloader] adopt skipped:",
          result?.error || "no move"
        );
      }
    }

    function attach() {
      chrome.downloads.onChanged.addListener((delta) => {
        if (delta?.state?.current !== "complete" || delta.id == null) return;
        Promise.resolve(maybeAdopt(delta.id)).catch(() => {});
      });
    }

    return { attach, maybeAdopt, browserSaveMarker, adoptedIds };
  }

  return { createManager };
});
