(function initPopupMediaRenderer(root, factory) {
  const api = factory();
  root.UVDPopupMediaRenderer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupMediaRenderer() {
    "use strict";

    function primaryDownloadLabel(name, site) {
      const title = String(name || "").trim();
      if (title && !/^(?:영상|동영상|video|media|audio)$/i.test(title)) {
        return `${title} 받기`;
      }
      const siteName = String(site || "")
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .trim();
      return siteName ? `${siteName} 영상 받기` : "영상 받기";
    }

    function needsRemoteThumbHydration(url) {
      const value = String(url || "").trim();
      return !!value && /^https?:/i.test(value);
    }

    function createRenderer(deps) {
      const {
        listEl,
        chrome,
        document,
        ensureSiteItems,
        syncGlobalQualityBox,
        isInstagramHost,
        isInstagramPostUrl,
        isYoutubeUrl,
        isTiktokUrl,
        isDownloadableSiteVideo,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        escapeHtml,
        escapeAttr,
        displayName,
        downloadFilename,
        siteLabel,
        thumbHtml,
        metaRowsHtml,
        estimateBarHtml,
        qualityPickerHtml,
        trackPickerHtml = () => "",
        bindTrackPicker = () => {},
        isOnlyBareBest,
        formatQualityChipLabel,
        loadAvailableQualities,
        canStartAnotherDownload,
        downloadItem,
        isWatchlistableUrl,
        addCurrentToWatchlist,
        offerSeriesComplete,
        toast,
        MAX_CONCURRENT_STARTS,
        getAllItems,
        setAllItems,
        getCurrentTabUrl,
        getCurrentTabId,
        getSelectedQuality,
        setSelectedQuality,
        getAvailableQualities,
        getQualitiesLoading,
        getSeriesPending
      } = deps;

      function mediaIdentity(item, currentTabUrl) {
        const pageUrl = item?.pageUrl || currentTabUrl || "";
        const key =
          (typeof deps.pageKey === "function" && deps.pageKey(pageUrl)) ||
          pageUrl;
        return `${key}\n${
          item?.isPagePlaceholder ? "placeholder" : "media"
        }\n${item?.url || ""}`;
      }

      function replaceThumbWithFallback(img) {
        if (!img?.replaceWith || !document?.createElement) return;
        img.replaceWith(
          Object.assign(document.createElement("span"), {
            className: "thumb-fallback",
            textContent: "🎬"
          })
        );
      }

      function liveCard() {
        return listEl?.querySelector?.(".card") || null;
      }

      function applyThumbSrc(card, dataUrl) {
        const target = card || liveCard();
        if (!target || !dataUrl) return;
        const img = target.querySelector?.(".thumb-img");
        if (img) {
          if (img.getAttribute?.("src") !== dataUrl) {
            img.setAttribute("src", dataUrl);
          }
          if (img.removeAttribute) img.removeAttribute("data-thumb-url");
          return;
        }
        const thumb = target.querySelector?.(".thumb");
        if (thumb && typeof thumbHtml === "function") {
          thumb.innerHTML = thumbHtml({ thumbnail: dataUrl });
          bindThumbFallback(target);
        }
      }

      function bindThumbFallback(card, item) {
        const img = card?.querySelector?.(".thumb-img");
        if (!img?.addEventListener) return;
        img.addEventListener("error", async () => {
          const src = img.getAttribute?.("src") || "";
          if (!src) return;
          if (String(src).startsWith("data:")) {
            replaceThumbWithFallback(img);
            return;
          }
          const fetchThumb = deps.fetchThumbDataUrl;
          if (
            typeof fetchThumb === "function" &&
            needsRemoteThumbHydration(src) &&
            img.dataset?.thumbTried !== "1"
          ) {
            if (img.dataset) img.dataset.thumbTried = "1";
            try {
              const dataUrl = await fetchThumb(src, item?.pageUrl || item?.url || "");
              if (dataUrl) {
                if (item) item.thumbnail = dataUrl;
                img.setAttribute("src", dataUrl);
                return;
              }
            } catch {
              /* fall through */
            }
          }
          replaceThumbWithFallback(img);
        });
      }

      let hydrateGeneration = 0;

      function pageKeyOf(url) {
        return (
          (typeof deps.pageKey === "function" && deps.pageKey(url)) ||
          String(url || "")
        );
      }

      function thumbStillCurrent(item, generation) {
        if (generation !== hydrateGeneration) return false;
        const liveUrl =
          typeof getCurrentTabUrl === "function" ? getCurrentTabUrl() : "";
        const liveKey = pageKeyOf(liveUrl);
        const itemKey = pageKeyOf(item?.pageUrl || item?.url || "");
        if (liveKey && itemKey && liveKey !== itemKey) return false;
        const card = liveCard();
        const liveItem =
          typeof getAllItems === "function" ? getAllItems()[0] : null;
        if (card?.dataset?.mediaIdentity && liveItem) {
          const identity = mediaIdentity(liveItem, liveUrl);
          if (card.dataset.mediaIdentity !== identity) return false;
        }
        return true;
      }

      async function hydrateRemoteThumbnails(items, generation) {
        const fetchThumb = deps.fetchThumbDataUrl;
        if (typeof fetchThumb !== "function") return;
        const gen =
          generation == null ? hydrateGeneration : generation;
        await Promise.all(
          (items || []).map(async (item) => {
            const url = String(item?.thumbnail || "");
            const pageUrl = item.pageUrl || item.url || "";
            const pageKey = pageKeyOf(pageUrl);
            if (url.startsWith("data:image/")) {
              if (thumbStillCurrent(item, gen)) applyThumbSrc(liveCard(), url);
              return;
            }
            if (!needsRemoteThumbHydration(url)) return;
            try {
              const dataUrl = await fetchThumb(url, pageUrl, {
                pageKey,
                videoId: pageKey
              });
              if (!dataUrl || !thumbStillCurrent(item, gen)) return;
              item.thumbnail = dataUrl;
              if (pageKey) item.thumbnailPageKey = pageKey;
              applyThumbSrc(liveCard(), dataUrl);
            } catch {
              /* pending img stays empty until a later hydrate */
            }
          })
        );
      }

      function scheduleThumbHydration(items) {
        if (typeof deps.fetchThumbDataUrl !== "function") return;
        const generation = ++hydrateGeneration;
        Promise.resolve()
          .then(() => hydrateRemoteThumbnails(items, generation))
          .catch(() => {});
      }

      function resolveRenderTabLike(currentTabUrl, allItems) {
        const pasteUrl =
          typeof deps.getPastedTiktokPreviewUrl === "function"
            ? deps.getPastedTiktokPreviewUrl(currentTabUrl)
            : "";
        return {
          url: pasteUrl || currentTabUrl,
          title: allItems[0]?.title || ""
        };
      }

      function render() {
        const currentTabUrl = getCurrentTabUrl();
        let allItems = getAllItems();

        // Always re-apply YT/TT card before paint. A pasted TikTok
        // permalink wins over Explore/FYP so the visible card matches
        // what 받기 will download.
        allItems = ensureSiteItems(
          allItems,
          resolveRenderTabLike(currentTabUrl, allItems)
        );
        setAllItems(allItems);
        const items = allItems.slice(0, 1);
        listEl.innerHTML = "";

        if (!items.length) {
          // No card — show global quality chips for link paste
          syncGlobalQualityBox(false);
          let title = "받을 영상을 찾지 못했어요";
          let hint = "영상 페이지를 열거나 링크를 직접 붙여 넣으세요";
          if (isInstagramHost(currentTabUrl) && !isInstagramPostUrl(currentTabUrl)) {
            title = "게시물이나 릴스 페이지를 열어 주세요";
            hint =
              "홈이나 프로필이 아닌 받을 게시물 또는 릴스에서 다시 열어 주세요";
          } else if (
            isYoutubeUrl(currentTabUrl) &&
            !isDownloadableSiteVideo(currentTabUrl)
          ) {
            title = "YouTube 영상 페이지를 열어 주세요";
            hint = "일반 영상 또는 Shorts 페이지에서 다시 열어 주세요";
          } else if (
            isTiktokUrl(currentTabUrl) &&
            !isDownloadableSiteVideo(currentTabUrl)
          ) {
            title = "TikTok 영상 페이지를 열어 주세요";
            hint =
              "/@사용자/video/숫자 또는 공유 링크를 붙여 넣어 주세요 (탐색·팔로잉·라이브·검색은 받을 수 없습니다)";
          } else if (
            /(?:^|\.)x\.com|(?:^|\.)twitter\.com/i.test(
              (() => {
                try {
                  return new URL(currentTabUrl).hostname;
                } catch {
                  return "";
                }
              })()
            ) &&
            !isXUrl(currentTabUrl)
          ) {
            title = "X 영상 게시물을 열어 주세요";
            hint = "개별 게시물 주소에서 다시 열어 주세요";
          } else if (
            /facebook\.com|fb\.watch|fb\.com/i.test(currentTabUrl || "") &&
            !isFacebookUrl(currentTabUrl)
          ) {
            title = "Facebook 영상 페이지를 열어 주세요";
            hint = "Watch, Reel 또는 개별 동영상 게시물에서 다시 열어 주세요";
          } else if (
            /bilibili\.com|b23\.tv/i.test(currentTabUrl || "") &&
            !isBilibiliUrl(currentTabUrl)
          ) {
            title = "Bilibili 영상 페이지를 열어 주세요";
            hint = "개별 영상 주소에서 다시 열어 주세요";
          } else if (isDownloadableSiteVideo(currentTabUrl)) {
            title = "영상 정보를 불러오지 못했어요";
            hint =
              "확장 프로그램을 새로고침하거나 링크로 다시 시도해 보세요";
          }
          listEl.innerHTML = `
      <div class="empty" id="empty">
        <div class="empty-icon" aria-hidden="true">▶</div>
        <p class="empty-title">${escapeHtml(title)}</p>
        <p class="hint">${escapeHtml(hint)}</p>
      </div>`;
          return;
        }

        const item = items[0];
        const card = document.createElement("article");
        card.className = "card";
        if (card.dataset) {
          card.dataset.mediaIdentity = mediaIdentity(item, currentTabUrl);
        }

        const name = displayName(item);
        const file = downloadFilename(item);
        item._saveAs = file;
        const site = siteLabel(currentTabUrl, item);
        const btnLabel = primaryDownloadLabel(name, site);

        // Order: info → quality chips (always visible) → download CTA
        card.innerHTML = `
    <div class="card-top">
      <div class="thumb" aria-hidden="true">${thumbHtml(item)}</div>
      <div class="meta">
        <div class="name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
        <div class="meta-grid">${metaRowsHtml(item)}</div>
      </div>
    </div>
    ${estimateBarHtml(item, getQualitiesLoading())}
    ${qualityPickerHtml()}
    ${trackPickerHtml()}
    <div class="card-actions card-actions-row">
      <button type="button" class="btn primary btn-dl">${escapeHtml(btnLabel)}</button>
      <button type="button" class="btn btn-watch" title="나중에 받기">나중에</button>
      <button type="button" class="btn btn-series" title="시리즈 완주">시리즈</button>
    </div>
    <details class="card-details">
      <summary class="card-details-sum">저장 이름과 상세 정보</summary>
      <div class="filename-box" title="${escapeAttr(file)}">
        <span class="filename-label">저장 이름</span>
        <span class="filename-value">${escapeHtml(file)}</span>
      </div>
    </details>
  `;

        bindThumbFallback(card, item);

        card.querySelectorAll(".q-chip").forEach((chip) => {
          chip.addEventListener("click", async () => {
            if (
              chip.id === "btnReprobeQuality" ||
              chip.classList.contains("q-chip-action")
            ) {
              chip.disabled = true;
              const prev = chip.textContent;
              chip.textContent = "확인 중…";
              try {
                // Rescan page so player height lands on media items
                const currentTabId = getCurrentTabId();
                if (currentTabId != null) {
                  await chrome.tabs
                    .sendMessage(currentTabId, { type: "SCAN_NOW" })
                    .catch(() => null);
                  await new Promise((resolve) => setTimeout(resolve, 400));
                  const media = await chrome.runtime
                    .sendMessage({
                      type: "GET_MEDIA",
                      tabId: currentTabId,
                      pageUrl: getCurrentTabUrl()
                    })
                    .catch(() => null);
                  if (media?.items?.length) setAllItems(media.items);
                }
                const latestItems = getAllItems();
                await loadAvailableQualities(latestItems[0] || item);
                render();
                const availableQualities = getAvailableQualities();
                if (isOnlyBareBest(availableQualities)) {
                  toast(
                    "아직 화질을 못 읽었습니다. 재생 후 다시 확인해 주세요",
                    "error"
                  );
                } else {
                  toast(
                    `화질: ${formatQualityChipLabel(availableQualities[0])}`,
                    "ok"
                  );
                }
              } catch {
                toast("화질 확인 실패", "error");
                chip.disabled = false;
                chip.textContent = prev || "다시 확인";
              }
              return;
            }
            setSelectedQuality(chip.getAttribute("data-quality") || "best");
            // Re-render so filename + active chip update
            render();
          });
        });
        bindTrackPicker(card);

        card.querySelector(".btn-dl").addEventListener("click", async (event) => {
          if (!canStartAnotherDownload()) {
            toast(
              `동시에 최대 ${MAX_CONCURRENT_STARTS}개까지 받을 수 있어요`,
              "error"
            );
            return;
          }
          const btn = event.currentTarget;
          btn.disabled = true;
          const prev = btn.textContent;
          btn.textContent = "추가됨";
          try {
            await downloadItem(getAllItems()[0] || item);
          } finally {
            // Re-enable quickly so another file can be queued
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = prev || "다운로드";
            }, 600);
          }
        });

        card
          .querySelector(".btn-watch")
          ?.addEventListener("click", async () => {
            // Prefer page URL for sites; fall back to media URL (HLS/mp4)
            const latestItem = getAllItems()[0] || item;
            const url =
              (latestItem.pageUrl &&
                isWatchlistableUrl(latestItem.pageUrl) &&
                latestItem.pageUrl) ||
              (latestItem.url &&
                isWatchlistableUrl(latestItem.url) &&
                latestItem.url) ||
              getCurrentTabUrl() ||
              latestItem.pageUrl ||
              latestItem.url;
            await addCurrentToWatchlist(url);
          });

        card
          .querySelector(".btn-series")
          ?.addEventListener("click", async () => {
            const latestItem = getAllItems()[0] || item;
            const title =
              latestItem.title || latestItem.pageTitle || name;
            const pageUrl =
              latestItem.pageUrl ||
              latestItem.url ||
              getCurrentTabUrl() ||
              "";
            toast("받을 목록을 준비 중…", "ok");
            await offerSeriesComplete(title, pageUrl);
            const seriesPending = getSeriesPending();
            if (seriesPending?.loading) {
              /* panel shows loading */
            } else if (seriesPending?.items?.length) {
              toast(
                `${seriesPending.items.length}개 항목 · 체크 확인 후 「${
                  seriesPending.mode === "playlist" ? "바로 받기" : "나중 받기"
                }」`,
                "ok"
              );
            } else {
              toast(
                "시리즈 코드를 찾지 못했습니다 (예: SSIS-001) · 재생목록이면 목록 페이지에서 시도",
                "error"
              );
            }
          });

        listEl.appendChild(card);
        // Card already has quality chips — hide the global bar
        syncGlobalQualityBox(true);
        scheduleThumbHydration(items);
      }

      function patch() {
        const currentTabUrl = getCurrentTabUrl();
        const allItems = ensureSiteItems(
          getAllItems(),
          resolveRenderTabLike(currentTabUrl, getAllItems())
        );
        setAllItems(allItems);
        const item = allItems[0];
        const card = listEl.querySelector?.(".card");
        if (!item || !card?.dataset) return false;
        const identity = mediaIdentity(item, currentTabUrl);
        if (
          card.dataset.mediaIdentity &&
          card.dataset.mediaIdentity !== identity
        ) {
          return false;
        }
        card.dataset.mediaIdentity = identity;

        const name = displayName(item);
        const file = downloadFilename(item);
        item._saveAs = file;
        const nameEl = card.querySelector(".name");
        if (nameEl) {
          if (nameEl.textContent !== name) nameEl.textContent = name;
          if (nameEl.title !== name) nameEl.title = name;
        }
        const metaEl = card.querySelector(".meta-grid");
        const nextMetaHtml = metaRowsHtml(item);
        if (metaEl && metaEl.innerHTML !== nextMetaHtml) {
          metaEl.innerHTML = nextMetaHtml;
        }
        const estimateEl = card.querySelector(".estimate-bar");
        if (estimateEl && typeof estimateBarHtml === "function") {
          const nextEstimateHtml = estimateBarHtml(
            item,
            getQualitiesLoading?.()
          );
          if (nextEstimateHtml && estimateEl.outerHTML !== nextEstimateHtml) {
            estimateEl.outerHTML = nextEstimateHtml;
          }
        }
        const filenameEl = card.querySelector(".filename-value");
        if (filenameEl && filenameEl.textContent !== file) {
          filenameEl.textContent = file;
        }
        const downloadButton = card.querySelector(".btn-dl");
        if (downloadButton && !downloadButton.disabled) {
          const nextLabel = primaryDownloadLabel(
            name,
            siteLabel(currentTabUrl, item)
          );
          if (downloadButton.textContent !== nextLabel) {
            downloadButton.textContent = nextLabel;
          }
        }

        const thumb = card.querySelector(".thumb");
        const image = card.querySelector(".thumb-img");
        if (item.thumbnail) {
          const thumbUrl = String(item.thumbnail);
          const isDataThumb = thumbUrl.startsWith("data:image/");
          if (image) {
            const currentSrc = image.getAttribute("src") || "";
            if (isDataThumb) {
              if (currentSrc !== thumbUrl) {
                image.setAttribute("src", thumbUrl);
              }
              if (typeof image.removeAttribute === "function") {
                image.removeAttribute("data-thumb-url");
              }
            } else if (needsRemoteThumbHydration(thumbUrl)) {
              // Never paint a hotlink-blocked CDN as src. On-page PAGE_META
              // used to do that and bindThumbFallback replaced the img with 🎬
              // before FETCH_THUMB could hydrate — paste cards skipped this
              // because they only go through render() + data-thumb-url.
              if (currentSrc && !currentSrc.startsWith("data:image/")) {
                if (currentSrc !== thumbUrl) {
                  if (typeof image.removeAttribute === "function") {
                    image.removeAttribute("src");
                  } else {
                    image.setAttribute("src", "");
                  }
                }
              } else if (!currentSrc && typeof image.setAttribute === "function") {
                image.setAttribute("data-thumb-url", thumbUrl);
              }
            } else if (currentSrc !== thumbUrl) {
              image.setAttribute("src", thumbUrl);
            }
          } else if (thumb) {
            thumb.innerHTML = thumbHtml(item);
            bindThumbFallback(card, item);
          }
        } else if (image) {
          if (typeof image.removeAttribute === "function") {
            image.removeAttribute("src");
          } else {
            image.setAttribute("src", "");
          }
          if (thumb) {
            thumb.innerHTML = thumbHtml(item);
          }
        }
        scheduleThumbHydration([item]);
        return true;
      }

      return { render, patch, hydrateRemoteThumbnails };
    }

    return { createRenderer, primaryDownloadLabel, needsRemoteThumbHydration };
  }
);
