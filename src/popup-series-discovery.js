(function initPopupSeriesDiscovery(root, factory) {
  const api = factory();
  root.UVDPopupSeriesDiscovery = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDiscovery() {
  "use strict";

  function createDiscovery(deps) {
    const {
      $,
      document,
      sendMessage,
      UVD,
      UVDPopupSeriesUI: SeriesUI,
      UVDPopupSeriesNetwork: SeriesNetwork,
      toast,
      userError,
      refreshHelperStatus,
      getAllItems,
      getHistoryItems,
      setHistoryItems,
      getCurrentTabUrl,
      getCurrentTabId,
      getHelperOk,
      getSeriesPending,
      getSeriesRangePref,
      setSeriesRangePref,
      getUvdSettings,
      seriesRangeLimit,
      showSeriesBanner,
      hideSeriesBanner,
      showSeriesVerifyProgress,
      hideSeriesVerifyProgress,
      updateSeriesVerifyProgress
    } = deps;

    const normalizeThumbSrc = SeriesUI.normalizeThumbSrc;
    const rewriteThumbForSeriesKey = SeriesUI.rewriteThumbForSeriesKey;
    const {
      youtubeVideoIdFromItem,
      youtubePosterUrl,
      normalizePlaylistEntry: normalizeSeriesPlaylistEntry
    } = SeriesUI;

    function seriesAnchorThumbnail() {
      try {
        for (const it of getAllItems() || []) {
          const t = normalizeThumbSrc(it?.thumbnail);
          if (t) return t;
        }
      } catch {
        /* ignore */
      }
      try {
        const pageKey = UVD?.normalizeUrlKey?.(getCurrentTabUrl() || "") || "";
        for (const h of getHistoryItems() || []) {
          if (!h?.thumbnail) continue;
          const hk = UVD?.normalizeUrlKey?.(h.pageUrl || h.url || "") || "";
          if (pageKey && hk && pageKey === hk) {
            const t = normalizeThumbSrc(h.thumbnail);
            if (t) return t;
          }
        }
      } catch {
        /* ignore */
      }
      return "";
    }

    function historyThumbForSeriesKey(key) {
      if (!key) return "";
      const k = String(key).toUpperCase();
      for (const h of getHistoryItems() || []) {
        if (!h?.thumbnail) continue;
        const sk = String(h.seriesKey || "").toUpperCase();
        const title = String(h.title || "").toUpperCase();
        if (sk === k || title.includes(k)) {
          const t = normalizeThumbSrc(h.thumbnail);
          if (t) return t;
        }
      }
      return "";
    }

    function guessSeriesItemUrls(pageUrl, info, nexts) {
      let host = "";
      try {
        host = new URL(pageUrl).origin;
      } catch {
        host = "";
      }
      const anchorThumb = seriesAnchorThumbnail();
      const fromKey = info?.key || "";
      return nexts.map((n, i) => {
        let nextUrl = "";
        if (pageUrl && info.key) {
          nextUrl = pageUrl.replace(
            new RegExp(info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
            n.key
          );
          if (nextUrl === pageUrl) {
            nextUrl = pageUrl.replace(
              new RegExp(`${info.prefix}[-_]?${info.num}`, "i"),
              n.key
            );
          }
        }
        if ((!nextUrl || nextUrl === pageUrl) && pageUrl && info.key) {
          const low = pageUrl.replace(
            new RegExp(info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"),
            n.key.toLowerCase()
          );
          if (low !== pageUrl) nextUrl = low;
        }
        let destNote = "URL 추정";
        if (!nextUrl || nextUrl === pageUrl) {
          if (host) {
            if (/123av|missav|jable|njav|netflav|supjav/i.test(host)) {
              nextUrl = `${host}/en/search?keyword=${encodeURIComponent(n.key)}`;
              destNote = "사이트 검색";
            } else {
              nextUrl = `${host}/search?q=${encodeURIComponent(n.key)}`;
              destNote = "사이트 검색";
            }
          } else {
            nextUrl = `https://www.google.com/search?q=${encodeURIComponent(
              n.key + " video"
            )}`;
            destNote = "검색 링크";
          }
        } else {
          destNote = "주소 패턴 추정";
        }
        const histThumb = historyThumbForSeriesKey(n.key);
        const rewritten = rewriteThumbForSeriesKey(anchorThumb, fromKey, n.key);
        const soft = !histThumb && !rewritten && i === 0 && !!anchorThumb;
        return {
          key: n.key,
          title: `${n.label || n.key}`,
          displayTitle: `다음 ${i + 1}편 · ${n.label || n.key}`,
          url: nextUrl,
          destNote,
          thumbnail: histThumb || rewritten || (soft ? anchorThumb : "") || "",
          softThumb: soft || (!!rewritten && !histThumb),
          selected: true
        };
      });
    }

    function seriesThumbCandidates(item) {
      const out = [];
      const seen = new Set();
      const push = (u) => {
        const n = normalizeThumbSrc(u);
        if (!n || seen.has(n)) return;
        seen.add(n);
        out.push(n);
      };
      const direct = normalizeThumbSrc(item?.thumbnail);
      if (direct) push(direct);
      const vid = youtubeVideoIdFromItem(item);
      if (vid) {
        for (const q of ["hqdefault", "mqdefault", "sddefault", "0", "default"]) {
          push(`https://i.ytimg.com/vi/${vid}/${q}.jpg`);
          push(`https://img.youtube.com/vi/${vid}/${q}.jpg`);
        }
      }
      return out;
    }

    const seriesNetwork = SeriesNetwork.createClient({
      sendMessage,
      getTabId: getCurrentTabId,
      getHistory: getHistoryItems,
      normalizeThumb: normalizeThumbSrc,
      UVD
    });
    const seriesThumbCache = seriesNetwork.thumbCache;
    const fetchThumbDataUrl = seriesNetwork.fetchThumbDataUrl;
    const resolveSeriesThumbDataUrl = (item) =>
      seriesNetwork.resolveThumbDataUrl(item, seriesThumbCandidates);

    let seriesThumbHydrateToken = 0;
    async function hydrateSeriesThumbs() {
      const token = ++seriesThumbHydrateToken;
      const list = $("#seriesBannerList");
      const pending = getSeriesPending();
      if (!list || !pending?.items?.length) return;
      const items = pending.items;
      const jobs = items.map((_, i) => i);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const idx = jobs[cursor++];
          if (token !== seriesThumbHydrateToken) return;
          if (!getSeriesPending()?.items?.[idx]) return;
          const item = getSeriesPending().items[idx];
          const dataUrl = await resolveSeriesThumbDataUrl(item);
          if (token !== seriesThumbHydrateToken) return;
          const li = list.querySelector(
            `li.series-preview-item[data-series-idx="${idx}"]`
          );
          if (!dataUrl) {
            const ph = li?.querySelector("span.series-preview-thumb-ph");
            if (ph) {
              ph.classList.remove("is-loading");
              ph.textContent = ph.getAttribute("data-ph") || "?";
            }
            continue;
          }
          const current = getSeriesPending();
          current.items[idx].thumbnail = dataUrl;
          current.items[idx].softThumb = false;
          if (current.allItems) {
            const key = String(item.id || item.key || item.url || "");
            for (const a of current.allItems) {
              const ak = String(a.id || a.key || a.url || "");
              if (key && ak && key === ak) {
                a.thumbnail = dataUrl;
                a.softThumb = false;
              }
            }
          }
          if (!li) continue;
          let img = li.querySelector("img.series-preview-thumb");
          if (!img) {
            const ph = li.querySelector("span.series-preview-thumb-ph");
            img = document.createElement("img");
            img.className = "series-preview-thumb";
            img.alt = "";
            img.setAttribute("data-series-idx", String(idx));
            if (ph) ph.replaceWith(img);
            else li.insertBefore(img, li.querySelector(".series-preview-body"));
          }
          img.classList.remove("is-soft", "is-loading");
          img.src = dataUrl;
        }
      });
      await Promise.all(workers);
    }

    function seriesItemThumbnail(item) {
      if (!item) return "";
      const vid = youtubeVideoIdFromItem(item);
      if (vid) return youtubePosterUrl(vid, "hqdefault");
      return normalizeThumbSrc(item.thumbnail) || "";
    }

    function patchSeriesRowThumb(index, thumbUrl, { soft = false } = {}) {
      if (!getSeriesPending()?.items?.[index]) return;
      const apply = (dataUrl) => {
        const pending = getSeriesPending();
        if (!dataUrl || !pending?.items?.[index]) return;
        pending.items[index].thumbnail = dataUrl;
        if (!soft) pending.items[index].softThumb = false;
        const list = $("#seriesBannerList");
        if (!list) return;
        const li = list.querySelector(
          `li.series-preview-item[data-series-idx="${index}"]`
        );
        if (!li) return;
        let img = li.querySelector("img.series-preview-thumb");
        const ph = li.querySelector("span.series-preview-thumb-ph");
        if (!img) {
          img = document.createElement("img");
          img.className = "series-preview-thumb";
          img.alt = "";
          img.setAttribute("data-series-idx", String(index));
          if (ph) ph.replaceWith(img);
          else li.insertBefore(img, li.querySelector(".series-preview-body"));
        }
        img.classList.toggle("is-soft", !!soft);
        img.src = dataUrl;
      };
      const src = normalizeThumbSrc(thumbUrl);
      if (!src) return;
      if (src.startsWith("data:image/")) {
        apply(src);
        return;
      }
      fetchThumbDataUrl(src).then((data) => {
        if (data) apply(data);
      });
    }

    async function enrichSeriesThumbnails() {
      const pending = getSeriesPending();
      if (!pending?.items?.length || pending.loading) return;
      if (pending.mode === "playlist") return;
      const items = pending.items;
      const jobs = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const url = it?.url || "";
        if (!/^https?:/i.test(url)) continue;
        if (/google\.[^/]+\/search/i.test(url)) continue;
        const hasHard =
          normalizeThumbSrc(it.thumbnail) &&
          !it.softThumb &&
          String(it.thumbnail).startsWith("data:image/");
        if (hasHard) continue;
        jobs.push(i);
      }
      if (!jobs.length) return;
      const limit = 3;
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const idx = jobs[cursor++];
          if (!getSeriesPending()?.items?.[idx]) return;
          const row = getSeriesPending().items[idx];
          const url = row.url;
          try {
            const meta = await sendMessage({
              type: "PROBE_PAGE_META",
              url,
              pageUrl: url,
              tabId: getCurrentTabId()
            }).catch(() => null);
            if (meta?.ok) {
              if (normalizeThumbSrc(meta.thumbnail)) {
                patchSeriesRowThumb(idx, meta.thumbnail, { soft: false });
              }
              if (meta.title && getSeriesPending()?.items?.[idx]) {
                const key = getSeriesPending().items[idx].key || "";
                const t = String(meta.title).trim();
                if (
                  t.length > 4 &&
                  (!key || t.toUpperCase().includes(String(key).toUpperCase()))
                ) {
                  getSeriesPending().items[idx].title =
                    t.length > 80 ? t.slice(0, 78) + "…" : t;
                  const nameEl = document.querySelector(
                    `#seriesBannerList li[data-series-idx="${idx}"] .series-preview-name`
                  );
                  if (nameEl) {
                    nameEl.textContent = `${idx + 1}. ${getSeriesPending().items[idx].title}`;
                    nameEl.title = getSeriesPending().items[idx].title;
                  }
                }
              }
              if (normalizeThumbSrc(meta.thumbnail)) continue;
            }
            if (getHelperOk()) {
              const res = await sendMessage({
                type: "LIST_QUALITIES",
                url,
                pageUrl: url,
                forceYtDlp: true
              }).catch(() => null);
              if (res?.ok && normalizeThumbSrc(res.thumbnail)) {
                patchSeriesRowThumb(idx, res.thumbnail, { soft: false });
              }
            }
          } catch {
            /* ignore per-item */
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(limit, jobs.length) }, () => worker())
      );
    }

    async function ensureHistoryLoaded() {
      if (getHistoryItems()?.length) return;
      try {
        setHistoryItems(await UVD.getHistory().catch(() => []));
      } catch {
        setHistoryItems([]);
      }
    }

    async function openSeriesFromPlaylist(info, opts = {}) {
      if (!info?.entries?.length) {
        toast("재생목록이 비어 있습니다", "error");
        return;
      }
      await ensureHistoryLoaded();
      const rangePref =
        opts.rangePref ||
        getSeriesRangePref() ||
        String(getUvdSettings().seriesCompleteCount || 5);
      const listUrl = info.url || "";
      let seriesId = "";
      try {
        const list = new URL(listUrl).searchParams.get("list");
        seriesId = list
          ? `series:pl:${list}`
          : `series:pl:${UVD.normalizeUrlKey(listUrl)}`;
      } catch {
        seriesId = `series:pl:${Date.now()}`;
      }
      const all = info.entries.map((e, i) => normalizeSeriesPlaylistEntry(e, i));
      showSeriesBanner({
        mode: "playlist",
        title: info.title || "재생목록",
        pageUrl: listUrl,
        listUrl,
        playlistTitle: info.title || "재생목록",
        seriesId,
        seriesKey: "",
        allItems: all,
        items: all,
        rangePref,
        loading: false
      });
      if (!opts.quiet) {
        toast(`${all.length}개 항목 · 범위·체크 확인 후 「바로 받기」`, "ok");
      }
    }

    async function offerSeriesComplete(title, pageUrl) {
      const settings = getUvdSettings();
      if (settings.seriesComplete === false) {
        toast("설정에서 시리즈 완주가 꺼져 있습니다", "error");
        return;
      }
      const info = UVD.extractSeriesInfo(title || "");
      const hasPl =
        UVD.isPlaylistOnlyUrl(pageUrl) || UVD.isWatchInPlaylistUrl?.(pageUrl);
      if (!info && !hasPl) return;

      await ensureHistoryLoaded();
      if (!getSeriesRangePref() || getSeriesRangePref() === "5") {
        const sc = String(settings.seriesCompleteCount || 5);
        if (["3", "5", "10"].includes(sc)) setSeriesRangePref(sc);
      }

      if (hasPl) {
        showSeriesBanner({
          mode: "playlist",
          title,
          pageUrl,
          seriesKey: info?.key || "",
          items: [],
          loading: true
        });
        try {
          await refreshHelperStatus(true);
          if (!getHelperOk()) {
            showSeriesBanner({
              mode: "playlist",
              title,
              pageUrl,
              items: [],
              loading: false
            });
            toast("재생목록 미리보기는 도우미가 필요합니다", "error");
            return;
          }
          let listUrl = pageUrl;
          if (UVD.isWatchInPlaylistUrl(pageUrl)) {
            try {
              const u = new URL(pageUrl);
              const listId = u.searchParams.get("list");
              if (listId) {
                listUrl = `https://www.youtube.com/playlist?list=${listId}`;
              }
            } catch {
              /* ignore */
            }
          }
          const res = await sendMessage({
            type: "LIST_PLAYLIST",
            pageUrl: listUrl,
            max: 200
          });
          if (!res?.ok) throw new Error(res?.error || "목록 조회 실패");
          let entries = res.entries || [];
          const curKey = UVD.normalizeUrlKey(pageUrl);
          entries = entries.filter(
            (e) => UVD.normalizeUrlKey(e.url || "") !== curKey
          );
          if (UVD.isWatchInPlaylistUrl(pageUrl)) {
            try {
              const vid = new URL(pageUrl).searchParams.get("v");
              const idx = entries.findIndex(
                (e) => e.id === vid || (e.url || "").includes(`v=${vid}`)
              );
              if (idx >= 0) entries = entries.slice(idx + 1);
            } catch {
              /* ignore */
            }
          }
          const all = entries.map((e, i) => normalizeSeriesPlaylistEntry(e, i));
          let seriesId = "";
          try {
            const list = new URL(listUrl).searchParams.get("list");
            seriesId = list
              ? `series:pl:${list}`
              : `series:pl:${UVD.normalizeUrlKey(listUrl)}`;
          } catch {
            seriesId = `series:pl:${Date.now()}`;
          }
          showSeriesBanner({
            mode: "playlist",
            title,
            pageUrl,
            listUrl,
            seriesKey: info?.key || "",
            playlistTitle: res.title || "재생목록",
            seriesId,
            allItems: all,
            items: all,
            rangePref: getSeriesRangePref(),
            loading: false
          });
          if (!all.length) {
            toast("이어서 받을 재생목록 항목이 없습니다", "ok");
          }
        } catch (e) {
          hideSeriesBanner();
          toast(userError(e?.message) || "재생목록 미리보기 실패", "error");
        }
        return;
      }

      if (info) {
        let baseInfo = { ...info };
        let continueNote = "";
        try {
          const maxInfo = UVD.maxSeriesNumInHistory?.(
            getHistoryItems() || [],
            info.prefix
          );
          if (
            maxInfo &&
            Number.isFinite(maxInfo.num) &&
            maxInfo.num >= info.num
          ) {
            baseInfo = {
              ...info,
              num: maxInfo.num,
              pad: maxInfo.pad || info.pad,
              key: `${info.prefix}-${String(maxInfo.num).padStart(
                maxInfo.pad || info.pad || 3,
                "0"
              )}`
            };
            continueNote = `서재 기준 ${baseInfo.key} 이후부터`;
          }
        } catch {
          /* ignore */
        }

        showSeriesBanner({
          mode: "product_code",
          title,
          pageUrl,
          seriesKey: info.key,
          seriesId: `series:code:${info.prefix || info.key}`,
          items: [],
          allItems: [],
          rangePref: getSeriesRangePref(),
          loading: true
        });
        showSeriesVerifyProgress();
        updateSeriesVerifyProgress({
          index: 0,
          total: 1,
          status: "checking",
          found: 0,
          missing: 0,
          label: continueNote
            ? `${continueNote} · 후보 준비…`
            : `${info.key} 다음 편 후보 준비 중…`
        });
        try {
          const want = Math.min(
            20,
            Math.max(
              seriesRangeLimit(getSeriesRangePref()),
              settings.seriesCompleteCount || 5,
              5
            )
          );
          const nexts = UVD.nextSeriesKeys(baseInfo, Math.min(30, want + 8));
          const guessed = guessSeriesItemUrls(pageUrl, info, nexts).map((x) => ({
            ...x,
            title: x.displayTitle || x.title
          }));
          if (continueNote && baseInfo.key !== info.key) {
            for (const g of guessed) {
              if (g.url && info.key) {
                const alt = pageUrl.replace(
                  new RegExp(
                    info.key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
                    "i"
                  ),
                  g.key
                );
                if (alt !== pageUrl) g.url = alt;
              }
            }
          }
          updateSeriesVerifyProgress({
            index: 0,
            total: guessed.length || 1,
            status: "checking",
            found: 0,
            missing: 0,
            label: continueNote
              ? `${continueNote} · 후보 ${guessed.length}개`
              : `후보 ${guessed.length}개 · 목표 ${want}편`
          });
          const verified = await validateProductSeriesItems(guessed, {
            want,
            maxConsecutiveMiss: 2,
            onProgress: updateSeriesVerifyProgress
          });
          await new Promise((r) => setTimeout(r, 350));
          hideSeriesVerifyProgress();
          showSeriesBanner({
            mode: "product_code",
            title,
            pageUrl,
            seriesKey: info.key,
            seriesId: `series:code:${info.prefix || info.key}`,
            allItems: verified,
            items: verified,
            rangePref: getSeriesRangePref(),
            loading: false
          });
          if (!verified.length) {
            toast(
              seriesVerifyFailHint() ||
                "실제로 있는 다음 편을 찾지 못했습니다 · 품번 추정만으로는 목록에 넣지 않습니다",
              "error"
            );
          } else {
            const skipped = guessed.length - verified.length;
            toast(
              [
                continueNote || null,
                skipped > 0
                  ? `실제 확인 ${verified.length}편 · 없는 번호 ${skipped}개 제외`
                  : `실제 확인 ${verified.length}편`
              ]
                .filter(Boolean)
                .join(" · "),
              "ok"
            );
            hydrateSeriesThumbs().catch(() => {});
          }
        } catch (e) {
          hideSeriesVerifyProgress();
          hideSeriesBanner();
          toast(
            seriesProbeErrorHint(e) ||
              userError(e?.message) ||
              "시리즈 목록 확인 실패",
            "error"
          );
        }
      }
    }

    function seriesVerifyFailHint() {
      return "확인된 다음 편이 없습니다 · 사이트가 막혔거나 다음 품번이 없을 수 있어요. 영상 페이지를 연 채 다시 시도하세요";
    }

    function seriesProbeErrorHint(err) {
      const s = String(err?.message || err || "");
      if (/blocked|cloudflare|just a moment|captcha|403|401/i.test(s)) {
        return "사이트가 차단했습니다 · 123av 탭에서 영상 페이지를 연 뒤 재생하고 다시 「시리즈」를 눌러 주세요";
      }
      if (/cross-origin|content|Receiving end|Could not establish/i.test(s)) {
        return "페이지 연결이 필요합니다 · 해당 사이트 탭을 새로고침한 뒤 다시 시도하세요";
      }
      return null;
    }

    async function validateProductSeriesItems(candidates, opts = {}) {
      return seriesNetwork.validateProductSeriesItems(candidates, opts);
    }

    return {
      seriesAnchorThumbnail,
      historyThumbForSeriesKey,
      guessSeriesItemUrls,
      seriesThumbCandidates,
      seriesNetwork,
      seriesThumbCache,
      fetchThumbDataUrl,
      resolveSeriesThumbDataUrl,
      hydrateSeriesThumbs,
      seriesItemThumbnail,
      patchSeriesRowThumb,
      enrichSeriesThumbnails,
      ensureHistoryLoaded,
      openSeriesFromPlaylist,
      offerSeriesComplete,
      seriesVerifyFailHint,
      seriesProbeErrorHint,
      validateProductSeriesItems
    };
  }

  return { createDiscovery };
});
