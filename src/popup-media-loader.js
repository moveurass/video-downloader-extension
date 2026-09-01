(function initPopupMediaLoader(root, factory) {
  const api = factory();
  root.UVDPopupMediaLoader = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupMediaLoader() {
    "use strict";

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
        refreshHelperStatus,
        render,
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

      async function loadMedia() {
        let tab = await resolveActiveTab();
        if (!tab?.id) {
          listEl.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🎬</div>
        <p>탭을 찾지 못했습니다.</p>
        <p class="hint">YouTube 영상 탭을 연 뒤 확장을 다시 열어 주세요.</p>
      </div>`;
          return;
        }

        // Refresh tab details (url is sometimes missing on first query)
        try {
          tab = await chrome.tabs.get(tab.id);
        } catch {
          /* keep query result */
        }

        setCurrentTabId(tab.id);
        setCurrentTabUrl(
          tab.url || tab.pendingUrl || getCurrentTabUrl() || null
        );
        let currentTabUrl = getCurrentTabUrl();

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

        let res = null;
        try {
          res = await chrome.runtime.sendMessage({
            type: "GET_MEDIA",
            tabId: getCurrentTabId(),
            pageUrl: currentTabUrl,
            title: tab.title || ""
          });
        } catch {
          res = null;
        }
        setAllItems(
          ensureSiteItems(Array.isArray(res?.items) ? res.items : [], tab)
        );

        // Ensure thumbnail / title from *current* page only (never keep previous video thumb)
        if (getAllItems()[0]) {
          try {
            const meta = await chrome.tabs.sendMessage(tab.id, {
              type: "GET_PAGE_META"
            });
            if (meta?.thumbnail || meta?.title) {
              const curKey = pageKey(currentTabUrl);
              setAllItems(
                getAllItems().map((i) => {
                  const itemKey = pageKey(
                    i.pageUrl || i.url || currentTabUrl
                  );
                  const same = !itemKey || !curKey || itemKey === curKey;
                  return {
                    ...i,
                    // Prefer fresh page meta thumb; drop mismatched old thumbs
                    thumbnail: same
                      ? meta.thumbnail || i.thumbnail || undefined
                      : meta.thumbnail || undefined,
                    title:
                      meta.title ||
                      (i.title &&
                      !/^YouTube|TikTok|Instagram/i.test(i.title)
                        ? i.title
                        : "") ||
                      i.title,
                    pageTitle: meta.title || i.pageTitle
                  };
                })
              );
              chrome.runtime
                .sendMessage({
                  type: "PAGE_META",
                  tabId: getCurrentTabId(),
                  pageUrl: currentTabUrl,
                  pageMeta: {
                    ...meta,
                    lastUrl: currentTabUrl,
                    // Clear if page has no thumb yet — don't leave previous
                    thumbnail: meta.thumbnail || undefined
                  }
                })
                .catch(() => {});
            } else {
              // No meta from page — strip thumbs that don't match current URL
              const curKey = pageKey(currentTabUrl);
              setAllItems(
                getAllItems().map((i) => {
                  const itemKey = pageKey(i.pageUrl || i.url || "");
                  if (itemKey && curKey && itemKey !== curKey) {
                    return { ...i, thumbnail: undefined };
                  }
                  return i;
                })
              );
            }
          } catch {
            /* YouTube often blocks CS — use tab title; clear foreign thumbs */
            const curKey = pageKey(currentTabUrl);
            const allItems = getAllItems();
            if (allItems[0]) {
              const itemKey = pageKey(
                allItems[0].pageUrl || allItems[0].url || ""
              );
              if (itemKey && curKey && itemKey !== curKey) {
                allItems[0].thumbnail = undefined;
              }
            }
            if (tab.title && allItems[0]) {
              const t = tab.title.replace(/\s*[-–—|].*$/, "").trim();
              if (t && t.length > 2) {
                allItems[0].title = t;
                allItems[0].pageTitle = t;
                allItems[0].displayName = t;
              }
            }
            setAllItems(allItems);
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
            if (res?.items?.length) setAllItems(res.items);
          } catch {
            /* ignore */
          }
        }

        await refreshHelperStatus();
        updateQuickPageUi();
        // Auto-fill link input with current social page URL
        autofillLinkFromCurrentTab();

        // First paint (may show "화질 확인 중…")
        setQualitiesLoading(true);
        render();
        // Then resolve real available qualities for this video
        if (getAllItems()[0]) {
          await loadAvailableQualities(getAllItems()[0]);
        } else {
          setAvailableQualities([{ id: "best", label: "최고" }]);
          setQualitiesLoading(false);
        }
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
        autofillLinkFromCurrentTab
      };
    }

    return { createLoader };
  }
);
