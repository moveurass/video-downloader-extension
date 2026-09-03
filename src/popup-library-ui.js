(function initPopupLibraryUi(root, factory) {
  const api = factory();
  root.UVDPopupLibraryUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeLibraryUi() {
  "use strict";

  function filterValues(history) {
    const sites = new Set();
    const series = new Set();
    for (const item of history || []) {
      if (item?.site) sites.add(item.site);
      if (item?.seriesPrefix) series.add(item.seriesPrefix);
      else if (item?.seriesKey) series.add(String(item.seriesKey).split("-")[0]);
    }
    return { sites: [...sites].sort(), series: [...series].sort() };
  }

  function filterOptions(values, current, emptyLabel, escape) {
    return `<option value="">${emptyLabel}</option>` +
      values.map((value) =>
        `<option value="${escape(value)}" ${current === value ? "selected" : ""}>${escape(value)}</option>`
      ).join("");
  }

  function renderHistory(items, deps) {
    const escape = deps.escapeHtml;
    const attr = deps.escapeAttr;
    if (!items?.length) {
      return `<div class="empty small"><div class="empty-icon" aria-hidden="true">⌕</div><p class="empty-title">검색 결과가 없어요</p><p class="hint">필터를 바꾸거나 새 영상을 받아 보세요</p></div>`;
    }
    return items.map((item) => {
      const ok = item.status === "done";
      const error = !ok ? deps.UVD.classifyError(item.error || "") : null;
      const sub = ok
        ? `${deps.formatTimeAgo(item.at)} · ${item.site || "?"} · ${
            item.mediaMode === "audio" ? "오디오" :
              item.mediaMode === "video_subs" ? "영상+자막" : "영상"
          }${item.size ? ` · ${(item.size / 1024 / 1024).toFixed(1)}MB` : ""}${
            item.seriesKey ? ` · ${item.seriesKey}` : ""
          }`
        : `${deps.formatTimeAgo(item.at)} · ${error?.label || "실패"}`;
      const errorHint = !ok && error?.hint
        ? `<div class="history-err-hint">${escape(error.hint)}</div>`
        : "";
      const tags = (item.tags || []).slice(0, 6);
      const tagsHtml = tags.length
        ? `<div class="lib-tags">${tags.map((tag) =>
            `<span class="lib-tag">${escape(tag)}</span>`
          ).join("")}</div>`
        : "";
      const actions = [];
      const url = item.pageUrl || item.url || "";
      if (ok && url) {
        actions.push(`<button type="button" class="btn" data-act="retry" data-url="${attr(url)}">다시 받기</button>`);
      }
      if (ok) {
        actions.push(`<button type="button" class="btn" data-act="show" data-path="${attr(item.path || "")}" data-did="${attr(item.downloadId ?? "")}">폴더</button>`);
        if (
          item.seriesKey ||
          deps.UVD.isPlaylistOnlyUrl(url) ||
          deps.UVD.isWatchInPlaylistUrl?.(url)
        ) {
          actions.push(`<button type="button" class="btn" data-act="series" data-title="${attr(item.title || "")}" data-url="${attr(url)}">시리즈</button>`);
        }
      } else if (error) {
        const labels = {
          retry: "다시 받기",
          play_retry: "재생 후 재시도",
          open_page: "페이지",
          helper_start: "도우미 실행",
          helper: "안내",
          login: "로그인"
        };
        for (const action of error.actions || []) {
          if (!labels[action]) continue;
          if (["retry", "play_retry", "open_page", "login"].includes(action) && !url) continue;
          const dataAction = action === "open_page" ? "open" : action;
          actions.push(`<button type="button" class="btn" data-act="${dataAction}"${
            url && ["retry", "play_retry", "open_page", "login"].includes(action)
              ? ` data-url="${attr(url)}"`
              : ""
          }>${labels[action]}</button>`);
        }
      }
      return `
        <div class="history-item ${ok ? "" : "is-error"}">
          <div class="history-top">
            <span class="history-status ${ok ? "done" : "error"}">${ok ? "✓" : "!"}</span>
            <div class="history-meta">
              <div class="history-title" title="${attr(item.title || "")}">${escape(item.title || "영상")}</div>
              <div class="history-sub">${escape(sub)}${errorHint}</div>
              ${tagsHtml}
            </div>
          </div>
          <div class="history-actions">${actions.join("")}</div>
        </div>`;
    }).join("");
  }

  return { filterValues, filterOptions, renderHistory };
});
