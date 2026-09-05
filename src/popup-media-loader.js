(function initPopupMediaLoader(root, factory) {
  const api = factory();
  root.UVDPopupMediaLoader = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupMediaLoader() {
    "use strict";

    function youtubeVideoId(rawUrl) {
      try {
        const url = new URL(rawUrl);
        const host = url.hostname.replace(/^www\./i, "").toLowerCase();
        if (host === "youtu.be") {
          return url.pathname.replace(/^\/+/, "").split("/")[0] || "";
        }
        if (!host.includes("youtube") && !host.includes("youtube-nocookie")) {
          return "";
        }
        const watchId = url.searchParams.get("v");
        if (watchId) return watchId;
        return url.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/i)?.[1] || "";
      } catch {
        return "";
      }
    }

    function youtubeThumbnailVideoId(rawUrl) {
      return (
        String(rawUrl || "").match(
          /(?:i\d*\.ytimg\.com|img\.youtube\.com)\/(?:vi|vi_webp)\/([^/?#]+)/i
        )?.[1] || ""
      );
    }

    function youtubeThumbnailForPage(pageUrl) {
      const videoId = youtubeVideoId(pageUrl);
      return videoId
        ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
        : "";
    }

    function isKnownCodePageUrl(rawUrl) {
      try {
        return /123av|missav|jable|avgle|netflav|supjav|njav|javdb|javlibrary|thisav|hanime/i.test(
          new URL(rawUrl).hostname
        );
      } catch {
        return false;
      }
    }

    function thumbnailMatchesPage(thumbnail, pageUrl) {
      const expected = youtubeVideoId(pageUrl);
      if (!expected) return true;
      return youtubeThumbnailVideoId(thumbnail) === expected;
    }

    function createLoader(deps) {
      const {
        chrome,
        listEl,
        pageHost,
        $,
        UVD,
        ensureSiteItems,
        pageKey,
        isInstagramUrl,
        isTiktokUrl,
        isYoutubeUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isSitePage,
        isHlsItem,
        cleanTitleText,
        isUglyName,
        refreshHelperStatus,
        render,
        patchMedia,
        loadAvailableQualities,
        loadPlaylistInfo,
        hidePlaylistBox,
        getAllItems,
        setAllItems,
        getCurrentTabId,
        setCurrentTabId,
        getCurrentTabUrl,
        setCurrentTabUrl,
        getAvailableQualities,
        setAvailableQualities,
        getQualitiesLoading,
        setQualitiesLoading
      } = deps;
      const delay = (ms) =>
        new Promise((resolve) =>
          (deps.setTimeout || setTimeout)(resolve, ms)
        );
      let loadSequence = 0;

      function restoreStablePage(tabLike = {}) {
        const current = getAllItems();
        const stable = ensureSiteItems(current, {
          ...tabLike,
          url: getCurrentTabUrl() || tabLike.url || ""
        });
        if (stable.length || current.length) setAllItems(stable);
        return stable;
      }

      function isSuperseded(requestId, tabLike = {}) {
        if (requestId === loadSequence) return false;
        restoreStablePage(tabLike);
        return true;
      }

      function usablePageTitle(raw) {
        const value =
          typeof cleanTitleText === "function"
            ? cleanTitleText(raw || "")
            : String(raw || "").trim();
        if (!value || value.length < 2) return "";
        if (typeof isUglyName === "function" && isUglyName(value)) return "";
        return value;
      }

      async function loadCurrentPageMeta(tabId, pageUrl) {
        const expectedKey = pageKey(pageUrl);
        const youtubeId = youtubeVideoId(pageUrl);
        const attempts = youtubeId ? 3 : 1;
        let lastMatching = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          let meta = null;
          try {
            meta = await chrome.tabs.sendMessage(
              tabId,
              {
                type: "GET_PAGE_META",
                pageUrl,
                expectedKey
              },
              { frameId: 0 }
            );
          } catch {
            meta = null;
          }
          const metaUrl = meta?.pageUrl || meta?.lastUrl || "";
          const metaKey = pageKey(metaUrl);
          const samePage =
            !!meta &&
            (!expectedKey || !metaKey || expectedKey === metaKey) &&
            (!youtubeId || !meta?.videoId || meta.videoId === youtubeId);
          if (samePage) {
            lastMatching = meta;
            if (
              !youtubeId ||
              (meta.identityConfirmed === true &&
                usablePageTitle(meta.title))
            ) {
              return meta;
            }
          }
          if (attempt + 1 < attempts) await delay(attempt === 0 ? 150 : 350);
        }
        if (youtubeId) {
          try {
            const probe = await chrome.runtime.sendMessage({
              type: "PROBE_PAGE_META",
              tabId,
              url: pageUrl,
              pageUrl,
              expectedKey: youtubeId
            });
            const probeIdentity =
              probe?.videoId ||
              youtubeThumbnailVideoId(probe?.thumbnail) ||
              youtubeVideoId(probe?.finalUrl || "");
            if (
              probe?.ok &&
              probeIdentity === youtubeId &&
              usablePageTitle(probe.title)
            ) {
              return {
                ...(lastMatching || {}),
                ...probe,
                pageUrl,
                videoId: youtubeId,
                identityConfirmed: true,
                thumbnail: thumbnailMatchesPage(probe.thumbnail, pageUrl)
                  ? probe.thumbnail
                  : youtubeThumbnailForPage(pageUrl)
              };
            }
          } catch {
            /* current-id thumbnail fallback remains available below */
          }
        }
        return lastMatching;
      }

      async function resolveActiveTab() {
        const queries = [
          { active: true, lastFocusedWindow: true },
          { active: true, currentWindow: true }
        ];
        for (const q of queries) {
          try {
            const tabs = await chrome.tabs.query(q);
            const t = tabs?.find(
              (x) =>
                x.id != null &&
                !String(x.url || "").startsWith("chrome-extension:")
            );
            if (t?.id) return t;
            if (tabs?.[0]?.id) return tabs[0];
          } catch {
            /* try next */
          }
        }
        return null;
      }

      function siteDisplayName(url) {
        if (isInstagramUrl(url)) return "Instagram";
        if (isTiktokUrl(url)) return "TikTok";
        if (isYoutubeUrl(url)) return "YouTube";
        if (isXUrl(url)) return "X";
        if (isFacebookUrl(url)) return "Facebook";
        if (isBilibiliUrl(url)) return "Bilibili";
        return "이 페이지";
      }

      function updateQuickPageUi() {
        const box = $("#quickBox");
        const btn = $("#btnThisPage");
        const hint = $("#quickHint");
        if (!box || !btn) return;
        const currentTabUrl = getCurrentTabUrl();
        const allItems = getAllItems();
        // Card already has primary download — hide duplicate quick CTA when video card is shown
        const hasCard = !!(allItems[0] && isSitePage(currentTabUrl));
        if (currentTabUrl && isSitePage(currentTabUrl) && !hasCard) {
          box.classList.remove("hidden");
          const name = siteDisplayName(currentTabUrl);
          btn.textContent = `이 ${name} 영상 받기`;
          if (hint) {
            hint.textContent =
              name === "Instagram"
                ? "로그인 후 가장 잘 받음 · Alt+Shift+D"
                : `바로 저장 · Alt+Shift+D`;
          }
        } else {
          box.classList.add("hidden");
        }
      }

      function autofillLinkFromCurrentTab() {
        const input = $("#linkInput");
        const currentTabUrl = getCurrentTabUrl();
        if (!input || !currentTabUrl) return;
        if (isSitePage(currentTabUrl)) {
          input.value = currentTabUrl;
          input.title = currentTabUrl;
        }
      }

      async function loadMedia(options = {}) {
        const requestId = ++loadSequence;
        let tab = await resolveActiveTab();
        if (isSuperseded(requestId, tab || {})) return;
        if (!tab?.id) {
          const stable = restoreStablePage({
            url: getCurrentTabUrl() || "",
            title: ""
          });
          if (stable.length) {
            if (!(typeof patchMedia === "function" && patchMedia())) render();
            return;
          }
          listEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">▶</div>
        <p class="empty-title">현재 탭을 찾지 못했어요</p>
        <p class="hint">영상 탭을 연 뒤 확장 프로그램을 다시 열어 주세요</p>
      </div>`;
          return;
        }

        // Refresh tab details (url is sometimes missing on first query)
        try {
          tab = await chrome.tabs.get(tab.id);
        } catch {
          /* keep query result */
        }
        if (isSuperseded(requestId, tab)) return;

        const previousTabUrl = getCurrentTabUrl();
        const nextTabUrl =
          tab.url || tab.pendingUrl || previousTabUrl || null;
        const previousKey = pageKey(previousTabUrl);
        const nextKey = pageKey(nextTabUrl);
        const navigationChanged = !!(
          previousKey &&
          nextKey &&
          previousKey !== nextKey
        );
        const knownCodePage = isKnownCodePageUrl(nextTabUrl);
        const suppressProvisionalTitle =
          options.navigation === true || navigationChanged;
        setCurrentTabId(tab.id);
        setCurrentTabUrl(nextTabUrl);
        let currentTabUrl = getCurrentTabUrl();
        if (navigationChanged) {
          const navigationTab =
            isSitePage(nextTabUrl)
              ? { ...tab, url: nextTabUrl, title: "" }
              : { ...tab, url: nextTabUrl };
          setAllItems(ensureSiteItems([], navigationTab));
          setAvailableQualities([{ id: "best", label: "최고" }]);
          setQualitiesLoading(false);
          render();
        }

        try {
          pageHost.textContent = currentTabUrl
            ? new URL(currentTabUrl).hostname
            : "탭 URL 없음";
        } catch {
          pageHost.textContent = currentTabUrl || "—";
        }

        // Debug host line: if not youtube but user thinks they are — show short url
        if (currentTabUrl && pageHost) {
          try {
            const u = new URL(currentTabUrl);
            pageHost.textContent =
              u.hostname +
              (u.pathname.length > 1 ? u.pathname.slice(0, 24) : "");
            pageHost.title = currentTabUrl;
          } catch {
            /* ignore */
          }
        }

        // YouTube often blocks content scripts — never rely only on SCAN
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" });
        } catch {
          /* restricted / not injected */
        }
        if (isSuperseded(requestId, tab)) return;

        // TikTok: SnapTik-style page JSON extract (playAddr / downloadAddr)
        if (isTiktokUrl(currentTabUrl)) {
          try {
            const ext = await chrome.tabs.sendMessage(tab.id, {
              type: "EXTRACT_TIKTOK"
            });
            if (ext?.urls?.length) {
              // Store on window for this session — merged via GET_MEDIA after PAGE_MEDIA
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch {
            /* ignore */
          }
        }
        if (isSuperseded(requestId, tab)) return;

        let res = null;
        const youtubeId = youtubeVideoId(currentTabUrl);
        try {
          res = await chrome.runtime.sendMessage({
            type: "GET_MEDIA",
            tabId: getCurrentTabId(),
            pageUrl: currentTabUrl,
            // Browser tab titles can lag behind a YouTube pushState URL.
            title:
              (youtubeId || knownCodePage) && suppressProvisionalTitle
                ? ""
                : tab.title || ""
          });
        } catch {
          res = null;
        }
        if (isSuperseded(requestId, tab)) return;

        const curKey = pageKey(currentTabUrl);
        const rawItems = (Array.isArray(res?.items) ? res.items : [])
          .filter((item) => {
            const itemKey = pageKey(item.pageUrl || item.url || "");
            return !itemKey || !curKey || itemKey === curKey;
          })
          .map((item) => {
            if (!youtubeId && !(knownCodePage && suppressProvisionalTitle)) {
              return item;
            }
            return {
              ...item,
              // A helper placeholder can be stamped with the new URL while
              // still carrying title/cover data from the previous SPA page.
              title: undefined,
              pageTitle: undefined,
              displayName: undefined,
              filename: undefined,
              thumbnail: youtubeId
                ? thumbnailMatchesPage(item.thumbnail, currentTabUrl)
                  ? item.thumbnail
                  : undefined
                : undefined
            };
          });
        const siteTab =
          (youtubeId || knownCodePage) && suppressProvisionalTitle
            ? { ...tab, title: "" }
            : tab;
        setAllItems(ensureSiteItems(rawItems, siteTab));

        // Ask the live top frame again after SCAN_NOW. YouTube can update the
        // URL before its player/title DOM; retry until both identities agree.
        if (getAllItems()[0]) {
          const meta = await loadCurrentPageMeta(tab.id, currentTabUrl);
          if (isSuperseded(requestId, tab)) return;

          try {
            const latestTab = await chrome.tabs.get(tab.id);
            const latestUrl = latestTab?.url || latestTab?.pendingUrl || "";
            const latestKey = pageKey(latestUrl);
            if (latestKey && curKey && latestKey !== curKey) {
              return loadMedia({ navigation: true });
            }
          } catch {
            /* keep the URL captured at the start of this request */
          }
          if (isSuperseded(requestId, tab)) return;

          const metaUrl = meta?.pageUrl || meta?.lastUrl || "";
          const metaKey = pageKey(metaUrl);
          const metaSamePage =
            !!meta && (!curKey || !metaKey || curKey === metaKey);
          const identityConfirmed =
            metaSamePage &&
            (!youtubeId ||
              (meta?.identityConfirmed === true &&
                (!meta?.videoId || meta.videoId === youtubeId)));
          const freshTitle = identityConfirmed
            ? usablePageTitle(meta?.title) ||
              (!youtubeId ? usablePageTitle(tab.title) : "")
            : !youtubeId
              ? usablePageTitle(tab.title)
              : "";
          const freshThumbnail = youtubeId
            ? metaSamePage &&
              thumbnailMatchesPage(meta?.thumbnail, currentTabUrl)
              ? meta.thumbnail
              : youtubeThumbnailForPage(currentTabUrl)
            : metaSamePage
              ? meta?.thumbnail || ""
              : "";

          setAllItems(
            getAllItems().map((item) => {
              const itemKey = pageKey(
                item.pageUrl || item.url || currentTabUrl
              );
              const samePage = !itemKey || !curKey || itemKey === curKey;
              const keepExisting =
                samePage && !youtubeId && !knownCodePage;
              return {
                ...item,
                thumbnail:
                  freshThumbnail ||
                  (keepExisting ? item.thumbnail : undefined) ||
                  undefined,
                title:
                  freshTitle ||
                  (keepExisting ? item.title : undefined) ||
                  undefined,
                pageTitle:
                  freshTitle ||
                  (keepExisting ? item.pageTitle : undefined) ||
                  undefined,
                displayName:
                  freshTitle ||
                  (keepExisting ? item.displayName : undefined) ||
                  undefined,
                filename:
                  freshTitle || !keepExisting ? undefined : item.filename
              };
            })
          );

          if (freshThumbnail || freshTitle || youtubeId) {
            chrome.runtime
              .sendMessage({
                type: "PAGE_META",
                tabId: getCurrentTabId(),
                pageUrl: currentTabUrl,
                pageMeta: {
                  ...(metaSamePage ? meta : {}),
                  lastUrl: currentTabUrl,
                  pageUrl: currentTabUrl,
                  videoId: youtubeId || meta?.videoId,
                  title: freshTitle || "",
                  thumbnail: freshThumbnail || ""
                }
              })
              .catch(() => {});
          }
        }

        // If HLS missing duration/size, ask background to probe then refresh list
        const first = getAllItems()[0];
        if (
          first &&
          isHlsItem(first) &&
          !first.isSiteDownload &&
          !(first.duration >= 1)
        ) {
          try {
            await chrome.runtime.sendMessage({
              type: "PROBE_HLS",
              url: first.url,
              tabId: getCurrentTabId()
            });
            await new Promise((r) => setTimeout(r, 600));
            res = await chrome.runtime.sendMessage({
              type: "GET_MEDIA",
              tabId: getCurrentTabId(),
              pageUrl: currentTabUrl
            });
            if (res?.items?.length) {
              setAllItems(ensureSiteItems(res.items, tab));
            }
          } catch {
            /* ignore */
          }
        }
        if (isSuperseded(requestId, tab)) return;

        await refreshHelperStatus(true);
        if (isSuperseded(requestId, tab)) return;
        updateQuickPageUi();
        // Auto-fill link input with current social page URL
        autofillLinkFromCurrentTab();

        // First paint (may show "화질 확인 중…")
        setQualitiesLoading(true);
        if (!(typeof patchMedia === "function" && patchMedia())) render();
        // Then resolve real available qualities for this video
        if (getAllItems()[0]) {
          await loadAvailableQualities(getAllItems()[0]);
        } else {
          setAvailableQualities([{ id: "best", label: "최고" }]);
          setQualitiesLoading(false);
        }
        if (isSuperseded(requestId, tab)) return;
        render();

        currentTabUrl = getCurrentTabUrl();
        // Playlist panel (YouTube /playlist?list= or watch+list)
        if (
          currentTabUrl &&
          (UVD.isPlaylistOnlyUrl(currentTabUrl) ||
            UVD.isWatchInPlaylistUrl?.(currentTabUrl))
        ) {
          loadPlaylistInfo(currentTabUrl).catch(() => {});
        } else {
          hidePlaylistBox();
        }
      }

      // Read getters too so dependency contracts stay symmetric and testable.
      void getAvailableQualities;
      void getQualitiesLoading;

      return {
        resolveActiveTab,
        loadMedia,
        siteDisplayName,
        updateQuickPageUi,
        autofillLinkFromCurrentTab,
        usablePageTitle,
        loadCurrentPageMeta
      };
    }

    return {
      createLoader,
      thumbnailMatchesPage,
      youtubeThumbnailForPage,
      youtubeThumbnailVideoId,
      youtubeVideoId
    };
  }
);
