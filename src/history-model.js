(function initHistoryModel(root, factory) {
  const api = factory();
  root.UVDHistoryModel = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeHistoryModel() {
  "use strict";

  function buildItem(entry, deps, now = Date.now()) {
    const title = entry.title || entry.filename || "영상";
    const pageUrl = entry.pageUrl || entry.url || "";
    const site = entry.site || deps.siteFromUrl(pageUrl) || "";
    const series = deps.extractSeriesInfo(title);
    const tags = [
      ...new Set(
        [
          ...deps.autoTags(title, site, pageUrl),
          ...(Array.isArray(entry.tags) ? entry.tags : []),
          entry.seriesId || "",
          entry.seriesKey || series?.key || ""
        ]
          .filter(Boolean)
          .map(String)
      )
    ].slice(0, 16);
    const errorMeta = deps.classifyError(entry.error || "");

    return {
      id: entry.id || `h_${now}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      filename: entry.filename || "",
      url: entry.url || pageUrl,
      pageUrl,
      path: entry.path || "",
      downloadId: entry.downloadId ?? null,
      status: entry.status || "done",
      error: entry.error || null,
      errorCode: entry.errorCode || errorMeta.code,
      size: entry.size || 0,
      method: entry.method || "",
      quality: entry.quality || "",
      mediaMode: entry.mediaMode || "video",
      site,
      thumbnail: entry.thumbnail || "",
      tags,
      seriesKey: series?.key || entry.seriesKey || "",
      seriesPrefix: series?.prefix || entry.seriesPrefix || "",
      seriesId: entry.seriesId || "",
      seriesIndex: entry.seriesIndex || 0,
      note: entry.note || "",
      at: entry.at || now
    };
  }

  function prepend(list, item, cap) {
    const limit = Math.max(1, Number(cap) || 200);
    return [item, ...(list || []).filter((existing) => existing.id !== item.id)].slice(
      0,
      limit
    );
  }

  function update(list, id, patch) {
    return (list || []).map((item) =>
      item.id === id ? { ...item, ...(patch || {}), id: item.id } : item
    );
  }

  return { buildItem, prepend, update };
});
