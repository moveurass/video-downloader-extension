(function initBackgroundMediaState(root, factory) {
  const api = factory();
  root.UVDBackgroundMediaState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundMediaState() {
  "use strict";

  function createStore(deps) {
    const tabMedia = new Map();
    const tabMeta = new Map();
    const probedUrls = new Set();
    let bound = false;

    const {
      chrome,
      Naming,
      HLS,
      hostOf,
      isYoutubeUrl,
      isTiktokUrl,
      isInstagramPostUrl,
      isXUrl,
      isFacebookUrl,
      isBilibiliUrl,
      isDownloadableSiteVideo,
      needsYtDlpHelper,
      siteKind,
      siteDefaultTitle,
      isLikelyMedia,
      classifyMedia,
      qualityLabel,
      hashUrl,
      titlesMatchVideo
    } = deps;

    function pageIdentityKey(url) {
      if (!url || !/^https?:/i.test(url)) return "";
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./i, "").toLowerCase();
        const path = u.pathname || "/";

        if (host === "youtu.be") {
          const id = path.replace(/^\//, "").split("/")[0];
          return id ? `yt:${id}` : `yt:${path}`;
        }
        if (host.includes("youtube") || host.includes("youtube-nocookie")) {
          const v = u.searchParams.get("v");
          if (v) return `yt:${v}`;
          const m = path.match(/\/(shorts|embed|live|clip)\/([^/?#]+)/i);
          if (m) return `yt:${m[1]}:${m[2]}`;
          const list = u.searchParams.get("list");
          if (list && /playlist/i.test(path)) return `yt:list:${list}`;
          return `yt:${path}`;
        }

        if (host.includes("tiktok")) {
          const m = path.match(/\/@[^/]+\/video\/(\d+)/i);
          if (m) return `tt:${m[1]}`;
          const t = path.match(/\/t\/([^/?#]+)/i);
          if (t) return `tt:t:${t[1]}`;
          return `tt:${path}`;
        }

        if (host.includes("instagram") || host.includes("instagr.am")) {
          const m = path.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
          if (m) return `ig:${m[1]}:${m[2]}`;
          return `ig:${path.replace(/\/+$/, "") || "/"}`;
        }

        if (Naming.isKnownCodeSite?.(host)) {
          const codeInPath = Naming.extractProductCode?.(u.href) || "";
          if (codeInPath) return `${host}:code:${codeInPath}`;
        }

        const keep = [];
        for (const k of ["v", "id", "video_id", "vid", "clip", "watch", "code"]) {
          const val = u.searchParams.get(k);
          if (val) keep.push(`${k}=${val}`);
        }
        keep.sort();
        return `${host}${path.replace(/\/+$/, "") || "/"}${
          keep.length ? "?" + keep.join("&") : ""
        }`;
      } catch {
        return String(url).slice(0, 200);
      }
    }

    function thumbnailMatchesPageKey(thumbnail, pageKey) {
      const expected = String(pageKey || "").match(
        /^yt:(?:(?:shorts|embed|live):)?([^:/?#]+)$/i
      )?.[1];
      const actual = String(thumbnail || "").match(
        /(?:i\d*\.ytimg\.com|img\.youtube\.com)\/(?:vi|vi_webp)\/([^/?#]+)/i
      )?.[1];
      return !expected || !actual || expected === actual;
    }

    function getTabMap(tabId) {
      if (!tabMedia.has(tabId)) tabMedia.set(tabId, new Map());
      return tabMedia.get(tabId);
    }

    function getTabMeta(tabId) {
      return tabId != null ? tabMeta.get(tabId) : undefined;
    }

    function getTabItems(tabId) {
      const map = tabMedia.get(tabId);
      return map ? [...map.values()] : [];
    }

    function isDownloadableHelperPage(pageUrl) {
      if (!pageUrl || !/^https?:/i.test(pageUrl)) return false;
      if (typeof isDownloadableSiteVideo === "function") {
        return isDownloadableSiteVideo(pageUrl);
      }
      return !!(
        isYoutubeUrl(pageUrl) ||
        isTiktokUrl(pageUrl) ||
        isInstagramPostUrl(pageUrl) ||
        isXUrl(pageUrl) ||
        isFacebookUrl(pageUrl) ||
        isBilibiliUrl(pageUrl)
      );
    }

    function makeSitePlaceholder(tab) {
      const pageUrl = tab?.url || "";
      if (!isDownloadableHelperPage(pageUrl)) return null;
      const kind = siteKind(pageUrl, pageUrl);
      if (!kind) return null;
      const meta = tab?.id != null ? tabMeta.get(tab.id) : null;
      const identityReady =
        kind !== "youtube" || meta?.identityConfirmed === true;
      const title =
        (identityReady ? meta?.title : "") ||
        (identityReady ? Naming.cleanPageTitle(tab?.title || "") : "") ||
        siteDefaultTitle(kind);
      return enrichItem(tab.id, {
        url: pageUrl,
        type: "stream",
        isHls: false,
        isSiteDownload: true,
        site: kind,
        source: kind,
        title,
        pageTitle: title,
        pageUrl,
        thumbnail: identityReady ? meta?.thumbnail : undefined,
        host: hostOf(pageUrl),
        quality: "best",
        format: "MP4"
      });
    }

    function resolveFilename(tabId, item = {}, url = item.url) {
      const meta = tabId != null ? tabMeta.get(tabId) : null;
      return Naming.buildFilename({
        url: url || item.url || "",
        title: item.title || item.pageTitle || meta?.title || "",
        pageTitle: item.pageTitle || meta?.title || "",
        quality: item.quality || "",
        type: item.type || "video",
        isHls: item.isHls || item.type === "stream",
        isFmp4: true,
        host: item.host || meta?.host || "",
        existing: item.filename || "",
        pageUrl: item.pageUrl || meta?.lastUrl || ""
      });
    }

    function clearTabMediaState(tabId, { keepLastUrl } = {}) {
      if (tabId == null) return;
      tabMedia.delete(tabId);
      const prevUrl = keepLastUrl || tabMeta.get(tabId)?.lastUrl || "";
      tabMeta.delete(tabId);
      if (prevUrl) {
        tabMeta.set(tabId, {
          lastUrl: prevUrl,
          pageKey: pageIdentityKey(prevUrl),
          title: undefined,
          thumbnail: undefined,
          identityConfirmed: false,
          host: (() => {
            try {
              return new URL(prevUrl).hostname;
            } catch {
              return undefined;
            }
          })()
        });
      }
      updateBadge(tabId);
      broadcastUpdate(tabId);
    }

    function enrichItem(tabId, item) {
      const meta = tabId != null ? tabMeta.get(tabId) : null;
      const quality = item.quality || qualityLabel(item.height) || null;
      const mime = String(item.mime || "").toLowerCase();
      // DASH is classified as a stream too, but it must never be treated as
      // HLS: the m3u8 path cannot parse an MPD and the helper handles DASH.
      const isDash = !!(
        item.isDash ||
        mime.includes("dash+xml") ||
        (item.url && /\.mpd(\?|$|#)/i.test(item.url))
      );
      const isHls =
        !isDash &&
        !!(
          item.isHls ||
          item.type === "stream" ||
          mime.includes("mpegurl") ||
          (item.url && /\.m3u8(\?|$|#)/i.test(item.url))
        );

      const itemPage = item.pageUrl || item.url || meta?.lastUrl || "";
      const samePage =
        !meta?.pageKey ||
        !itemPage ||
        pageIdentityKey(itemPage) === meta.pageKey ||
        pageIdentityKey(meta.lastUrl || "") === meta.pageKey;
      const identityReady =
        !String(meta?.pageKey || "").startsWith("yt:") ||
        meta?.identityConfirmed === true;

      const tabTitle = samePage && identityReady ? meta?.title || "" : "";
      const pageRef = item.pageUrl || (samePage ? meta?.lastUrl : "") || "";
      let title = "";
      for (const candidate of identityReady
        ? [item.title, item.pageTitle]
        : []) {
        if (!candidate) continue;
        const cleaned = pageRef
          ? Naming.bindTitleToPage?.(pageRef, candidate) ||
            Naming.cleanPageTitle(candidate) ||
            candidate
          : Naming.cleanPageTitle(candidate) || candidate;
        if (cleaned && !Naming.isUglyBase(cleaned)) {
          title = cleaned;
          break;
        }
      }
      if ((!title || Naming.isUglyBase(title)) && tabTitle && samePage) {
        const cleanedTabTitle = pageRef
          ? Naming.bindTitleToPage?.(pageRef, tabTitle) ||
            Naming.cleanPageTitle(tabTitle) ||
            tabTitle
          : Naming.cleanPageTitle(tabTitle) || tabTitle;
        if (cleanedTabTitle && !Naming.isUglyBase(cleanedTabTitle)) {
          title = cleanedTabTitle;
        }
      } else if (title && tabTitle && samePage) {
        const cleanedTabTitle = Naming.cleanPageTitle(tabTitle) || tabTitle;
        if (
          cleanedTabTitle &&
          !Naming.isUglyBase(cleanedTabTitle) &&
          titlesMatchVideo(title, cleanedTabTitle) &&
          cleanedTabTitle.length > title.length + 5
        ) {
          title = pageRef
            ? Naming.bindTitleToPage?.(pageRef, cleanedTabTitle) || cleanedTabTitle
            : cleanedTabTitle;
        }
      }
      if (!title && pageRef) {
        title = Naming.bindTitleToPage?.(pageRef, "") || "";
      }

      const host = meta?.host || item.host || "";
      const itemThumbnail = thumbnailMatchesPageKey(
        item.thumbnail,
        meta?.pageKey
      )
        ? item.thumbnail
        : undefined;
      const thumbnail =
        itemThumbnail ||
        (samePage && meta?.thumbnail ? meta.thumbnail : undefined) ||
        undefined;
      const existingRaw = (item.filename || "").replace(/\.[a-z0-9]{2,5}$/i, "");
      const existingOk =
        existingRaw && !Naming.isUglyBase(existingRaw) ? item.filename : "";
      const filename = Naming.buildFilename({
        title,
        pageTitle:
          (identityReady ? item.pageTitle : "") ||
          (samePage && identityReady ? meta?.title : "") ||
          "",
        quality,
        type: item.type || "video",
        isHls,
        isFmp4: true,
        host,
        existing: existingOk,
        pageUrl: pageRef,
        url: item.url || ""
      });
      const displayName = Naming.displayTitle({
        title,
        pageTitle:
          (identityReady ? item.pageTitle : "") ||
          (samePage && identityReady ? meta?.title : "") ||
          "",
        type: item.type || "video"
      });

      let estimatedSize = item.estimatedSize;
      const estimatedBandwidth = item.estimateBandwidth || item.bandwidth;
      if (!item.size && !estimatedSize && estimatedBandwidth > 0 && item.duration >= 1) {
        const rate = item.estimateBandwidth
          ? estimatedBandwidth
          : Math.round(estimatedBandwidth * 0.55);
        estimatedSize = Math.round((rate / 8) * item.duration);
      }

      return {
        ...item,
        quality,
        isHls,
        isDash,
        isFmp4: true,
        format: "MP4",
        estimatedSize: estimatedSize || undefined,
        title: title || undefined,
        pageTitle:
          (identityReady ? item.pageTitle : undefined) ||
          (samePage && identityReady ? meta?.title : undefined) ||
          undefined,
        host: host || undefined,
        thumbnail,
        filename,
        displayName
      };
    }

    function mergePrefer(existing, incoming) {
      const out = { ...existing };
      for (const [key, value] of Object.entries(incoming)) {
        if (value == null || value === "") continue;
        if (key === "filename" || key === "displayName" || key === "title") {
          const previousBase = String(out[key] || "").replace(/\.[^.]+$/, "");
          const nextBase = String(value).replace(/\.[^.]+$/, "");
          if (!out[key] || Naming.isUglyBase(previousBase)) {
            if (!Naming.isUglyBase(nextBase)) out[key] = value;
          } else if (
            !Naming.isUglyBase(nextBase) &&
            nextBase.length > previousBase.length
          ) {
            if (
              titlesMatchVideo(previousBase, nextBase) ||
              !Naming.extractProductCode?.(previousBase)
            ) {
              out[key] = value;
            }
          }
          continue;
        }
        if (key === "thumbnail") {
          if (
            !out.thumbnail ||
            (String(value).startsWith("data:") &&
              !String(out.thumbnail).startsWith("data:"))
          ) {
            out.thumbnail = value;
          }
          continue;
        }
        out[key] = value;
      }
      return out;
    }

    function addMedia(tabId, item) {
      if (tabId == null || tabId < 0 || !item?.url) return;
      if (Naming.isJunkMedia(item)) return;

      const enriched = enrichItem(tabId, item);
      if (Naming.isJunkMedia(enriched)) return;

      const map = getTabMap(tabId);
      const key = item.url;
      const existing = map.get(key);
      if (existing) {
        map.set(key, {
          ...mergePrefer(existing, enriched),
          foundAt: existing.foundAt,
          id: existing.id,
          tabId
        });
      } else {
        map.set(key, {
          id: `${tabId}_${hashUrl(key)}`,
          foundAt: (deps.now || Date.now)(),
          tabId,
          ...enriched
        });
      }
      updateBadge(tabId);
      broadcastUpdate(tabId);
      if (enriched.isHls || enriched.type === "stream") maybeProbeHls(tabId, key);
    }

    function setTabMeta(tabId, meta) {
      if (tabId == null || tabId < 0 || !meta) return;
      const prev = tabMeta.get(tabId) || {};
      const nextUrl = meta.lastUrl || prev.lastUrl || "";
      const nextKey =
        meta.pageKey ||
        (nextUrl ? pageIdentityKey(nextUrl) : "") ||
        prev.pageKey ||
        "";
      const prevKey =
        prev.pageKey || (prev.lastUrl ? pageIdentityKey(prev.lastUrl) : "");
      const pageChanged = !!(prevKey && nextKey && prevKey !== nextKey);

      let title;
      if (pageChanged) {
        title = meta.title || undefined;
      } else if (Object.prototype.hasOwnProperty.call(meta, "title")) {
        title = meta.title || undefined;
      } else {
        title = prev.title;
      }

      const incomingThumbnail = thumbnailMatchesPageKey(
        meta.thumbnail,
        nextKey
      )
        ? meta.thumbnail
        : undefined;
      let thumbnail;
      if (pageChanged) {
        thumbnail = incomingThumbnail || undefined;
      } else if (Object.prototype.hasOwnProperty.call(meta, "thumbnail")) {
        thumbnail = incomingThumbnail || undefined;
      } else {
        thumbnail = prev.thumbnail;
      }

      const next = {
        title,
        thumbnail,
        host: meta.host || prev.host,
        lastUrl: nextUrl || prev.lastUrl,
        pageKey: nextKey || prevKey || undefined,
        videoId: pageChanged
          ? meta.videoId || undefined
          : Object.prototype.hasOwnProperty.call(meta, "videoId")
            ? meta.videoId || undefined
            : prev.videoId,
        identityConfirmed: pageChanged
          ? meta.identityConfirmed === true
          : Object.prototype.hasOwnProperty.call(meta, "identityConfirmed")
            ? meta.identityConfirmed === true
            : prev.identityConfirmed
      };

      if (pageChanged) tabMedia.delete(tabId);
      tabMeta.set(tabId, next);

      const map = tabMedia.get(tabId);
      if (!map) {
        if (pageChanged) {
          updateBadge(tabId);
          broadcastUpdate(tabId);
        }
        return;
      }
      let changed = pageChanged;
      for (const [url, item] of map) {
        let base = item;
        if (
          pageChanged ||
          (item.thumbnail &&
            next.pageKey &&
            item.pageUrl &&
            pageIdentityKey(item.pageUrl) !== next.pageKey)
        ) {
          base = {
            ...item,
            thumbnail:
              item.pageUrl && pageIdentityKey(item.pageUrl) === next.pageKey
                ? item.thumbnail
                : undefined
          };
        }
        const patched = enrichItem(tabId, base);
        if (
          patched.filename !== item.filename ||
          patched.thumbnail !== item.thumbnail ||
          patched.displayName !== item.displayName ||
          patched.title !== item.title
        ) {
          map.set(url, {
            ...item,
            ...patched,
            foundAt: item.foundAt,
            id: item.id,
            tabId
          });
          changed = true;
        }
      }
      if (changed) {
        updateBadge(tabId);
        broadcastUpdate(tabId);
      }
    }

    async function maybeProbeHls(tabId, url) {
      if (!url || probedUrls.has(url)) return;
      if (!/\.m3u8(\?|$|#)/i.test(url) && !url.includes("m3u8")) return;
      probedUrls.add(url);
      try {
        let info;
        await deps.withTabReferer(tabId, async () => {
          info = await HLS.probe(url);
        });
        const map = tabMedia.get(tabId);
        if (!map || !map.has(url) || !info) return;
        const cur = map.get(url);

        if (info.kind === "master" && info.variants?.length) {
          const best = info.variants[0];
          let mediaDuration = cur.duration;
          let segmentCount = cur.segmentCount;
          try {
            await deps.withTabReferer(tabId, async () => {
              const mediaInfo = await HLS.probe(best.url);
              if (mediaInfo.kind === "media") {
                mediaDuration = mediaInfo.duration || mediaDuration;
                segmentCount = mediaInfo.segmentCount;
              }
            });
          } catch {
            /* ignore */
          }
          const bandwidth = best.estimateBandwidth || best.bandwidth || 0;
          const duration = mediaDuration >= 1 ? mediaDuration : cur.duration;
          const estimatedSize =
            bandwidth > 0 && duration >= 1
              ? Math.round((bandwidth / 8) * duration)
              : undefined;
          const updated = enrichItem(tabId, {
            ...cur,
            isHls: true,
            type: "stream",
            format: "MP4",
            quality: best.quality || qualityLabel(best.height),
            width: best.width || cur.width,
            height: best.height || cur.height,
            bandwidth: best.bandwidth || undefined,
            duration: duration >= 1 ? duration : undefined,
            estimatedSize,
            segmentCount,
            isFmp4: true
          });
          map.set(url, {
            ...cur,
            ...updated,
            foundAt: cur.foundAt,
            id: cur.id,
            tabId
          });
        } else if (info.kind === "media") {
          const duration = info.duration >= 1 ? info.duration : cur.duration;
          const inferredHeight =
            Number(info.inferredHeight) ||
            (typeof HLS?.heightFromString === "function"
              ? HLS.heightFromString(url)
              : 0) ||
            cur.height ||
            0;
          const quality =
            (inferredHeight >= 240 && qualityLabel(inferredHeight)) ||
            (cur.quality && !/^(best|all|unknown)$/i.test(String(cur.quality))
              ? cur.quality
              : null);
          const updated = enrichItem(tabId, {
            ...cur,
            isHls: true,
            type: "stream",
            format: "MP4",
            duration: duration >= 1 ? duration : undefined,
            segmentCount: info.segmentCount,
            encrypted: info.encrypted,
            isFmp4: true,
            height: inferredHeight >= 240 ? inferredHeight : cur.height,
            quality: quality || cur.quality
          });
          map.set(url, {
            ...cur,
            ...updated,
            foundAt: cur.foundAt,
            id: cur.id,
            tabId
          });
        }
        updateBadge(tabId);
        broadcastUpdate(tabId);
      } catch {
        /* keep URL for download */
      }
    }

    function filterDisplayable(map) {
      let items = [...map.values()].filter((item) => {
        if (!item?.url) return false;
        if (Naming.isJunkMedia(item)) return false;
        if (item.type === "segment") return false;
        if (
          !item.isHls &&
          item.type !== "stream" &&
          (item.duration === 0 ||
            (typeof item.duration === "number" &&
              item.duration > 0 &&
              item.duration < 8))
        ) {
          return false;
        }
        if (
          item.type === "audio" ||
          item.type === "video" ||
          item.type === "stream" ||
          item.isHls
        ) {
          return true;
        }
        if (/\.(mp4|webm|m3u8|mp3|m4a)(\?|$|#)/i.test(item.url)) return true;
        if (item.url.startsWith("blob:")) return true;
        return false;
      });

      const hasReal = items.some(
        (item) =>
          !item.url.startsWith("blob:") &&
          (item.isHls ||
            item.type === "stream" ||
            /\.(mp4|webm|m3u8)(\?|$|#)/i.test(item.url) ||
            item.type === "video")
      );
      if (hasReal) items = items.filter((item) => !item.url.startsWith("blob:"));

      items = items.map((item) => enrichItem(item.tabId, item));
      const score = (item) => {
        let value = Naming.mediaScore(item);
        if ((item.url || "").startsWith("blob:")) value -= 300;
        if (/\.m3u8/i.test(item.url || "")) value += 450;
        if (item.source === "script-sniff" && /\.m3u8/i.test(item.url || "")) {
          value += 150;
        }
        if (item.duration && item.duration > 60) value += 80;
        return value;
      };
      items.sort((a, b) => score(b) - score(a));
      return items[0] ? [items[0]] : [];
    }

    function getMediaForTab(tabId) {
      const map = tabMedia.get(tabId);
      return map ? filterDisplayable(map) : [];
    }

    async function getMediaForTabAsync(tabId, hint = {}) {
      let items = getMediaForTab(tabId);
      const pageUrl = hint.pageUrl || "";
      const titleHint = hint.title || "";

      if (
        isDownloadableHelperPage(pageUrl) &&
        !isTiktokUrl(pageUrl)
      ) {
        const placeholder = makeSitePlaceholder({
          id: tabId,
          url: pageUrl,
          title: titleHint
        });
        if (placeholder) return [placeholder];
      }
      if (pageUrl && /^https?:/i.test(pageUrl) && isTiktokUrl(pageUrl)) {
        const cdn = (items || []).find(
          (item) =>
            item?.url &&
            /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(
              item.url
            )
        );
        if (cdn) return [cdn];
        const placeholder = makeSitePlaceholder({
          id: tabId,
          url: pageUrl,
          title: titleHint
        });
        if (placeholder) return [placeholder];
      }

      if (tabId == null) return items;
      try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab?.url || tab?.pendingUrl || pageUrl;
        if (!url || !/^https?:/i.test(url)) return items;
        if (
          isDownloadableHelperPage(url) &&
          !isTiktokUrl(url)
        ) {
          const placeholder = makeSitePlaceholder({
            id: tab.id,
            url,
            title: tab.title || titleHint
          });
          return placeholder ? [placeholder] : items;
        }
        if (isTiktokUrl(url)) {
          const cdn = (items || []).find(
            (item) =>
              item?.url &&
              /tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly/i.test(
                item.url
              ) &&
              !/tiktok\.com\/@|tiktok\.com\/t\//i.test(item.url)
          );
          if (cdn) {
            return [
              enrichItem(tab.id, {
                ...cdn,
                site: "tiktok",
                isSiteDownload: false,
                pageUrl: url,
                title: cdn.title || tab.title || titleHint
              })
            ];
          }
          const placeholder = makeSitePlaceholder({
            id: tab.id,
            url,
            title: tab.title || titleHint
          });
          return placeholder ? [placeholder] : items;
        }
      } catch (error) {
        (deps.console || console).warn("[UVD] getMediaForTabAsync", error);
        if (pageUrl && needsYtDlpHelper(pageUrl, pageUrl)) {
          const placeholder = makeSitePlaceholder({
            id: tabId,
            url: pageUrl,
            title: titleHint
          });
          if (placeholder) return [placeholder];
        }
      }
      return items;
    }

    function updateSocialBadge(tabId, url) {
      if (tabId == null) return;
      try {
        const social = !!(url && needsYtDlpHelper(url, url));
        if (social) {
          chrome.action.setBadgeText({ tabId, text: "↓" });
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" });
          chrome.action.setTitle({
            tabId,
            title: "이 페이지 영상 다운로드 가능"
          });
        } else {
          const map = tabMedia.get(tabId);
          const count = map ? filterDisplayable(map).length : 0;
          chrome.action.setBadgeText({
            tabId,
            text: count > 0 ? String(count) : ""
          });
          chrome.action.setTitle({ tabId, title: "Video Downloader" });
        }
      } catch {
        /* ignore */
      }
    }

    function updateBadge(tabId) {
      chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab?.url && needsYtDlpHelper(tab.url, tab.url)) {
            updateSocialBadge(tabId, tab.url);
            return;
          }
          return getMediaForTabAsync(tabId).then((items) => {
            const count = items?.length || 0;
            chrome.action.setBadgeText({
              tabId,
              text: count > 0 ? String(count) : ""
            });
          });
        })
        .catch(() => {
          const map = tabMedia.get(tabId);
          const count = map ? filterDisplayable(map).length : 0;
          chrome.action.setBadgeText({
            tabId,
            text: count > 0 ? String(count) : ""
          });
        });
    }

    function broadcastUpdate(tabId) {
      const meta = tabMeta.get(tabId);
      const pageUrl = meta?.lastUrl || "";
      const pageKey = meta?.pageKey || pageIdentityKey(pageUrl);
      const stillCurrent = () => {
        const current = tabMeta.get(tabId);
        const currentUrl = current?.lastUrl || "";
        const currentKey =
          current?.pageKey || pageIdentityKey(currentUrl);
        return currentUrl === pageUrl && currentKey === pageKey;
      };
      const immediatePlaceholder =
        getMediaForTab(tabId).length === 0
          ? makeSitePlaceholder({ id: tabId, url: pageUrl, title: "" })
          : null;
      if (immediatePlaceholder) {
        chrome.runtime
          .sendMessage({
            type: "MEDIA_UPDATED",
            tabId,
            pageUrl,
            pageKey,
            videoId: meta?.videoId,
            identityConfirmed: meta?.identityConfirmed === true,
            items: [immediatePlaceholder]
          })
          .catch(() => {});
        return;
      }
      getMediaForTabAsync(tabId)
        .then((items) => {
          if (!stillCurrent()) return;
          chrome.runtime
            .sendMessage({
              type: "MEDIA_UPDATED",
              tabId,
              pageUrl,
              pageKey,
              videoId: meta?.videoId,
              identityConfirmed: meta?.identityConfirmed === true,
              items: items || []
            })
            .catch(() => {});
        })
        .catch(() => {
          if (!stillCurrent()) return;
          chrome.runtime
            .sendMessage({
              type: "MEDIA_UPDATED",
              tabId,
              pageUrl,
              pageKey,
              videoId: meta?.videoId,
              identityConfirmed: meta?.identityConfirmed === true,
              items: getMediaForTab(tabId)
            })
            .catch(() => {});
        });
    }

    function clearMedia(tabId) {
      tabMedia.delete(tabId);
      updateBadge(tabId);
    }

    function deleteTab(tabId) {
      tabMedia.delete(tabId);
      tabMeta.delete(tabId);
    }

    function applyTabTitle(tabId, title) {
      setTabMeta(tabId, { title });
      const map = tabMedia.get(tabId);
      if (!map) return;
      for (const [url, item] of map) {
        if (!item.title || Naming.isUglyBase(item.title)) {
          map.set(url, {
            ...item,
            title,
            pageTitle: title,
            filename: Naming.buildFilename({
              title,
              pageTitle: title,
              quality: item.quality,
              type: item.type,
              isHls: item.isHls,
              isFmp4: true
            }),
            displayName: Naming.displayTitle({ title, pageTitle: title })
          });
        }
      }
      broadcastUpdate(tabId);
    }

    function requestTabRescan(tabId, pageUrl) {
      if (tabId == null || tabId < 0 || !chrome.tabs?.sendMessage) return;
      try {
        Promise.resolve(
          chrome.tabs.sendMessage(tabId, {
            type: "SCAN_NOW",
            reason: "navigation",
            pageUrl: pageUrl || ""
          })
        ).catch(() => {});
      } catch {
        // The content script may not be attached yet; popup load retries too.
      }
    }

    function bind() {
      if (bound) return;
      bound = true;

      chrome.webRequest.onHeadersReceived.addListener(
        (details) => {
          if (details.tabId < 0) return;
          if (
            details.method &&
            details.method !== "GET" &&
            details.method !== "HEAD"
          ) {
            return;
          }
          const headers = details.responseHeaders || [];
          const contentType =
            headers.find((header) => header.name.toLowerCase() === "content-type")
              ?.value || "";
          const contentLength = parseInt(
            headers.find(
              (header) => header.name.toLowerCase() === "content-length"
            )?.value || "0",
            10
          );
          if (!isLikelyMedia(details.url, contentType, contentLength)) return;
          const { type } = classifyMedia(details.url, contentType);
          addMedia(details.tabId, {
            url: details.url,
            type,
            source: "network",
            mime: contentType.split(";")[0].trim(),
            size: contentLength || undefined
          });
        },
        // Same resource types as onBeforeRequest: scripts, styles, images and
        // documents never carry media and would otherwise wake the worker for
        // every response in every tab.
        {
          urls: ["<all_urls>"],
          types: ["media", "xmlhttprequest", "other", "object"]
        },
        ["responseHeaders"]
      );

      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          if (details.tabId < 0) return;
          if (details.type === "media" || isLikelyMedia(details.url)) {
            if (/doubleclick|googlesyndication/i.test(details.url)) return;
            const { type } = classifyMedia(details.url);
            addMedia(details.tabId, {
              url: details.url,
              type,
              source: "network"
            });
          }
        },
        {
          urls: ["<all_urls>"],
          types: ["media", "xmlhttprequest", "other", "object"]
        }
      );

      chrome.tabs.onRemoved.addListener((tabId) => {
        deps.detachJobsFromTab(tabId);
        deleteTab(tabId);
      });

      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.url) {
          try {
            const prev = tabMeta.get(tabId)?.lastUrl || "";
            const next = changeInfo.url;
            const prevKey =
              tabMeta.get(tabId)?.pageKey || pageIdentityKey(prev);
            const nextKey = pageIdentityKey(next);
            const prevPath = prev
              ? new URL(prev).origin + new URL(prev).pathname
              : "";
            const nextPath = new URL(next).origin + new URL(next).pathname;
            const sameVideo =
              prevKey && nextKey
                ? prevKey === nextKey
                : prevPath && prevPath === nextPath;

            if (sameVideo) {
              setTabMeta(tabId, {
                lastUrl: next,
                pageKey: nextKey || prevKey
              });
            } else {
              deps.detachJobsFromTab(tabId);
              clearTabMediaState(tabId, { keepLastUrl: next });
              setTabMeta(tabId, {
                lastUrl: next,
                pageKey: nextKey,
                title: undefined,
                thumbnail: undefined,
                host: (() => {
                  try {
                    return new URL(next).hostname;
                  } catch {
                    return undefined;
                  }
                })()
              });
              requestTabRescan(tabId, next);
            }
            updateSocialBadge(tabId, next);
          } catch {
            deps.detachJobsFromTab(tabId);
            clearTabMediaState(tabId);
            updateBadge(tabId);
          }
        } else if (changeInfo.status === "complete" && tab?.url) {
          setTabMeta(tabId, {
            lastUrl: tab.url,
            pageKey: pageIdentityKey(tab.url),
            title: Naming.cleanPageTitle(tab.title || "") || undefined,
            host: (() => {
              try {
                return new URL(tab.url).hostname;
              } catch {
                return undefined;
              }
            })()
          });
          updateSocialBadge(tabId, tab.url);
          requestTabRescan(tabId, tab.url);
        }
        if (changeInfo.title) {
          const title = Naming.cleanPageTitle(changeInfo.title);
          if (title && !Naming.isUglyBase(title)) applyTabTitle(tabId, title);
        }
      });

      chrome.tabs.onActivated.addListener(async (info) => {
        try {
          const tab = await chrome.tabs.get(info.tabId);
          updateSocialBadge(info.tabId, tab?.url);
        } catch {
          /* ignore */
        }
      });
    }

    return {
      addMedia,
      bind,
      broadcastUpdate,
      clearMedia,
      clearTabMediaState,
      enrichItem,
      filterDisplayable,
      getMediaForTab,
      getMediaForTabAsync,
      getTabItems,
      getTabMap,
      getTabMeta,
      makeSitePlaceholder,
      maybeProbeHls,
      mergePrefer,
      pageIdentityKey,
      thumbnailMatchesPageKey,
      probedUrls,
      resolveFilename,
      setTabMeta,
      updateBadge,
      updateSocialBadge
    };
  }

  return { createStore };
});
