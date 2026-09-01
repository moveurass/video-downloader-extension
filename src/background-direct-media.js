(function initBackgroundDirectMedia(root, factory) {
  const api = factory();
  root.UVDBackgroundDirectMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundDirectMedia() {
  "use strict";

  function createTransport(deps) {
    const {
      chrome,
      fetch,
      UVD,
      YtDlp,
      activeDownloads,
      getCookieHeaderForUrl,
      ytdlpFilenameHint,
      throwIfJobStopped,
      emitDownloadProgress,
      safeDownloadName,
      filenameFromUrl,
      startChromeDownload,
      relDownloadPath,
      waitDownloadComplete
    } = deps;

    /** Base id for per-download DNR referer rules (unique ids avoid concurrent races) */
    const REFERER_RULE_BASE = 771001;
    let nextRefererRuleId = REFERER_RULE_BASE;
    const MAX_REFERER_RULES = 40;

    /**
     * Probe Content-Length without downloading the body.
     * HEAD first; Range GET fallback for servers that reject HEAD.
     */
    async function probeContentLength(url) {
      const tryOnce = async (method, headers) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(url, {
            method,
            headers,
            credentials: "include",
            cache: "no-store",
            signal: ctrl.signal
          });
          if (!res.ok && res.status !== 206) return 0;
          const cr = res.headers.get("content-range");
          if (cr) {
            const m = cr.match(/\/(\d+)\s*$/);
            if (m) return parseInt(m[1], 10) || 0;
          }
          // Range GET's content-length is the 1-byte slice — only content-range counts
          if (headers?.Range) return 0;
          const len = parseInt(res.headers.get("content-length") || "0", 10);
          return Number.isFinite(len) && len > 0 ? len : 0;
        } catch {
          return 0;
        } finally {
          clearTimeout(t);
          try {
            ctrl.abort();
          } catch {
            /* ignore */
          }
        }
      };
      let size = await tryOnce("HEAD");
      if (!size) size = await tryOnce("GET", { Range: "bytes=0-0" });
      return size;
    }

    /**
     * Large direct mp4/webm via local helper: yt-dlp + aria2c open up to 16
     * connections — several times faster than chrome.downloads' single
     * connection on throttled CDNs. Helper saves straight to the output folder.
     */
    async function downloadDirectViaHelper(tabId, url, pageUrl, filename, jid) {
      const cookieHeader = await getCookieHeaderForUrl(pageUrl || url);
      const settings = await UVD.getSettings().catch(() => ({}));
      const nameHint = ytdlpFilenameHint(filename);
      const result = await YtDlp.downloadAndWait(
        {
          url,
          referer: pageUrl || undefined,
          directFile: true,
          filename: nameHint || undefined,
          title: nameHint || undefined,
          cookieHeader: cookieHeader || undefined,
          speedProfile: settings?.downloadSpeed || "fast"
        },
        (p) => {
          throwIfJobStopped(jid);
          if (p.helperJobId && jid) {
            const job = activeDownloads.get(jid);
            if (job) job.helperJobId = p.helperJobId;
          }
          const pct = Math.min(98, Math.max(16, Number(p.percent) || 16));
          emitDownloadProgress(
            tabId,
            pct,
            p.message || "도우미로 받는 중…",
            p.status || "download",
            jid
          );
        },
        40 * 60 * 1000
      );
      return {
        ok: true,
        method: "yt-dlp-direct",
        downloadId: null,
        ytdlp: true,
        path: result.path || result.outDir || "",
        outDir: result.outDir || "",
        filename: result.filename || nameHint || filename,
        size: result.size || 0
      };
    }

    async function downloadMedia(url, filename) {
      if (!url) throw new Error("받을 주소가 없습니다");
      if (url.startsWith("blob:")) throw new Error("이 형식은 바로 받을 수 없습니다");
      if (/\.m3u8(\?|$|#)/i.test(url) || /\.mpd(\?|$|#)/i.test(url)) {
        throw new Error("스트리밍 영상은 조각을 합쳐야 합니다");
      }
      const name = safeDownloadName(filename || filenameFromUrl(url), "video/mp4");
      let id;
      try {
        id = await startChromeDownload(url, await relDownloadPath(name));
      } catch {
        id = await startChromeDownload(url, name);
      }
      const done = await waitDownloadComplete(id, 60000);
      return {
        downloadId: id,
        filename: name,
        path: done.path,
        state: done.state
      };
    }

    /**
     * Attach page Referer to extension network requests while fn() runs.
     * Uses a unique DNR rule id so concurrent downloads don't clobber each other.
     * Prefer NOT forcing Origin — many CDNs return 403 when Origin ≠ expected.
     * @param {number|null} tabId
     * @param {() => Promise<any>} fn
     * @param {string} [pageUrlHint] page URL captured at download start
     */
    async function withTabReferer(tabId, fn, pageUrlHint = "") {
      let pageUrl = pageUrlHint || "";
      try {
        if (!pageUrl && tabId != null && tabId >= 0) {
          const tab = await chrome.tabs.get(tabId);
          pageUrl = tab.url || "";
        }
      } catch {
        /* ignore */
      }

      const ruleId =
        REFERER_RULE_BASE +
        ((nextRefererRuleId++ - REFERER_RULE_BASE) % MAX_REFERER_RULES);
      let ruleInstalled = false;

      if (pageUrl && chrome.declarativeNetRequest) {
        try {
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
            addRules: [
              {
                id: ruleId,
                priority: 1,
                action: {
                  type: "modifyHeaders",
                  requestHeaders: [
                    { header: "Referer", operation: "set", value: pageUrl }
                    // Do not force Origin — causes Segment HTTP 403 on many CDNs
                  ]
                },
                condition: {
                  urlFilter: "*",
                  resourceTypes: [
                    "xmlhttprequest",
                    "media",
                    "other",
                    "sub_frame",
                    "image",
                    "object"
                  ]
                }
              }
            ]
          });
          ruleInstalled = true;
        } catch (e) {
          console.warn("[UVD] DNR", e);
        }
      }

      try {
        return await fn(pageUrl);
      } finally {
        if (ruleInstalled) {
          try {
            await chrome.declarativeNetRequest?.updateSessionRules({
              removeRuleIds: [ruleId]
            });
          } catch {
            /* ignore */
          }
        }
      }
    }

    async function resolvePageUrl(tabId, fallback) {
      try {
        if (tabId != null && tabId >= 0) {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.url && /^https?:/i.test(tab.url)) return tab.url;
        }
      } catch {
        /* ignore */
      }
      return fallback || "";
    }

    return {
      probeContentLength,
      downloadDirectViaHelper,
      downloadMedia,
      withTabReferer,
      resolvePageUrl
    };
  }

  return { createTransport };
});
