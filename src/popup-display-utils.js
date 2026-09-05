(function initPopupDisplayUtils(root, factory) {
  const api = factory();
  root.UVDPopupDisplayUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupDisplayUtils() {
    "use strict";

    function createUtils(deps) {
      const documentRef = deps.document;
      const setTimeoutFn = deps.setTimeout || setTimeout;
      const URLCtor = deps.URL || URL;
      const getCurrentTabUrl = deps.getCurrentTabUrl || (() => null);
      const getAllItems = deps.getAllItems || (() => []);
      const getUvdSettings = deps.getUvdSettings || (() => ({}));
      const getSelectedQuality = deps.getSelectedQuality || (() => "");
      const now = deps.now || (() => Date.now());
      const lastGoodItemsByPage = new Map();

      const isKnownDownloadablePage = (url) =>
        typeof deps.isKnownDownloadablePage === "function"
          ? deps.isKnownDownloadablePage(url)
          : deps.isSitePage(url);

      function buildLocalSiteItem(tab = {}) {
        const pageUrl = tab.url || getCurrentTabUrl() || "";
        const helperItem = deps.UVDSites.buildSiteItem(tab, pageUrl);
        if (helperItem) return helperItem;
        if (!isKnownDownloadablePage(pageUrl)) return null;

        const host = (() => {
          try {
            return new URLCtor(pageUrl).hostname.replace(/^www\./i, "");
          } catch {
            return "";
          }
        })();
        const code = deps.Naming.extractProductCode?.(pageUrl) || "";
        const rawTitle =
          deps.Naming.cleanPageTitle?.(tab.title || "") ||
          String(tab.title || "").trim();
        const title =
          (rawTitle &&
          !deps.UVDPopupMedia.isUglyName?.(rawTitle) &&
          !deps.UVD.isGenericSaveName?.(rawTitle)
            ? deps.Naming.bindTitleToPage?.(pageUrl, rawTitle) || rawTitle
            : "") ||
          code ||
          "영상";
        const filename =
          deps.Naming.buildFilename?.({
            title,
            pageTitle: title,
            pageUrl,
            url: pageUrl,
            type: "video",
            isHls: false
          }) || `${title}.mp4`;
        return {
          url: pageUrl,
          pageUrl,
          type: "page",
          isHls: false,
          isSiteDownload: false,
          isPagePlaceholder: true,
          source: "page-placeholder",
          title,
          pageTitle: title,
          displayName: title,
          filename,
          quality: "",
          format: "MP4",
          host
        };
      }

      function toast(msg, kind = "") {
        const el = documentRef.createElement("div");
        el.className = `toast ${kind}`;
        el.textContent = msg;
        documentRef.body.appendChild(el);
        setTimeoutFn(() => el.remove(), 2800);
      }

      const cleanTitleText = (raw) =>
        deps.UVDPopupMedia.cleanTitleText(raw, deps.Naming);

      function siteLabel() {
        try {
          if (
            deps.pageHost?.textContent &&
            deps.pageHost.textContent !== "—"
          ) {
            return deps.pageHost.textContent
              .replace(/^https?:\/\//i, "")
              .replace(/^www\./, "")
              .split("/")[0];
          }
        } catch {
          /* ignore */
        }
        return "";
      }

      const displayName = (item) =>
        deps.UVDPopupMedia.displayName(item, {
          currentTabUrl: getCurrentTabUrl(),
          Naming: deps.Naming
        });

      const downloadFilename = (item) =>
        deps.UVDPopupMedia.downloadFilename(item, {
          currentTabUrl: getCurrentTabUrl(),
          selectedQuality: getSelectedQuality(),
          mediaMode: getUvdSettings().mediaMode || "video",
          Naming: deps.Naming,
          UVD: deps.UVD
        });

      function escapeHtml(s) {
        return String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function escapeAttr(s) {
        return escapeHtml(s).replace(/'/g, "&#39;");
      }

      function thumbHtml(item) {
        const src = item.thumbnail;
        if (src) {
          return `<img class="thumb-img" src="${escapeAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
        }
        return `<span class="thumb-fallback">🎬</span>`;
      }

      function formatTimeAgo(ts) {
        const d = now() - (ts || 0);
        if (d < 60_000) return "방금";
        if (d < 3600_000) return `${Math.floor(d / 60_000)}분 전`;
        if (d < 86400_000) return `${Math.floor(d / 3600_000)}시간 전`;
        return `${Math.floor(d / 86400_000)}일 전`;
      }

      function formatDurShort(sec) {
        if (!sec || sec < 1) return "";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        if (m >= 60) {
          const h = Math.floor(m / 60);
          return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
        return `${m}:${String(s).padStart(2, "0")}`;
      }

      function updateLinkCount() {
        const text = deps.$("#linkInput")?.value || "";
        const urls = deps.UVD.parseUrlsFromText(text);
        const el = deps.$("#linkCount");
        if (el) {
          el.textContent =
            urls.length > 1
              ? `${urls.length}개 링크 (일괄)`
              : urls.length === 1
                ? "1개 링크"
                : "0개 링크";
        }
        return urls;
      }

      function userError(err) {
        if (!err) return null;
        const s = String(err);

        try {
          if (typeof deps.UVD?.classifyError === "function") {
            const meta = deps.UVD.classifyError(s);
            if (meta && meta.code && meta.code !== "other") {
              const label = meta.label || "";
              const hint = meta.hint || "";
              if (label && hint) return `${label} — ${hint}`;
              if (label) return label;
              if (hint) return hint;
            }
          }
        } catch {
          /* fall through */
        }

        if (/파일 저장 실패|다운로드 시작 실패|Invalid filename|invalid filename|filename/i.test(s)) {
          return "파일 저장에 실패했습니다. 확장 프로그램을 새로고침한 뒤 다시 받아 주세요 (파일명·권한 문제일 수 있음)";
        }
        if (/다운로드가 완료되지 않았습니다|chrome:\/\/downloads/i.test(s)) {
          return "다운로드가 중간에 끊겼습니다. chrome://downloads 에서 확인하거나 다시 받아 주세요";
        }
        if (/파일이 너무 작|세그먼트 부족|병합 결과|빈 파일/i.test(s)) {
          return "영상 데이터가 불완전합니다. 페이지에서 재생을 누른 뒤 다시 받아 주세요";
        }
        if (/403|접근 거부|Segment HTTP/i.test(s)) {
          return "접근이 거부되었습니다 (403). 페이지를 열어 재생한 직후 다시 시도하세요";
        }
        if (/도우미|8787|yt-dlp not|연결할 수 없/i.test(s)) {
          return "로컬 도우미가 필요합니다. helper/start.command 를 실행한 뒤 다시 시도하세요";
        }
        if (
          /No URL|URL 없음|url required|invalid url|Invalid URL|not a valid URL|미디어 URL|url is/i.test(
            s
          )
        ) {
          return "받을 주소가 없습니다. 페이지를 새로고침한 뒤 재생해 주세요";
        }
        if (/TikTok|틱톡|재생 주소|페이지에서 재생/i.test(s)) {
          let clean = s.replace(/^Error:\s*/i, "").trim();
          if (clean.length > 120) clean = clean.slice(0, 117) + "…";
          return clean;
        }
        if (/Failed to fetch|NetworkError|네트워크 접근|CORS|Load failed/i.test(s)) {
          return "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 눌러 주세요";
        }
        if (/재생목록 URL|m3u8|playlist only/i.test(s) && /직접 저장|병합/i.test(s)) {
          return "스트리밍 영상을 합치는 중 문제가 생겼습니다. 다시 시도해 주세요";
        }
        if (/Blob URL|blob/i.test(s) && /Capture|캡처|받을 수/i.test(s)) {
          return "이 영상 형식을 바로 받을 수 없습니다. 재생 후 다시 시도해 주세요";
        }
        if (/도우미|install_autostart|start\.command|yt-dlp not|ytdlp|8787/i.test(s)) {
          return "로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요";
        }
        if (/Instagram|인스타/i.test(s)) {
          let clean = s.replace(/^Error:\s*/i, "").trim();
          if (clean.length > 120) clean = clean.slice(0, 117) + "…";
          return clean;
        }
        if (/DRM|SAMPLE-AES|Widevine/i.test(s)) return "보호된 영상이라 받을 수 없습니다";
        if (/Segment HTTP 403|세그먼트.*403|조각 접근|CDN이 접근/i.test(s)) {
          return "영상 조각 접근이 막혔습니다(403). 페이지에서 재생을 누른 직후 바로 다시 받아 주세요";
        }
        if (/HTTP 403|HTTP 401|접근 거부/i.test(s)) {
          return "접근이 거부되었습니다. 로그인·재생 후 다시 시도해 주세요";
        }
        if (/HTTP \d{3}/i.test(s)) {
          return "서버에서 영상을 주지 않았습니다. 재생 후 다시 시도해 주세요";
        }
        if (/너무 작|세그먼트 부족|병합 실패|유효한 세그먼트|조각 \d+\/\d+/i.test(s)) {
          return "영상 조각을 충분히 받지 못했습니다. 재생 직후 다시 시도해 주세요";
        }
        if (/시간 초과|timeout/i.test(s)) return "시간이 초과되었습니다. 다시 시도해 주세요";
        if (/Could not establish connection|Receiving end|Extension context/i.test(s)) {
          return "페이지를 새로고침한 뒤 다시 시도해 주세요";
        }
        if (/offscreen|OFFSCREEN|빈 청크|IndexedDB에 영상/i.test(s)) {
          return "저장 중 문제가 생겼습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요";
        }
        if (/파일 저장 실패/i.test(s)) {
          return s.length < 120
            ? s
            : "파일 저장에 실패했습니다. chrome://downloads 를 확인해 주세요";
        }
        if (/다운로드가 중단|USER_CANCELED|NETWORK_FAILED/i.test(s)) {
          return "다운로드가 중단되었습니다. 다시 시도해 주세요";
        }

        let clean = s.replace(/^Error:\s*/i, "").trim();
        if (/[가-힣]/.test(clean)) {
          if (clean.length > 120) return clean.slice(0, 117) + "…";
          return clean;
        }
        if (/^https?:\/\//i.test(clean) || (/url/i.test(clean) && clean.length < 40)) {
          return "받을 수 없는 주소입니다. 페이지를 새로고침한 뒤 재생해 주세요";
        }
        if (/^[A-Za-z0-9\s:./_-]+$/.test(clean) && /url|fetch|http|blob|null|undefined/i.test(clean)) {
          return "다운로드에 실패했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요";
        }
        if (clean.length > 90) return clean.slice(0, 87) + "…";
        return clean || "다운로드에 실패했습니다";
      }

      function pageKey(url) {
        if (!url) return "";
        try {
          const u = new URLCtor(url);
          const host = u.hostname.replace(/^www\./i, "").toLowerCase();
          const path = u.pathname || "/";
          if (host === "youtu.be") {
            return `yt:${path.replace(/^\//, "").split("/")[0]}`;
          }
          if (host.includes("youtube")) {
            const v = u.searchParams.get("v");
            if (v) return `yt:${v}`;
            const m = path.match(/\/(shorts|embed|live|clip)\/([^/?#]+)/i);
            if (m) return `yt:${m[1]}:${m[2]}`;
            return `yt:${path}`;
          }
          if (host.includes("tiktok")) {
            const m = path.match(/\/@[^/]+\/video\/(\d+)/i);
            if (m) return `tt:${m[1]}`;
            return `tt:${path}`;
          }
          if (host.includes("instagram") || host.includes("instagr.am")) {
            const m = path.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
            if (m) return `ig:${m[1]}:${m[2]}`;
            return `ig:${path}`;
          }
          if (deps.Naming.isKnownCodeSite?.(host)) {
            const code = deps.Naming.extractProductCode?.(u.href) || "";
            if (code) return `${host}:code:${code.toUpperCase()}`;
          }
          return `${host}${path}`;
        } catch {
          return String(url).slice(0, 120);
        }
      }

      function textScore(value) {
        const raw = String(value || "").trim();
        if (!raw) return -1000;
        const base = raw.replace(/\.(mp4|webm|mkv|mp3|m4a)$/i, "");
        if (
          deps.UVD.isGenericSaveName?.(base) ||
          deps.UVDPopupMedia.isUglyName?.(base)
        ) {
          return -500 + base.length;
        }
        const qualityOnly = /[_\s-](?:4k|\d{3,4}p)$/i.test(base);
        return base.length + (qualityOnly ? -20 : 20);
      }

      function preferStableText(previous, incoming) {
        return textScore(incoming) >= textScore(previous)
          ? incoming
          : previous;
      }

      function mergeStableItem(previous, incoming) {
        if (!previous) return { ...incoming };
        if (!incoming) return { ...previous };
        if (incoming.isPagePlaceholder && !previous.isPagePlaceholder) {
          return { ...previous };
        }
        const previousKey = pageKey(previous.pageUrl || previous.url || "");
        const incomingKey = pageKey(incoming.pageUrl || incoming.url || "");
        const samePage = !!(
          previousKey &&
          incomingKey &&
          previousKey === incomingKey
        );
        const sameMedia = !!(previous.url && incoming.url && previous.url === incoming.url);
        return {
          ...previous,
          ...incoming,
          isPagePlaceholder: incoming.isPagePlaceholder === true,
          title: preferStableText(previous.title, incoming.title),
          pageTitle: preferStableText(
            previous.pageTitle,
            incoming.pageTitle
          ),
          displayName: preferStableText(
            previous.displayName,
            incoming.displayName
          ),
          filename: preferStableText(previous.filename, incoming.filename),
          thumbnail:
            incoming.thumbnail ||
            (samePage ? previous.thumbnail : undefined),
          quality: incoming.quality || previous.quality,
          duration:
            incoming.duration ||
            (sameMedia ? previous.duration : incoming.duration),
          estimatedSize:
            incoming.estimatedSize ||
            (sameMedia ? previous.estimatedSize : incoming.estimatedSize)
        };
      }

      function rememberStableItems(key, items) {
        if (!key || !items?.length) return;
        const current = lastGoodItemsByPage.get(key);
        if (
          current?.[0] &&
          current[0].isPagePlaceholder !== true &&
          items.every((item) => item.isPagePlaceholder === true)
        ) {
          return;
        }
        lastGoodItemsByPage.set(
          key,
          items.map((item) => ({ ...item }))
        );
        if (lastGoodItemsByPage.size > 12) {
          lastGoodItemsByPage.delete(lastGoodItemsByPage.keys().next().value);
        }
      }

      function ensureSiteItems(items, tabLike) {
        const source = items == null ? getAllItems() : items;
        let list = Array.isArray(source)
          ? source.map((item) => ({ ...item }))
          : [];
        const url = getCurrentTabUrl() || tabLike?.url || "";
        const curKey = pageKey(url);
        const cached = lastGoodItemsByPage.get(curKey) || [];
        if (!isKnownDownloadablePage(url)) return list;

        if (!list.length && cached.length) {
          return cached.map((item) => ({
            ...item,
            pageUrl: url || item.pageUrl
          }));
        }

        const local = buildLocalSiteItem(tabLike || { url, title: "" });
        if (!local) return list;
        if (!list.length) {
          const fallback = [local];
          rememberStableItems(curKey, fallback);
          return fallback;
        }

        let top = list[0];
        const topKey = pageKey(top.pageUrl || top.url || "");
        const samePage = !topKey || !curKey || topKey === curKey;
        if (samePage && cached[0]) {
          top = mergeStableItem(cached[0], top);
        }
        const helperPage =
          local.isSiteDownload === true || deps.isSitePage(url);
        if (!helperPage) {
          const stable = samePage
            ? {
                ...local,
                ...top,
                pageUrl: url || top.pageUrl,
                isSiteDownload: false,
                isPagePlaceholder: !!top.isPagePlaceholder
              }
            : local;
          const result = [stable];
          rememberStableItems(curKey, result);
          return result;
        }
        const thumb = samePage
          ? top.thumbnail || local.thumbnail
          : local.thumbnail;
        const title = samePage
          ? top.title || local.title
          : local.title || top.title;
        const pageTitle = samePage
          ? top.pageTitle || local.pageTitle
          : local.pageTitle || top.pageTitle;

        const result = [
          {
            ...local,
            ...(samePage ? top : {}),
            url: local.url,
            pageUrl: local.pageUrl,
            isSiteDownload: true,
            site: local.site,
            title,
            pageTitle,
            displayName: samePage
              ? top.displayName || local.displayName
              : local.displayName,
            filename: samePage
              ? top.filename || local.filename
              : local.filename,
            thumbnail: thumb || undefined
          }
        ];
        rememberStableItems(curKey, result);
        return result;
      }

      return {
        buildLocalSiteItem,
        toast,
        cleanTitleText,
        siteLabel,
        displayName,
        downloadFilename,
        thumbHtml,
        formatTimeAgo,
        formatDurShort,
        updateLinkCount,
        escapeHtml,
        escapeAttr,
        userError,
        pageKey,
        ensureSiteItems
      };
    }

    return { createUtils };
  }
);
