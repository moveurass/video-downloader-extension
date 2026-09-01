(function initPopupSeriesNetwork(root, factory) {
  const api = factory();
  root.UVDPopupSeriesNetwork = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeSeriesNetwork() {
  "use strict";

  function createClient(deps) {
    const thumbCache = new Map();

    async function fetchThumbDataUrl(url) {
      const key = String(url || "").trim();
      if (!key) return "";
      if (key.startsWith("data:image/")) return key;
      if (thumbCache.has(key)) return thumbCache.get(key);
      try {
        const response = await deps.sendMessage({
          type: "FETCH_THUMB",
          url: key,
          tabId: deps.getTabId()
        });
        const dataUrl = response?.ok && String(response.dataUrl || "").startsWith("data:image/")
          ? response.dataUrl
          : "";
        if (dataUrl) {
          thumbCache.set(key, dataUrl);
          if (thumbCache.size > 80) thumbCache.delete(thumbCache.keys().next().value);
        }
        return dataUrl;
      } catch {
        return "";
      }
    }

    async function resolveThumbDataUrl(item, candidatesFor) {
      if (!item) return "";
      const existing = deps.normalizeThumb(item.thumbnail);
      if (existing?.startsWith("data:image/")) return existing;
      if (existing && thumbCache.has(existing)) return thumbCache.get(existing);
      for (const url of candidatesFor(item)) {
        if (url.startsWith("data:image/")) return url;
        const dataUrl = await fetchThumbDataUrl(url);
        if (dataUrl) return dataUrl;
      }
      return "";
    }

    async function probePage(candidate) {
      return deps.sendMessage({
        type: "PROBE_PAGE_META",
        url: candidate.url,
        pageUrl: candidate.url,
        expectedKey: candidate.key,
        key: candidate.key,
        tabId: deps.getTabId()
      }).catch(() => null);
    }

    async function validateProductSeriesItems(candidates, options = {}) {
      const want = Math.max(1, Number(options.want) || 5);
      const maxMiss = Math.max(1, Number(options.maxConsecutiveMiss) || 2);
      const onProgress = typeof options.onProgress === "function"
        ? options.onProgress
        : null;
      const output = [];
      let missStreak = 0;
      let missing = 0;
      const total = candidates.length;
      for (let index = 0; index < candidates.length && output.length < want; index++) {
        const candidate = candidates[index];
        const url = candidate?.url || "";
        const step = index + 1;
        const report = (status, label) => onProgress?.({
          index: step,
          total,
          key: candidate?.key,
          status,
          found: output.length,
          missing,
          label
        });
        report("checking", candidate?.key
          ? `${candidate.key} 확인 중…`
          : `후보 ${step} 확인 중…`);
        if (
          !url ||
          /\/search/i.test(url) ||
          /[?&](q|keyword|query|search)=/i.test(url) ||
          /google\.[^/]+\/search/i.test(url)
        ) {
          missing += 1;
          missStreak += 1;
          report("skip", candidate?.key ? `${candidate.key} · 검색 링크라 제외` : "검색 링크 · 제외");
          if (missStreak >= maxMiss) {
            report("stop", `연속 ${maxMiss}회 없음 · 더 이상 확인하지 않음`);
            break;
          }
          continue;
        }
        const historyHit = (deps.getHistory() || []).find((item) =>
          item?.status === "done" &&
          (deps.UVD.historyMatchesEntry?.(item, candidate) ||
            (candidate.key &&
              String(item.seriesKey || "").toUpperCase() === String(candidate.key).toUpperCase()))
        );
        if (historyHit || candidate.downloaded) {
          output.push({
            ...candidate,
            verified: true,
            url: historyHit?.pageUrl || historyHit?.url || candidate.url,
            title: historyHit?.title || candidate.title || candidate.key,
            thumbnail: deps.normalizeThumb(historyHit?.thumbnail) || candidate.thumbnail || "",
            destNote: "서재·확인됨",
            selected: candidate.selected !== false
          });
          missStreak = 0;
          report("found", `${candidate.key || "항목"} · 서재에 있어 확인됨`);
          continue;
        }
        try {
          const meta = await probePage(candidate);
          if (!meta || meta.exists !== true) {
            missing += 1;
            missStreak += 1;
            const reason = meta?.blocked
              ? "차단됨 · 사이트에서 재생 후 재시도"
              : meta?.isSearch
                ? "검색으로 떨어짐 · 없는 품번"
                : meta?.notFound
                  ? "없음/삭제"
                  : meta?.error
                    ? String(meta.error).slice(0, 40)
                    : "페이지 없음";
            report("missing", `${candidate.key || "항목"} · ${reason}`);
            if (missStreak >= maxMiss) {
              report(
                "stop",
                meta?.blocked
                  ? "연속 차단 · 페이지에서 로그인/재생 후 다시 「시리즈」"
                  : `연속 ${maxMiss}회 없음 · 시리즈 끝으로 보고 중단`
              );
              break;
            }
            continue;
          }
          missStreak = 0;
          const title = String(meta.title || "").trim();
          output.push({
            ...candidate,
            url: meta.finalUrl || url,
            title: title && title.length > 2
              ? title.length > 80 ? `${title.slice(0, 78)}…` : title
              : candidate.displayTitle || candidate.title || candidate.key,
            thumbnail: deps.normalizeThumb(meta.thumbnail) || candidate.thumbnail || "",
            softThumb: false,
            verified: true,
            destNote: "확인됨",
            selected: true
          });
          report("found", `${candidate.key || "항목"} · 있음${title ? ` · ${title.slice(0, 40)}` : ""}`);
        } catch {
          missing += 1;
          missStreak += 1;
          report("missing", `${candidate.key || "항목"} · 확인 실패`);
          if (missStreak >= maxMiss) {
            report("stop", `연속 ${maxMiss}회 실패 · 중단`);
            break;
          }
        }
      }
      onProgress?.({
        index: total,
        total,
        status: "done",
        found: output.length,
        missing,
        label: output.length
          ? `완료 · ${output.length}편 확인${missing ? ` · ${missing}개 제외` : ""}`
          : "완료 · 확인된 편 없음"
      });
      return output;
    }

    return {
      thumbCache,
      fetchThumbDataUrl,
      resolveThumbDataUrl,
      probePage,
      validateProductSeriesItems
    };
  }

  return { createClient };
});
