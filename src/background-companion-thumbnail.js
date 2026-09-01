(function initBackgroundCompanionThumbnail(root, factory) {
  const api = factory();
  root.UVDBackgroundCompanionThumbnail = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeCompanionThumbnail() {
  "use strict";

  function createSaver(deps) {
    async function saveCompanionThumbnail(job, result) {
      try {
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
        const jpgName = deps.safeDownloadName(`${base}.jpg`, "image/jpeg");
        const relativePath = await deps.relDownloadPath(jpgName);

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
          await deps.startChromeDownload(dataUrl, relativePath);
        } catch (error) {
          deps.console.warn("[UVD] thumb save", error);
        }
      } catch (error) {
        deps.console.warn("[UVD] saveCompanionThumbnail", error);
      }
    }

    return { saveCompanionThumbnail };
  }

  return { createSaver };
});
