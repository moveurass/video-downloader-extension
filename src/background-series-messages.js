(function initSeriesMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundSeriesMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSeriesMessages() {
  "use strict";

  function createHandler(deps) {
    const runningCount = () =>
      [...deps.activeDownloads.values()].filter((job) => job.status === "running").length;

    async function listPlaylist(pageUrl, max) {
      const [cookieHeader, cookiesList] = await Promise.all([
        deps.getCookieHeader(pageUrl),
        deps.collectCookies(pageUrl)
      ]);
      return deps.YtDlp.listPlaylist(pageUrl, {
        cookieHeader: cookieHeader || undefined,
        cookiesList: cookiesList?.length ? cookiesList : undefined,
        max
      });
    }

    async function startEntries(entries, options) {
      const started = [];
      const total = entries.length;
      for (let index = 0; index < entries.length; index++) {
        const absoluteIndex = index + (options.indexOffset || 0);
        if (options.waitForSlot) {
          while (runningCount() >= deps.maxConcurrent()) {
            await new Promise((resolve) => setTimeout(resolve, options.slotDelay || 600));
          }
        }
        const entry = entries[index] || {};
        const pageUrl = entry.url || entry.webpage_url || "";
        if (!pageUrl) continue;
        const title = entry.title ||
          `${options.title || "시리즈"} (${absoluteIndex + 1}/${options.total || total})`;
        const seriesIndex = entry.seriesIndex || absoluteIndex + 1;
        const seriesKey = entry.key || entry.id || entry.seriesKey || "";
        const filename = await deps.buildSaveFilename({
          title,
          quality: options.quality,
          pageUrl,
          mediaMode: options.settings.mediaMode,
          playlistTitle: options.title || "",
          seriesKey,
          seriesIndex,
        seriesTotal: options.total || total
        });
        const jobId = deps.createDownloadJob({
          tabId: options.tabId,
          title,
          pageUrl,
          filename: filename || "",
          mediaMode: options.settings.mediaMode,
          quality: options.quality,
          thumbnail: entry.thumbnail || "",
          seriesId: options.seriesId,
          seriesKey,
          seriesIndex,
          seriesTitle: options.title || "",
          tags: ["series", "playlist", options.seriesId, seriesKey].filter(Boolean)
        });
        const keepAlive = deps.startKeepAlive();
        started.push({ jobId, url: pageUrl, title });
        deps.withJobContext(jobId, () =>
          deps.downloadViaYtDlp(
            options.tabId,
            pageUrl,
            pageUrl,
            filename || undefined,
            options.quality,
            jobId,
            { mediaMode: options.settings.mediaMode }
          )
        ).then((result) => {
          deps.settleTrackedJob(jobId, result, null);
          deps.stopKeepAlive(keepAlive);
        }).catch((error) => {
          deps.settleTrackedJob(jobId, null, error);
          deps.stopKeepAlive(keepAlive);
        });
      }
      return started;
    }

    function seriesIdFor(message, pageUrl, info, forceMode) {
      if (message.seriesId) return String(message.seriesId);
      if (
        forceMode === "product_code" ||
        (!forceMode && info &&
          !(deps.UVD.isPlaylistOnlyUrl(pageUrl) || deps.UVD.isWatchInPlaylistUrl(pageUrl)))
      ) {
        return `series:code:${info?.prefix || info?.key || "series"}`;
      }
      try {
        const list = new URL(pageUrl).searchParams.get("list") ||
          deps.UVD.normalizeUrlKey(pageUrl) || "unknown";
        return `series:pl:${list}`;
      } catch {
        return `series:${Date.now()}`;
      }
    }

    async function handleListPlaylist(message) {
      const pageUrl = message.pageUrl || message.url || "";
      if (!pageUrl || !/^https?:/i.test(pageUrl)) {
        return { ok: false, error: "재생목록 주소가 없습니다", entries: [] };
      }
      if (!await deps.YtDlp.available().catch(() => false)) {
        return { ok: false, error: "로컬 도우미가 필요합니다", entries: [] };
      }
      const data = await listPlaylist(pageUrl, message.max || 200);
      return {
        ok: true,
        title: data.title || "재생목록",
        count: data.count || (data.entries || []).length,
        playlistCount: data.playlistCount || data.count || 0,
        entries: data.entries || [],
        url: pageUrl
      };
    }

    async function handleDownloadPlaylist(message, senderTabId) {
      const pageUrl = message.pageUrl || message.url || "";
      const tabId = message.tabId ?? senderTabId;
      const quality = message.preferQuality || "best";
      const max = Math.min(200, Math.max(1, Number(message.max) || 50));
      let entries = Array.isArray(message.entries) ? message.entries : [];
      if (!entries.length && pageUrl) {
        entries = (await listPlaylist(pageUrl, max)).entries || [];
      }
      entries = entries
        .filter((entry) => /^https?:/i.test(entry.url || entry.webpage_url || ""))
        .slice(0, max);
      if (!entries.length) {
        return { ok: false, error: "재생목록에 받을 영상이 없습니다" };
      }
      const settings = await deps.UVD.getSettings();
      const title = message.title || "재생목록";
      let seriesId = message.seriesId || "";
      if (!seriesId && pageUrl) {
        try {
          seriesId = `series:pl:${new URL(pageUrl).searchParams.get("list") || deps.UVD.normalizeUrlKey(pageUrl)}`;
        } catch {
          seriesId = `series:pl:${Date.now()}`;
        }
      }
      const immediate = entries.slice(0, deps.maxConcurrent());
      const started = await startEntries(immediate, {
        tabId, quality, settings, title, seriesId, total: entries.length, waitForSlot: false
      });
      if (entries.length > immediate.length) {
        startEntries(entries.slice(immediate.length), {
          tabId,
          quality,
          settings,
          title,
          seriesId,
          total: entries.length,
          indexOffset: immediate.length,
          waitForSlot: true,
          slotDelay: 800
        }).catch(() => {});
      }
      return {
        ok: true,
        started: true,
        count: entries.length,
        concurrent: started.length,
        jobIds: started.map((item) => item.jobId),
        title
      };
    }

    async function handleSeriesComplete(message) {
      const settings = await deps.UVD.getSettings();
      const title = message.title || "";
      const pageUrl = message.pageUrl || message.url || "";
      const count = Math.min(
        20,
        Math.max(1, Number(message.count) || settings.seriesCompleteCount || 5)
      );
      const quality = message.preferQuality || "best";
      const explicit = Array.isArray(message.entries)
        ? message.entries.filter((entry) => /^https?:/i.test(entry?.url || ""))
        : [];
      const forceMode = message.mode || null;
      const info = deps.UVD.extractSeriesInfo(title);
      const result = { mode: null, queued: 0, items: [] };
      const seriesId = seriesIdFor(message, pageUrl, info, forceMode);
      const seriesTitle = message.seriesTitle || title || "";
      const start = async (entries, playlistTitle) => {
        const started = await startEntries(entries, {
          tabId: message.tabId ?? -1,
          quality,
          settings,
          title: playlistTitle || seriesTitle,
          seriesId,
          waitForSlot: true,
          slotDelay: 600
        });
        return started.map((item) => item.jobId);
      };

      if (explicit.length) {
        const asPlaylist = forceMode === "playlist" ||
          (!forceMode &&
            (deps.UVD.isPlaylistOnlyUrl(pageUrl) || deps.UVD.isWatchInPlaylistUrl(pageUrl)));
        result.mode = asPlaylist ? "playlist" : "product_code";
        result.seriesId = seriesId;
        result.items = explicit;
        if (asPlaylist) {
          result.jobIds = await start(explicit, message.seriesTitle || title);
          result.queued = result.jobIds.length;
        } else {
          for (const entry of explicit) {
            await deps.UVD.addWatchlist({
              url: entry.url,
              pageUrl: entry.url,
              title: entry.title || entry.key || "시리즈",
              quality,
              site: deps.UVD.siteFromUrl(pageUrl) || deps.UVD.siteFromUrl(entry.url) || "",
              tags: ["series", info?.prefix, entry.key, seriesId].filter(Boolean)
            });
            result.queued += 1;
          }
        }
        return { ok: true, ...result };
      }

      if (deps.UVD.isPlaylistOnlyUrl(pageUrl) || deps.UVD.isWatchInPlaylistUrl(pageUrl)) {
        let listUrl = pageUrl;
        if (deps.UVD.isWatchInPlaylistUrl(pageUrl)) {
          const listId = new URL(pageUrl).searchParams.get("list");
          if (listId) listUrl = `https://www.youtube.com/playlist?list=${listId}`;
        }
        const data = await listPlaylist(listUrl, 200);
        let entries = data.entries || [];
        const currentKey = deps.UVD.normalizeUrlKey(pageUrl);
        entries = entries.filter((entry) => deps.UVD.normalizeUrlKey(entry.url || "") !== currentKey);
        if (deps.UVD.isWatchInPlaylistUrl(pageUrl)) {
          const videoId = new URL(pageUrl).searchParams.get("v");
          const index = entries.findIndex((entry) =>
            entry.id === videoId || (entry.url || "").includes(videoId)
          );
          if (index >= 0) entries = entries.slice(index + 1);
        }
        entries = entries.slice(0, count);
        result.mode = "playlist";
        result.seriesId = seriesId;
        result.items = entries;
        if (entries.length) {
          result.jobIds = await start(entries, data.title || title);
          result.queued = result.jobIds.length;
        }
        return { ok: true, ...result };
      }

      if (info) {
        let origin = "";
        try {
          origin = new URL(pageUrl).origin;
        } catch {
          // Google fallback below.
        }
        for (const next of deps.UVD.nextSeriesKeys(info, count)) {
          let url = pageUrl && info.key
            ? pageUrl.replace(
                new RegExp(info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
                next.key
              )
            : "";
          if (url === pageUrl) {
            url = pageUrl.replace(new RegExp(`${info.prefix}[-_]?${info.num}`, "i"), next.key);
          }
          if (!url || url === pageUrl) {
            url = origin
              ? `${origin}/search?q=${encodeURIComponent(next.key)}`
              : `https://www.google.com/search?q=${encodeURIComponent(`${next.key} video`)}`;
          }
          await deps.UVD.addWatchlist({
            url,
            pageUrl: url,
            title: next.label,
            quality,
            site: deps.UVD.siteFromUrl(pageUrl) || "",
            tags: ["series", info.prefix, next.key, seriesId].filter(Boolean)
          });
          result.items.push({ key: next.key, url, title: next.label });
          result.queued += 1;
        }
        return { ok: true, ...result, mode: "product_code", seriesId };
      }
      return {
        ok: false,
        error: "시리즈 코드를 찾지 못했습니다. 재생목록 페이지이거나 제목에 SSIS-001 같은 품번이 있으면 동작합니다",
        ...result
      };
    }

    return function handleSeriesMessage(message, senderTabId, sendResponse) {
      const handlers = {
        LIST_PLAYLIST: () => handleListPlaylist(message),
        DOWNLOAD_PLAYLIST: () => handleDownloadPlaylist(message, senderTabId),
        SERIES_COMPLETE: () => handleSeriesComplete(message)
      };
      const operation = handlers[message?.type];
      if (!operation) return { handled: false, keepChannel: false };
      operation()
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: String(error?.message || error),
          ...(message.type === "LIST_PLAYLIST" ? { entries: [] } : {})
        }));
      return { handled: true, keepChannel: true };
    };
  }

  return { createHandler };
});
