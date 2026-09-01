(function initPopupSeriesBannerUi(root, factory) {
  const api = factory();
  root.UVDPopupSeriesBannerUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSeriesBannerUi() {
  "use strict";

  function createController(deps) {
    const {
      $,
      getSeriesPending,
      setSeriesPending,
      getSeriesRangePref,
      setSeriesRangePref,
      getSelectedQuality,
      resolveSeriesIdFromPayload,
      rebuildSeriesVisibleItems,
      seriesItemThumbnail,
      seriesThumbCache,
      formatDurShort,
      shortUrlDisplay,
      escapeHtml,
      escapeAttr,
      hydrateSeriesThumbs,
      updateSeriesRetryButton
    } = deps;

    function hideSeriesBanner() {
      setSeriesPending(null);
      hideSeriesVerifyProgress();
      $("#seriesBanner")?.classList.add("hidden");
    }

    function showSeriesBanner(payload) {
      const incoming = payload.items || [];
      const isLoading = !!payload.loading;
      const allItems = isLoading
        ? []
        : (payload.allItems || incoming).map((x, i) => ({
            ...x,
            seriesIndex: x.seriesIndex || i + 1
          }));

      setSeriesPending({
        ...payload,
        allItems,
        rangePref: payload.rangePref || getSeriesRangePref(),
        seriesId: payload.seriesId || resolveSeriesIdFromPayload(payload),
        items: []
      });
      if (!isLoading) rebuildSeriesVisibleItems();
      else getSeriesPending().items = [];

      const ban = $("#seriesBanner");
      const title = $("#seriesBannerTitle");
      const dest = $("#seriesBannerDest");
      const sub = $("#seriesBannerSub");
      const toolbar = $("#seriesToolbar");
      if (!ban) return;
      ban.classList.remove("hidden");
      if (toolbar) toolbar.classList.toggle("hidden", isLoading);

      renderSeriesRangeChips();
      renderSeriesListBody();
      updateSeriesGoButton();
      updateSeriesRetryButton();

      const pending = getSeriesPending();
      const items = pending.items || [];
      const n = items.length;
      const totalAll = (pending.allItems || []).length;
      const doneN = (pending.allItems || []).filter((x) => x.downloaded).length;
      const isPl = pending.mode === "playlist";
      const destLabel = isPl ? "바로 받기 (큐)" : "나중 받기";

      if (title) {
        title.textContent = isPl
          ? `재생목록 · ${totalAll || n}편`
          : `시리즈 ${pending.seriesKey || ""} · 다음 ${totalAll || n}편`;
      }
      if (dest) {
        dest.textContent = destLabel;
        dest.classList.toggle("is-watch", !isPl);
      }
      if (sub) {
        if (isLoading) {
          sub.textContent =
            pending.mode === "product_code"
              ? "실제로 있는 다음 편만 확인하는 중… (없는 번호는 제외)"
              : "받을 목록을 확인하는 중…";
        } else if (!n && !totalAll) {
          sub.textContent = "받을 항목이 없습니다.";
        } else if (isPl) {
          const quality = getSelectedQuality();
          sub.textContent = `체크한 영상을 큐에 넣습니다 · 화질: ${
            quality === "best" ? "최고" : quality
          }${doneN ? ` · 이미 받음 ${doneN}` : ""}`;
        } else {
          sub.textContent = `페이지에서 확인된 편만 표시합니다${
            doneN ? ` · 이미 받음 ${doneN}` : ""
          } · 「나중」받기에 추가`;
        }
      }

      try {
        ban.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch {
        /* ignore */
      }
    }

    function renderSeriesRangeChips() {
      const root = $("#seriesRange");
      const pending = getSeriesPending();
      if (!root || !pending) return;
      const pref = String(pending.rangePref || getSeriesRangePref());
      root.querySelectorAll(".series-range-chip").forEach((btn) => {
        const r = btn.getAttribute("data-range");
        btn.classList.toggle("active", r === pref);
      });
      const miss = $("#btnSeriesMissingOnly");
      if (miss) {
        miss.classList.toggle("active", !!pending.missingOnly);
        miss.setAttribute("aria-pressed", pending.missingOnly ? "true" : "false");
      }
    }

    function toggleSeriesMissingOnly(on) {
      const pending = getSeriesPending();
      if (!pending) return;
      pending.missingOnly = on == null ? !pending.missingOnly : !!on;
      rebuildSeriesVisibleItems();
      renderSeriesRangeChips();
      renderSeriesListBody();
      updateSeriesGoButton();
      const sub = $("#seriesBannerSub");
      if (sub && !pending.loading) {
        const items = pending.items || [];
        const totalAll = (pending.allItems || []).length;
        const doneN = (pending.allItems || []).filter((x) => x.downloaded).length;
        if (pending.missingOnly) {
          sub.textContent = `빠진 편만 · ${items.length}편${
            doneN ? ` (받음 ${doneN} 숨김)` : ""
          } · 전체 ${totalAll}`;
        }
      }
    }

    function renderSeriesListBody() {
      const list = $("#seriesBannerList");
      const pending = getSeriesPending();
      if (!list || !pending) return;
      if (pending.loading) {
        list.innerHTML = `<li class="series-preview-empty">불러오는 중…</li>`;
        return;
      }
      const items = pending.items || [];
      const isPl = pending.mode === "playlist";
      if (!items.length) {
        list.innerHTML = `<li class="series-preview-empty">표시할 항목이 없습니다</li>`;
        return;
      }
      list.innerHTML = items
        .map((x, i) => {
          const name = x.title || x.key || x.label || `항목 ${i + 1}`;
          const thumb = seriesItemThumbnail(x);
          const chips = [];
          if (x.downloaded) {
            chips.push(`<span class="series-preview-chip done">받음</span>`);
          }
          if (x.key && String(x.key) !== String(name)) {
            chips.push(
              `<span class="series-preview-chip key">${escapeHtml(
                String(x.key)
              )}</span>`
            );
          }
          if (x.duration) {
            chips.push(
              `<span class="series-preview-chip dur">${escapeHtml(
                formatDurShort(x.duration)
              )}</span>`
            );
          }
          if (x.uploader) {
            chips.push(
              `<span class="series-preview-chip">${escapeHtml(
                String(x.uploader).slice(0, 24)
              )}</span>`
            );
          }
          if (isPl) {
            chips.push(`<span class="series-preview-chip">바로 받기</span>`);
          } else {
            chips.push(`<span class="series-preview-chip">나중 받기</span>`);
          }
          const metaLine = x.url ? shortUrlDisplay(x.url) : x.destNote || "";
          const phLabel = (x.key || name || "?").slice(0, 10);
          const ready =
            thumb && String(thumb).startsWith("data:image/")
              ? thumb
              : seriesThumbCache.get(thumb) || "";
          const thumbHtml = ready
            ? `<img class="series-preview-thumb" src="${escapeAttr(
                ready
              )}" alt="" decoding="async" data-series-idx="${i}" data-ph="${escapeAttr(
                phLabel
              )}" />`
            : `<span class="series-preview-thumb-ph is-loading" data-series-idx="${i}" data-ph="${escapeAttr(
                phLabel
              )}">${escapeHtml(phLabel)}</span>`;
          return `<li class="series-preview-item${
            x.downloaded ? " is-done" : ""
          }" data-series-idx="${i}">
            <input type="checkbox" data-series-idx="${i}" ${
              x.selected !== false ? "checked" : ""
            } />
            ${thumbHtml}
            <span class="series-preview-body">
              <span class="series-preview-name" title="${escapeAttr(
                name
              )}">${i + 1}. ${escapeHtml(name)}</span>
              ${
                metaLine
                  ? `<span class="series-preview-meta" title="${escapeAttr(
                      x.url || metaLine
                    )}">${escapeHtml(metaLine)}</span>`
                  : ""
              }
              ${
                chips.length
                  ? `<span class="series-preview-chips">${chips.join("")}</span>`
                  : ""
              }
            </span>
          </li>`;
        })
        .join("");
      list.querySelectorAll("input[data-series-idx]").forEach((inp) => {
        inp.addEventListener("change", () => {
          const idx = parseInt(inp.getAttribute("data-series-idx"), 10);
          const current = getSeriesPending();
          if (current?.items?.[idx]) {
            current.items[idx].selected = inp.checked;
          }
          updateSeriesGoButton();
        });
      });
      hydrateSeriesThumbs().catch(() => {});
    }

    function setSeriesSelection(mode) {
      const pending = getSeriesPending();
      if (!pending?.items?.length) return;
      for (const it of pending.items) {
        if (mode === "all") it.selected = true;
        else if (mode === "none") it.selected = false;
        else if (mode === "pending") it.selected = !it.downloaded;
      }
      renderSeriesListBody();
      updateSeriesGoButton();
    }

    function setSeriesRange(pref) {
      const rangePref = pref === "all" ? "all" : String(pref);
      setSeriesRangePref(rangePref);
      const pending = getSeriesPending();
      if (!pending) return;
      pending.rangePref = rangePref;
      rebuildSeriesVisibleItems();
      renderSeriesRangeChips();
      renderSeriesListBody();
      updateSeriesGoButton();
      const sub = $("#seriesBannerSub");
      const title = $("#seriesBannerTitle");
      const items = pending.items || [];
      const totalAll = (pending.allItems || []).length;
      const doneN = (pending.allItems || []).filter((x) => x.downloaded).length;
      const isPl = pending.mode === "playlist";
      if (title) {
        title.textContent = isPl
          ? `재생목록 · ${totalAll || items.length}편`
          : `시리즈 ${pending.seriesKey || ""} · 다음 ${totalAll || items.length}편`;
      }
      if (sub && !pending.loading) {
        if (isPl) {
          const quality = getSelectedQuality();
          sub.textContent = `표시 ${items.length}/${totalAll || items.length} · 화질: ${
            quality === "best" ? "최고" : quality
          }${doneN ? ` · 이미 받음 ${doneN}` : ""}`;
        } else {
          sub.textContent = `표시 ${items.length}/${totalAll || items.length}${
            doneN ? ` · 이미 받음 ${doneN}` : ""
          }`;
        }
      }
    }

    function updateSeriesGoButton() {
      const goBtn = $("#btnSeriesGo");
      const pending = getSeriesPending();
      if (!goBtn || !pending) return;
      const sel = (pending.items || []).filter((x) => x.selected !== false);
      const n = sel.length;
      const isPl = pending.mode === "playlist";
      const skipDone = sel.filter((x) => x.downloaded).length;
      goBtn.disabled = n === 0 || !!pending.loading;
      if (n === 0) {
        goBtn.textContent = "선택 없음";
      } else if (isPl) {
        goBtn.textContent =
          skipDone > 0 && skipDone < n
            ? `${n}편 바로 받기 · 받음 ${skipDone}`
            : `${n}편 바로 받기`;
      } else {
        goBtn.textContent = `${n}편 나중 받기에 추가`;
      }
    }

    function showSeriesVerifyProgress() {
      const el = $("#seriesVerifyProgress");
      if (!el) return;
      el.classList.remove("hidden");
      const fill = $("#seriesVerifyFill");
      if (fill) fill.style.width = "0%";
      const text = $("#seriesVerifyText");
      if (text) text.textContent = "확인 준비 중…";
      const count = $("#seriesVerifyCount");
      if (count) count.textContent = "";
      const detail = $("#seriesVerifyDetail");
      if (detail) detail.textContent = "";
    }

    function hideSeriesVerifyProgress() {
      $("#seriesVerifyProgress")?.classList.add("hidden");
    }

    function updateSeriesVerifyProgress(p = {}) {
      const el = $("#seriesVerifyProgress");
      if (!el) return;
      el.classList.remove("hidden");
      const total = Math.max(1, Number(p.total) || 1);
      const index = Math.min(total, Math.max(0, Number(p.index) || 0));
      const found = Number(p.found) || 0;
      const missing = Number(p.missing) || 0;
      const pct = Math.round((index / total) * 100);
      const fill = $("#seriesVerifyFill");
      if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;

      const text = $("#seriesVerifyText");
      if (text) {
        if (p.status === "done") {
          text.textContent = "확인 완료";
        } else if (p.status === "stop") {
          text.textContent = "연속 없음 · 중단";
        } else if (p.status === "found") {
          text.textContent = "있음 · 목록에 추가";
        } else if (p.status === "missing") {
          text.textContent = "없음 · 건너뜀";
        } else if (p.status === "skip") {
          text.textContent = "검색 링크 · 건너뜀";
        } else {
          text.textContent = "페이지 확인 중…";
        }
      }
      const count = $("#seriesVerifyCount");
      if (count) {
        count.textContent = `${index}/${total} · 확인 ${found}${
          missing ? ` · 제외 ${missing}` : ""
        }`;
      }
      const detail = $("#seriesVerifyDetail");
      if (detail) {
        if (p.label) {
          detail.textContent = p.label;
        } else if (p.key) {
          const st =
            p.status === "found"
              ? "✓"
              : p.status === "missing"
                ? "✗"
                : p.status === "skip"
                  ? "–"
                  : "…";
          detail.textContent = `${st} ${p.key}`;
        } else {
          detail.textContent = "";
        }
      }
      const sub = $("#seriesBannerSub");
      if (sub && p.status !== "done") {
        sub.textContent = `확인 중 ${index}/${total} · 찾음 ${found}${
          p.key ? ` · ${p.key}` : ""
        }`;
      }
    }

    return {
      hideSeriesBanner,
      showSeriesBanner,
      renderSeriesRangeChips,
      toggleSeriesMissingOnly,
      renderSeriesListBody,
      setSeriesSelection,
      setSeriesRange,
      updateSeriesGoButton,
      showSeriesVerifyProgress,
      hideSeriesVerifyProgress,
      updateSeriesVerifyProgress
    };
  }

  return { createController };
});
