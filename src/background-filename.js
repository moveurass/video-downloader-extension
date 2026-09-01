(function initBackgroundFilename(root, factory) {
  const api = factory();
  root.UVDBackgroundFilename = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundFilename() {
  "use strict";

  function createManager(deps) {
    const { UVD, Naming, UVDDownloadEngine } = deps;
    const safeDownloadName = (filename, mime = "") =>
      UVDDownloadEngine.safeDownloadName(filename, mime, Naming);

    /** Chrome downloads relative path under user Downloads */
    async function relDownloadPath(filename) {
      const s = await UVD.getSettings();
      return UVD.downloadRelPath(s.subfolder, filename);
    }

    /**
     * Build human-readable filename. Empty string = let yt-dlp use real page title.
     * Avoids forcing YouTube_xxxx / TikTok_123 junk names.
     */
    async function buildSaveFilename({
      title,
      quality,
      pageUrl,
      mediaUrl,
      mediaType,
      mediaMode,
      seriesKey,
      playlistTitle,
      seriesIndex,
      seriesTotal
    } = {}) {
      const s = await UVD.getSettings();
      const mode = mediaMode || s.mediaMode || "video";
      const mime = mode === "audio" || mediaType === "audio" ? "audio/mp3" : "video/mp4";
      // Prefer Naming helpers — strip Uncensored-Leaked noise, put CODE first
      if (typeof Naming !== "undefined" && Naming.buildFilename) {
        // Series / playlist structured names when applicable
        if (
          (playlistTitle || seriesKey || seriesIndex > 0) &&
          Naming.buildSeriesFilename
        ) {
          const full = Naming.buildSeriesFilename({
            title: title || "",
            pageTitle: title || "",
            quality: quality || "",
            type: mode === "audio" ? "audio" : "video",
            seriesKey: seriesKey || Naming.extractProductCode?.(title) || "",
            playlistTitle: playlistTitle || "",
            index: seriesIndex || 0,
            total: seriesTotal || 0
          });
          if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
            return safeDownloadName(full, mime);
          }
        }
        const bound = Naming.bindTitleToPage?.(pageUrl, title || "") || title || "";
        const full = Naming.buildFilename({
          title: bound || title || "",
          pageTitle: bound || title || "",
          quality: quality || "",
          type: mode === "audio" ? "audio" : "video",
          pageUrl: pageUrl || "",
          url: mediaUrl || ""
        });
        if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
          return safeDownloadName(full, mime);
        }
      }
      // Fallback legacy template
      const cleanTitle = UVD.isGenericSaveName(title)
        ? ""
        : Naming.bindTitleToPage?.(pageUrl, title) || title || "";
      const base = UVD.applyFilenameTemplate("legacy", {
        title: cleanTitle,
        quality: quality || "",
        site: UVD.siteFromUrl(pageUrl || ""),
        mediaMode: mode
      });
      if (!base || UVD.isGenericSaveName(base)) return "";
      const ext = mode === "audio" || mediaType === "audio" ? ".mp3" : ".mp4";
      return safeDownloadName(base.endsWith(ext) ? base : base + ext, mime);
    }

    /**
     * Normalize any client-provided filename through Naming
     * so Uncensored-Leaked / site brands never reach disk or yt-dlp.
     */
    function normalizeIncomingFilename(filename, quality = "", mediaMode = "video") {
      if (!filename) return "";
      const mime =
        mediaMode === "audio" || /\.mp3$/i.test(filename)
          ? "audio/mp3"
          : "video/mp4";
      if (typeof Naming !== "undefined" && Naming.buildFilename) {
        const full = Naming.buildFilename({
          title: String(filename),
          pageTitle: String(filename),
          quality: quality || "",
          type: mediaMode === "audio" ? "audio" : "video",
          existing: String(filename)
        });
        if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
          return safeDownloadName(full, mime);
        }
      }
      return safeDownloadName(filename, mime);
    }

    /** True when two titles refer to the same product / video identity */
    function titlesMatchVideo(a, b) {
      const sa = String(a || "").trim();
      const sb = String(b || "").trim();
      if (!sa || !sb) return false;
      const ca = Naming.extractProductCode?.(sa) || "";
      const cb = Naming.extractProductCode?.(sb) || "";
      if (ca && cb) return ca.toUpperCase() === cb.toUpperCase();
      // If only one has a product code, they are different videos
      if (ca || cb) return false;
      const na = Naming.cleanPageTitle?.(sa) || sa;
      const nb = Naming.cleanPageTitle?.(sb) || sb;
      if (na === nb) return true;
      // Same stem ignoring quality suffix
      const stripQ = (s) => s.replace(/[_\s-]*\d{3,4}p\b/gi, "").trim().toLowerCase();
      return stripQ(na) === stripQ(nb) && stripQ(na).length >= 4;
    }

    /**
     * Lock the save filename at download START.
     * Must not be recomputed from the live tab later — user may navigate away
     * or start another video while HLS/yt-dlp is still running.
     */
    function lockSaveName({
      filenameHint = "",
      title = "",
      pageTitle = "",
      quality = "",
      mediaMode = "video",
      pageUrl = "",
      mediaUrl = "",
      seriesKey = "",
      playlistTitle = "",
      seriesIndex = 0,
      seriesTotal = 0
    } = {}) {
      const mime = mediaMode === "audio" ? "audio/mp3" : "video/mp4";
      // Always bind titles to THIS pageUrl so another video's name can't leak in
      const bound =
        Naming.bindTitleToPage?.(pageUrl, title || pageTitle || filenameHint) ||
        Naming.cleanPageTitle?.(title || pageTitle || "") ||
        title ||
        pageTitle ||
        "";
      const boundHint = filenameHint
        ? Naming.bindTitleToPage?.(pageUrl, filenameHint) ||
          Naming.cleanPageTitle?.(
            String(filenameHint).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "")
          ) ||
          filenameHint
        : "";

      // 1) Explicit filename from popup/job — re-bind to pageUrl identity
      if (boundHint && !UVD.isGenericSaveName(boundHint)) {
        const full = Naming.buildFilename({
          title: boundHint,
          pageTitle: bound || boundHint,
          quality: quality || "",
          type: mediaMode === "audio" ? "audio" : "video",
          pageUrl: pageUrl || "",
          existing: boundHint,
          url: mediaUrl || ""
        });
        if (full && !UVD.isGenericSaveName(full.replace(/\.[a-z0-9]+$/i, ""))) {
          return safeDownloadName(full, mime);
        }
      }
      // 2) Build from the title that belongs to THIS job only
      if (bound && !UVD.isGenericSaveName(bound)) {
        if (
          (playlistTitle || seriesKey || seriesIndex > 0) &&
          Naming.buildSeriesFilename
        ) {
          const full = Naming.buildSeriesFilename({
            title: bound,
            pageTitle: bound,
            quality,
            type: mediaMode === "audio" ? "audio" : "video",
            seriesKey:
              seriesKey ||
              Naming.extractProductCode?.(pageUrl) ||
              Naming.extractProductCode?.(bound) ||
              "",
            playlistTitle: playlistTitle || "",
            index: seriesIndex || 0,
            total: seriesTotal || 0
          });
          if (full) return safeDownloadName(full, mime);
        }
        const full = Naming.buildFilename({
          title: bound,
          pageTitle: bound,
          quality,
          type: mediaMode === "audio" ? "audio" : "video",
          pageUrl: pageUrl || "",
          url: mediaUrl || ""
        });
        if (full) return safeDownloadName(full, mime);
      }
      // 3) Product code from the page URL of THIS job (not current tab)
      const code =
        Naming.extractProductCode?.(pageUrl || "") ||
        Naming.extractProductCode?.(seriesKey || "") ||
        "";
      if (code) {
        return safeDownloadName(
          Naming.buildFilename({
            title: code,
            quality,
            type: mediaMode === "audio" ? "audio" : "video",
            pageUrl: pageUrl || "",
            url: mediaUrl || ""
          }),
          mime
        );
      }
      return "";
    }

    /**
     * Apply real quality after download without changing the video identity in the name.
     */
    function applyQualityToLockedName(lockedName, quality, mediaMode = "video") {
      if (!lockedName) return lockedName;
      const mime = mediaMode === "audio" ? "audio/mp3" : "video/mp4";
      let q =
        quality && !/^(best|all|unknown|highest|default)$/i.test(String(quality))
          ? String(quality).replace(/[()]/g, "").trim()
          : "";
      if (!q) return safeDownloadName(lockedName, mime);
      const base = String(lockedName).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
      if (new RegExp(`[_\\s-]${q}\\b`, "i").test(base) || base.endsWith(q)) {
        return safeDownloadName(lockedName, mime);
      }
      // Replace trailing quality if present, else append
      const stripped = base.replace(/[_\s-]*\d{3,4}p\b/i, "").trim() || base;
      const extension =
        String(lockedName).match(/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac)$/i)?.[0] ||
        (mediaMode === "audio" ? ".mp3" : ".mp4");
      return safeDownloadName(`${stripped}_${q}${extension}`, mime);
    }

    /** Only pass a forced name to yt-dlp when it's a real human title */
    function ytdlpFilenameHint(filename, title) {
      const candidates = [filename, title].filter(Boolean);
      for (const c of candidates) {
        const base = String(c).replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
        if (base && !UVD.isGenericSaveName(base) && base.length >= 2) {
          // Always re-clean (popup may still send dirty names)
          return normalizeIncomingFilename(
            /\.[a-z0-9]{2,5}$/i.test(c) ? c : `${base}.mp4`,
            "",
            "video"
          );
        }
      }
      return undefined; // yt-dlp %(title)s
    }

    function filenameFromUrl(url) {
      return Naming.buildFilename({
        url,
        title: Naming.titleFromUrl?.(url) || "",
        pageTitle: ""
      });
    }

    return {
      safeDownloadName,
      relDownloadPath,
      buildSaveFilename,
      normalizeIncomingFilename,
      titlesMatchVideo,
      lockSaveName,
      applyQualityToLockedName,
      ytdlpFilenameHint,
      filenameFromUrl
    };
  }

  return { createManager };
});
