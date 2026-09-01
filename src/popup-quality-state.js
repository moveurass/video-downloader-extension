(function initPopupQualityState(root, factory) {
  const quality =
    root.UVDQuality ||
    (typeof module !== "undefined" && module.exports
      ? require("./media-quality.js")
      : null);
  const api = factory(quality);
  root.UVDPopupQualityState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupQualityState(defaultQuality) {
    "use strict";

    const {
      FALLBACK_QUALITY_CHIPS,
      heightToQualityId,
      concreteQualityChip,
      ensureQualityChoices,
      formatMb
    } = defaultQuality;

    const INITIAL_QUALITY_CHOICES = Object.freeze([
      Object.freeze({ id: "best", label: "최고" }),
      Object.freeze({ id: "4K", label: "4K" }),
      Object.freeze({ id: "1080p", label: "1080p" }),
      Object.freeze({ id: "720p", label: "720p" }),
      Object.freeze({ id: "480p", label: "480p" })
    ]);

    function createController(deps) {
      const quality = deps.UVDQuality || defaultQuality;
      const {
        UVDPopupMedia,
        UVD,
        $,
        getCurrentTabId,
        getCurrentTabUrl,
        getAllItems,
        setAllItems,
        getUvdSettings,
        isDownloadableSiteVideo,
        isSitePage,
        sendRuntimeMessage,
        sendTabMessage,
        getDocumentTitle,
        siteLabel,
        escapeHtml,
        escapeAttr
      } = deps;
      const fallback = quality.FALLBACK_QUALITY_CHIPS;
      const ensureChoices = quality.ensureQualityChoices;
      const heightToId = quality.heightToQualityId;
      const formatSizeMb = quality.formatMb;

      let selectedQuality = "best";
      let availableQualities = INITIAL_QUALITY_CHOICES.map((item) => ({ ...item }));
      let qualitiesLoading = false;

      const getSelectedQuality = () => selectedQuality;
      const setSelectedQuality = (value) => {
        selectedQuality = value;
      };
      const getAvailableQualities = () => availableQualities;
      const setAvailableQualities = (value) => {
        availableQualities = value;
      };
      const getQualitiesLoading = () => qualitiesLoading;
      const setQualitiesLoading = (value) => {
        qualitiesLoading = value;
      };

      const estimateForSelectedQuality = (item) =>
        UVDPopupMedia.estimateForQuality(
          item,
          availableQualities,
          selectedQuality
        );

      const estimateBarHtml = (item, loading = false) =>
        UVDPopupMedia.estimateBarHtml(item, {
          loading,
          qualities: availableQualities,
          selectedQuality,
          escapeHtml
        });

      const metaRowsHtml = (item) =>
        UVDPopupMedia.metaRowsHtml(item, {
          qualities: availableQualities,
          selectedQuality,
          currentTabUrl: getCurrentTabUrl(),
          siteLabel,
          escapeHtml
        });

      function qualityPickerHtml() {
        if (qualitiesLoading) {
          return `
      <div class="quality-picker" id="qualityPicker">
        <span class="quality-label">화질 선택</span>
        <p class="quality-hint">이 영상에서 받을 수 있는 화질 확인 중…</p>
        <div class="quality-chips" role="group" aria-label="화질 선택">
          <button type="button" class="q-chip active" data-quality="best" disabled>최고</button>
        </div>
      </div>`;
        }
        const opts = ensureChoices(availableQualities);
        if (!opts.some((q) => q.id === selectedQuality)) {
          selectedQuality = opts[0]?.id || "best";
        }
        const singleConcrete = opts.length === 1 && opts[0].id !== "best";
        const bareBestOnly =
          opts.length === 1 &&
          (opts[0].id === "best" ||
            /^최고/.test(String(opts[0].label || ""))) &&
          !(Number(opts[0].height) >= 240);
        return `
    <div class="quality-picker" id="qualityPicker">
      <span class="quality-label">화질 선택${
        singleConcrete
          ? ` <span class="quality-hint-inline">이 영상 화질</span>`
          : opts.length > 1
            ? ` <span class="quality-hint-inline">실제 가능 화질만 표시</span>`
            : bareBestOnly
              ? ` <span class="quality-hint-inline">화질 미확인</span>`
              : ""
      }</span>
      ${
        bareBestOnly
          ? `<p class="quality-hint quality-hint-warn">화질을 특정하지 못했습니다. 페이지에서 <strong>재생</strong>한 뒤 「다시 확인」을 누르세요.</p>`
          : ""
      }
      <div class="quality-chips" role="group" aria-label="화질 선택">
        ${opts
          .map((q) => {
            const chip = formatQualityChipLabel(q);
            const tip = [
              q.id,
              q.height ? `${q.height}p` : "",
              q.codec || "",
              q.estimatedSize
                ? `약 ${(q.estimatedSize / 1024 / 1024).toFixed(1)}MB`
                : ""
            ]
              .filter(Boolean)
              .join(" · ");
            return `<button type="button" class="q-chip${
              selectedQuality === q.id ? " active" : ""
            }" data-quality="${escapeAttr(q.id)}" title="${escapeAttr(
              tip
            )}">${escapeHtml(chip)}</button>`;
          })
          .join("")}
        ${
          bareBestOnly
            ? `<button type="button" class="q-chip q-chip-action" id="btnReprobeQuality" title="플레이어 해상도·스트림 다시 확인">다시 확인</button>`
            : ""
        }
      </div>
    </div>`;
      }

      function formatQualityChipLabel(q) {
        if (!q) return "최고";
        const rich =
          q.label && (q.label.includes("·") || q.label.includes("MB"));
        if (rich && String(q.label).length <= 22) return q.label;
        let id = q.id || q.label || "최고";
        if (id === "best") {
          const fromH = heightToId(q.height);
          id = fromH || "최고";
        }
        if (q.estimatedSize > 0) {
          const sizeStr = formatSizeMb(q.estimatedSize);
          return sizeStr ? `${id} · ${sizeStr}` : id;
        }
        if (q.codec && id !== "최고") return `${id} · ${q.codec}`;
        return id;
      }

      function qualityIdFromHeight(height) {
        return heightToId(height) || "";
      }

      function qualityFromMediaUrl(url) {
        const value = String(url || "");
        const match =
          value.match(
            /(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)/i
          ) ||
          value.match(
            /[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i
          ) ||
          value.match(
            /[?&](?:quality|res|resolution|h|height)=?(2160|1440|1080|720|480|360|240)\b/i
          );
        if (!match) return null;
        const height = parseInt(match[1], 10);
        const id = qualityIdFromHeight(height);
        if (!id) return null;
        return { id, label: id, height };
      }

      async function fetchPlayerHeight(tabId) {
        if (tabId == null || tabId < 0) return null;
        try {
          const response = await sendTabMessage(tabId, {
            type: "GET_PLAYER_HEIGHT"
          }).catch(() => null);
          const height = Number(response?.height) || 0;
          if (height < 240) return null;
          const id =
            (response?.quality &&
            !/^(best|all|unknown)$/i.test(String(response.quality))
              ? response.quality
              : null) || qualityIdFromHeight(height);
          if (!id) return null;
          return { id, label: id, height };
        } catch {
          return null;
        }
      }

      function isOnlyBareBest(list) {
        const opts = ensureChoices(list);
        if (opts.length !== 1) return false;
        const q = opts[0];
        if (q.id !== "best" && !/^최고/.test(String(q.label || ""))) {
          return false;
        }
        return !(q.height >= 240);
      }

      async function loadAvailableQualities(item) {
        qualitiesLoading = true;
        availableQualities = fallback.map((entry) => ({ ...entry }));
        const currentTabUrl = getCurrentTabUrl();
        const pageUrl = currentTabUrl || item?.pageUrl || item?.url || "";
        const mediaUrl = item?.url || pageUrl;
        const isHls =
          item?.isHls ||
          item?.type === "stream" ||
          /\.m3u8(\?|$|#)/i.test(mediaUrl || "");
        const isDirectMedia =
          /\.(mp4|webm|mkv|m4v)(\?|$|#)/i.test(mediaUrl || "");
        const canProbe =
          isDownloadableSiteVideo(mediaUrl) ||
          isDownloadableSiteVideo(pageUrl) ||
          isHls ||
          isDirectMedia ||
          !!(item?.url && /^https?:/i.test(item.url));

        const seedFromItem = [];
        if (
          item?.quality &&
          !/^(best|all|unknown)$/i.test(String(item.quality))
        ) {
          seedFromItem.push({
            id: item.quality,
            label: item.quality,
            height: item.height || 0
          });
        } else if (item?.height >= 240) {
          const label = qualityIdFromHeight(item.height);
          if (label) {
            seedFromItem.push({
              id: label,
              label,
              height: item.height
            });
          }
        } else {
          const fromUrl = qualityFromMediaUrl(mediaUrl);
          if (fromUrl) seedFromItem.push(fromUrl);
        }
        if (!seedFromItem.length) {
          const titleBlob = [
            item?.title,
            item?.pageTitle,
            item?.displayName,
            getDocumentTitle()
          ]
            .filter(Boolean)
            .join(" ");
          const titleMatch = String(titleBlob).match(
            /(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP]\b/
          );
          if (titleMatch) {
            const height = parseInt(titleMatch[1], 10);
            const id = qualityIdFromHeight(height);
            if (id) seedFromItem.push({ id, label: id, height });
          }
        }
        if (!seedFromItem.length) {
          const playerHeight = await fetchPlayerHeight(getCurrentTabId());
          if (playerHeight) seedFromItem.push(playerHeight);
        }

        if (!canProbe) {
          availableQualities = ensureChoices(
            seedFromItem.length ? seedFromItem : fallback
          );
          applySiteDefaultQuality(pageUrl || mediaUrl);
          qualitiesLoading = false;
          return;
        }

        try {
          const response = await sendRuntimeMessage({
            type: "LIST_QUALITIES",
            url: mediaUrl,
            pageUrl,
            tabId: getCurrentTabId(),
            mediaType: item?.type || (isHls ? "stream" : undefined),
            itemHeight: item?.height || seedFromItem[0]?.height || 0,
            itemQuality: item?.quality || seedFromItem[0]?.id || "",
            forceYtDlp: !!(
              item?.isSiteDownload || isDownloadableSiteVideo(pageUrl)
            )
          });
          if (response?.ok && response.qualities?.length) {
            availableQualities = ensureChoices(response.qualities);
          } else if (seedFromItem.length) {
            availableQualities = ensureChoices(seedFromItem);
          } else {
            availableQualities = ensureChoices(fallback);
          }

          if (isOnlyBareBest(availableQualities)) {
            let recovered = seedFromItem[0] || null;
            if (!recovered) {
              recovered = await fetchPlayerHeight(getCurrentTabId());
            }
            if (recovered) {
              availableQualities = ensureChoices([recovered]);
            }
          }

          const allItems = getAllItems();
          if (response?.ok && allItems[0]) {
            const patch = { ...allItems[0] };
            if (response.duration >= 1) patch.duration = response.duration;
            if (response.estimatedSize > 0) {
              patch.estimatedSize = response.estimatedSize;
              patch._sizeApprox = true;
            }
            if (
              response.title &&
              (!patch.title ||
                /^(YouTube|TikTok|Instagram)/i.test(patch.title))
            ) {
              patch.title = response.title;
              patch.pageTitle = response.title;
              patch.displayName = response.title;
            }
            if (response.thumbnail && !patch.thumbnail) {
              patch.thumbnail = response.thumbnail;
            }
            const bestQ =
              availableQualities.find((q) => q.id === "best") ||
              availableQualities[0];
            if (bestQ?.height) {
              patch._bestHeight = bestQ.height;
              if (!(patch.height >= 240)) {
                patch.height = bestQ.height;
                patch.quality =
                  bestQ.id !== "best"
                    ? bestQ.id
                    : qualityIdFromHeight(bestQ.height);
              }
            }
            if (bestQ?.estimatedSize) {
              patch.estimatedSize = bestQ.estimatedSize;
              patch._sizeApprox = true;
            }
            allItems[0] = patch;
            setAllItems(allItems);
          }
        } catch {
          if (seedFromItem.length) {
            availableQualities = ensureChoices(seedFromItem);
          } else {
            const playerHeight = await fetchPlayerHeight(getCurrentTabId());
            availableQualities = ensureChoices(
              playerHeight ? [playerHeight] : fallback
            );
          }
        }
        applySiteDefaultQuality(pageUrl || mediaUrl);
        if (!availableQualities.some((q) => q.id === selectedQuality)) {
          selectedQuality = availableQualities[0]?.id || "best";
        }
        qualitiesLoading = false;
        const hasCard = !!(
          getAllItems()[0] && isSitePage(getCurrentTabUrl())
        );
        syncGlobalQualityBox(hasCard);
      }

      function applySiteDefaultQuality(pageUrl) {
        const opts = ensureChoices(availableQualities);
        availableQualities = opts;
        if (opts.length === 1) {
          selectedQuality = opts[0].id;
          return;
        }
        if (opts.some((q) => q.id === "best")) {
          selectedQuality = "best";
          return;
        }
        const pref = UVD.qualityForSite(
          getUvdSettings(),
          pageUrl || getCurrentTabUrl() || ""
        );
        if (pref && opts.some((q) => q.id === pref)) {
          selectedQuality = pref;
          return;
        }
        selectedQuality = opts[0]?.id || "best";
      }

      function syncGlobalQualityBox(hasCardPicker = false) {
        const box = $("#qualityBox");
        const chipsRoot = $("#globalQualityChips");
        if (!box || !chipsRoot) return;

        if (hasCardPicker) {
          box.classList.add("hidden");
          return;
        }
        box.classList.remove("hidden");

        const opts = ensureChoices(availableQualities);
        if (!opts.some((q) => q.id === selectedQuality)) {
          selectedQuality = opts[0]?.id || "best";
        }
        chipsRoot.innerHTML = opts
          .map((q) => {
            const chip = formatQualityChipLabel(q);
            return `<button type="button" class="q-chip${
              selectedQuality === q.id ? " active" : ""
            }" data-quality="${escapeAttr(q.id)}" ${
              qualitiesLoading ? "disabled" : ""
            }>${escapeHtml(chip)}</button>`;
          })
          .join("");

        chipsRoot.querySelectorAll(".q-chip").forEach((button) => {
          button.addEventListener("click", () => {
            if (button.disabled) return;
            selectedQuality =
              button.getAttribute("data-quality") || "best";
            syncGlobalQualityBox(false);
          });
        });
      }

      return {
        FALLBACK_QUALITY_CHIPS: quality.FALLBACK_QUALITY_CHIPS,
        heightToQualityId: quality.heightToQualityId,
        concreteQualityChip: quality.concreteQualityChip,
        ensureQualityChoices: quality.ensureQualityChoices,
        formatMb: quality.formatMb,
        getSelectedQuality,
        setSelectedQuality,
        getAvailableQualities,
        setAvailableQualities,
        getQualitiesLoading,
        setQualitiesLoading,
        estimateForSelectedQuality,
        estimateBarHtml,
        metaRowsHtml,
        qualityPickerHtml,
        formatQualityChipLabel,
        qualityIdFromHeight,
        qualityFromMediaUrl,
        fetchPlayerHeight,
        isOnlyBareBest,
        loadAvailableQualities,
        applySiteDefaultQuality,
        syncGlobalQualityBox
      };
    }

    return {
      createController,
      INITIAL_QUALITY_CHOICES,
      FALLBACK_QUALITY_CHIPS,
      heightToQualityId,
      concreteQualityChip,
      ensureQualityChoices,
      formatMb
    };
  }
);
