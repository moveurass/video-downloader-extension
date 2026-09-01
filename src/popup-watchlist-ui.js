(function initPopupWatchlistUi(root, factory) {
  const api = factory();
  root.UVDPopupWatchlistUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeWatchlistUi() {
  "use strict";

  function formatScheduleLabel(item, now = Date.now()) {
    const at = Number(item?.scheduleAt || 0);
    if (!at || at < now) return item?.scheduleLabel || "";
    try {
      const date = new Date(at);
      const current = new Date(now);
      const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      const sameDay = date.getFullYear() === current.getFullYear() &&
        date.getMonth() === current.getMonth() && date.getDate() === current.getDate();
      if (sameDay) return `오늘 ${time}`;
      const tomorrow = new Date(current);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const nextDay = date.getFullYear() === tomorrow.getFullYear() &&
        date.getMonth() === tomorrow.getMonth() && date.getDate() === tomorrow.getDate();
      return nextDay ? `내일 ${time}` : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
    } catch {
      return item?.scheduleLabel || "예약됨";
    }
  }

  function computeSchedule(mode, now = Date.now()) {
    if (mode === "1h") return { scheduleAt: now + 3_600_000, scheduleLabel: "1시간 후" };
    if (mode === "tonight") {
      const date = new Date(now);
      date.setHours(23, 0, 0, 0);
      if (date.getTime() <= now + 60_000) date.setDate(date.getDate() + 1);
      return { scheduleAt: date.getTime(), scheduleLabel: "오늘 밤 23시" };
    }
    if (mode === "morning") {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return { scheduleAt: date.getTime(), scheduleLabel: "내일 아침 9시" };
    }
    return { scheduleAt: 0, scheduleLabel: "" };
  }

  function groupKey(item, UVD) {
    if (!item) return "";
    if (item.seriesId) return String(item.seriesId);
    const tagged = (Array.isArray(item.tags) ? item.tags : [])
      .find((tag) => String(tag).startsWith("series:"));
    if (tagged) return String(tagged);
    const info = UVD.extractSeriesInfo(item.seriesKey || item.title || "");
    return info?.prefix ? `series:code:${info.prefix}` : "";
  }

  function groupLabel(key, items) {
    if (!key) return "기타";
    if (key.startsWith("series:code:")) return `시리즈 ${key.slice(12)}`;
    if (key.startsWith("series:pl:")) return items[0]?.title?.slice(0, 40) || "재생목록";
    return items[0]?.title?.slice(0, 36) || "시리즈";
  }

  function scheduleOptions(item, escape) {
    const active = Number(item?.scheduleAt || 0) > Date.now();
    return `
    <select class="watch-schedule" data-act="watch-sched" data-id="${escape(item.id)}" title="예약 받기">
      <option value="none" ${!active ? "selected" : ""}>예약 없음</option>
      <option value="1h" ${item.scheduleLabel === "1시간 후" ? "selected" : ""}>1시간 후</option>
      <option value="tonight" ${item.scheduleLabel === "오늘 밤 23시" ? "selected" : ""}>오늘 밤 23시</option>
      <option value="morning" ${item.scheduleLabel === "내일 아침 9시" ? "selected" : ""}>내일 아침 9시</option>
      <option value="clear">예약 취소</option>
    </select>`;
  }

  function renderRow(item, index, deps) {
    const title = item.title || "나중에 받을 영상";
    const site = item.site || deps.UVD.siteFromUrl(item.url || item.pageUrl) || "";
    const hasMedia = !!(item.mediaUrl && /^https?:/i.test(item.mediaUrl));
    const schedule = formatScheduleLabel(item);
    const series = item.seriesKey ? ` · ${item.seriesKey}` : "";
    const attr = deps.escapeAttr;
    const escape = deps.escapeHtml;
    return `
        <div class="history-item watch-item" draggable="true" data-watch-id="${attr(item.id)}" data-index="${index}" data-series-group="${attr(groupKey(item, deps.UVD))}">
          <div class="history-top">
            <span class="watch-drag" title="드래그해서 순서 변경" aria-hidden="true">⋮⋮</span>
            <span class="history-status done">${index + 1}</span>
            <div class="history-meta">
              <div class="history-title" title="${attr(title)}">${escape(title)}</div>
              <div class="history-sub">${escape(deps.formatTimeAgo(item.at))} · ${escape(site)}${escape(series)}${hasMedia ? " · 스트림" : ""}${schedule ? ` · ⏰ ${escape(schedule)}` : ""}</div>
            </div>
          </div>
          <div class="history-actions watch-actions">
            ${scheduleOptions(item, attr)}
            <button type="button" class="btn" data-act="watch-dl" data-url="${attr(item.url || item.pageUrl || "")}" data-page-url="${attr(item.pageUrl || item.url || "")}" data-media-url="${attr(item.mediaUrl || "")}" data-title="${attr(title)}" data-quality="${attr(item.quality || "")}" data-id="${attr(item.id)}">받기</button>
            <button type="button" class="btn" data-act="watch-rm" data-id="${attr(item.id)}">삭제</button>
          </div>
        </div>`;
  }

  function render(items, deps) {
    if (!items?.length) {
      return `<div class="empty small"><p>비어 있습니다.</p><p class="hint">링크 옆 「나중」또는 카드에서 추가 · 드래그로 순서 · 예약 가능</p></div>`;
    }
    const groups = new Map();
    const order = [];
    for (const item of items) {
      const key = groupKey(item, deps.UVD) || `__single:${item.id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(item);
    }
    let index = 0;
    const parts = [];
    for (const key of order) {
      const grouped = groups.get(key);
      const isSeries = !key.startsWith("__single:") && !!groupKey(grouped[0], deps.UVD);
      if (!isSeries) {
        grouped.forEach((item) => parts.push(renderRow(item, ++index, deps)));
        continue;
      }
      const label = groupLabel(key, grouped);
      parts.push(`
        <div class="watch-series-group" data-series-group="${deps.escapeAttr(key)}">
          <div class="watch-series-head">
            <div class="watch-series-head-text">
              <span class="watch-series-badge">시리즈</span>
              <span class="watch-series-name" title="${deps.escapeAttr(label)}">${deps.escapeHtml(label)}</span>
              <span class="watch-series-count">${grouped.length}편</span>
            </div>
            <div class="watch-series-actions">
              <button type="button" class="btn primary tiny" data-act="watch-series-dl" data-group="${deps.escapeAttr(key)}">묶음 받기</button>
              <button type="button" class="btn ghost tiny" data-act="watch-series-rm" data-group="${deps.escapeAttr(key)}">묶음 삭제</button>
            </div>
          </div>
          <div class="watch-series-body">${grouped.map((item) => renderRow(item, ++index, deps)).join("")}</div>
        </div>`);
    }
    return parts.join("");
  }

  return { formatScheduleLabel, computeSchedule, groupKey, groupLabel, renderRow, render };
});
