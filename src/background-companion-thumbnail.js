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
    return !!(helperSaved && String(result?.thumbnailPath || "").trim());
  }

  function imageMimeFromUrl(url) {
    const clean = String(url || "").split(/[?#]/, 1)[0].toLowerCase();
    if (clean.startsWith("data:image/png")) return "image/png";
    if (clean.startsWith("data:image/webp")) return "image/webp";
    if (clean.startsWith("data:image/jpeg") || clean.startsWith("data:image/jpg")) {
      return "image/jpeg";
    }
    if (clean.endsWith(".png")) return "image/png";
    if (clean.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }

  function normalizeThumbnailUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    if (raw.startsWith("data:image/")) return raw;
    if (raw.startsWith("//")) return `https:${raw}`;
    if (/^https?:\/\//i.test(raw)) return raw;
    return "";
  }

  function createSaver(deps) {
    async function blobToDataUrl(blob, mime) {
      const bytes = new deps.Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(index, index + chunkSize)
        );
      }
      return `data:${mime};base64,${deps.btoa(binary)}`;
    }

    async function fetchThumbnailBlob(thumbnailUrl, pageUrl) {
      const headers = pageUrl ? { Referer: pageUrl } : {};
      const attempts = [
        { credentials: "omit", cache: "no-store", headers },
        { credentials: "include", cache: "no-store", headers }
      ];
      let lastError = null;
      for (const init of attempts) {
        try {
          const response = await deps.fetch(thumbnailUrl, init);
          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
          }
          const blob = await response.blob();
          if (!blob.size || blob.size < 500) {
            lastError = new Error("thumbnail too small");
            continue;
          }
          const mime =
            blob.type && blob.type.startsWith("image/")
              ? blob.type
              : imageMimeFromUrl(thumbnailUrl);
          if (!String(mime).startsWith("image/")) continue;
          return { blob, mime };
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return null;
    }

    async function saveCompanionThumbnail(job, result) {
      try {
        // The helper publishes its yt-dlp thumbnail beside the media. Starting
        // a Chrome download as well creates a duplicate image-only shelf entry.
        if (helperHandledThumbnail(result)) return;
        const settings = await deps.UVD.getSettings();
        if (settings.saveThumbnail === false) return;
        if ((job?.mediaMode || settings.mediaMode) === "audio") return;

        let thumbnailUrl = normalizeThumbnailUrl(job?.thumbnail || "");
        if (!thumbnailUrl && job?.tabId != null && job.tabId >= 0) {
          thumbnailUrl = normalizeThumbnailUrl(
            deps.getTabMeta(job.tabId)?.thumbnail || ""
          );
        }
        if (!thumbnailUrl) return;

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

        if (thumbnailUrl.startsWith("data:image/")) {
          const mime = imageMimeFromUrl(thumbnailUrl);
          const dataName = deps.safeDownloadName(base, mime);
          await deps.startChromeDownload(
            thumbnailUrl,
            await deps.relDownloadPath(dataName)
          );
          return;
        }

        try {
          const fetched = await fetchThumbnailBlob(thumbnailUrl, job?.pageUrl);
          if (fetched?.blob) {
            const dataUrl = await blobToDataUrl(fetched.blob, fetched.mime);
            const fetchedName = deps.safeDownloadName(base, fetched.mime);
            await deps.startChromeDownload(
              dataUrl,
              await deps.relDownloadPath(fetchedName)
            );
            return;
          }
        } catch (error) {
          deps.console.warn("[UVD] thumb fetch", error);
        }

        try {
          const directMime = imageMimeFromUrl(thumbnailUrl);
          const directName = deps.safeDownloadName(base, directMime);
          await deps.startChromeDownload(
            thumbnailUrl,
            await deps.relDownloadPath(directName)
          );
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
