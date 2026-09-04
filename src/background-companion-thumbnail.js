(function initBackgroundCompanionThumbnail(root, factory) {
  const api = factory();
  root.UVDBackgroundCompanionThumbnail = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeCompanionThumbnail() {
  "use strict";

  function helperHandledThumbnail(result) {
    const helperSaved =
      result?.ytdlp === true ||
      (result?.downloadId == null && String(result?.path || "").trim());
    return !!(
      helperSaved &&
      (result?.writeThumbnail === true ||
        String(result?.thumbnailPath || "").trim())
    );
  }

  function imageMimeFromUrl(url) {
    const clean = String(url || "").split(/[?#]/, 1)[0].toLowerCase();
    if (clean.endsWith(".png")) return "image/png";
    if (clean.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }

  function createSaver(deps) {
    async function saveCompanionThumbnail(job, result) {
      try {
        // The helper publishes its yt-dlp thumbnail beside the media. Starting
        // a Chrome download as well creates a duplicate image-only shelf entry.
        if (helperHandledThumbnail(result)) return;
        const settings = await deps.UVD.getSettings();
        if (settings.saveThumbnail === false) return;
        if ((job?.mediaMode || settings.mediaMode) === "audio") return;

        let thumbnailUrl = job?.thumbnail || "";
        if (!thumbnailUrl && job?.tabId != null && job.tabId >= 0) {
          thumbnailUrl = deps.getTabMeta(job.tabId)?.thumbnail || "";
        }
        if (!thumbnailUrl || !/^https?:/i.test(thumbnailUrl)) return;

        const videoName =
          result?.filename ||
          job?.filename ||
          (result?.path ? String(result.path).split(/[/\\]/).pop() : "") ||
          "영상.mp4";
        let base = String(videoName).replace(/\.[a-z0-9]{2,5}$/i, "");
        if (!base || deps.UVD.isGenericSaveName(base)) {
          base =
            (job?.title || "영상")
              .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60) || "영상";
        }
        const directMime = imageMimeFromUrl(thumbnailUrl);
        const directName = deps.safeDownloadName(base, directMime);
        const relativePath = await deps.relDownloadPath(directName);

        try {
          await deps.startChromeDownload(thumbnailUrl, relativePath);
          return;
        } catch {
          // Fetch the image when Chrome cannot download its URL directly.
        }

        try {
          const response = await deps.fetch(thumbnailUrl, {
            credentials: "omit",
            cache: "no-store",
            headers: job?.pageUrl ? { Referer: job.pageUrl } : {}
          });
          if (!response.ok) return;
          const blob = await response.blob();
          if (!blob.size || blob.size < 500) return;
          const bytes = new deps.Uint8Array(await blob.arrayBuffer());
          let binary = "";
          const chunkSize = 0x8000;
          for (let index = 0; index < bytes.length; index += chunkSize) {
            binary += String.fromCharCode.apply(
              null,
              bytes.subarray(index, index + chunkSize)
            );
          }
          const mime =
            blob.type && blob.type.startsWith("image/")
              ? blob.type
              : "image/jpeg";
          const dataUrl = `data:${mime};base64,${deps.btoa(binary)}`;
          const fetchedName = deps.safeDownloadName(base, mime);
          const fetchedPath = await deps.relDownloadPath(fetchedName);
          await deps.startChromeDownload(dataUrl, fetchedPath);
        } catch (error) {
          deps.console.warn("[UVD] thumb save", error);
        }
      } catch (error) {
        deps.console.warn("[UVD] saveCompanionThumbnail", error);
      }
    }

    return { saveCompanionThumbnail };
  }

  return { createSaver, helperHandledThumbnail, imageMimeFromUrl };
});
