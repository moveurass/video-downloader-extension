(function initPopupSeriesState(root, factory) {
  const api = factory();
  root.UVDPopupSeriesState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupSeriesState() {
    "use strict";

    function rebuildVisibleItems(pending, options) {
      if (!pending) return null;
      const {
        rangePref,
        historyItems,
        buildVisibleItems,
        annotateSeriesDownloaded,
        resolveSeriesId
      } = options;
      const visible = buildVisibleItems(
        {
          ...pending,
          rangePref: pending.rangePref ?? rangePref
        },
        historyItems,
        annotateSeriesDownloaded
      );
      pending.allItems = visible.allItems;
      pending.items = visible.items;
      pending.rangePref = pending.rangePref || rangePref;
      pending.seriesId = pending.seriesId || resolveSeriesId(pending);
      return pending;
    }

    return { rebuildVisibleItems };
  }
);
