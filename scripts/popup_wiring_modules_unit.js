"use strict";

const assert = require("node:assert/strict");
const Navigation = require("../src/popup-navigation.js");
const SeriesState = require("../src/popup-series-state.js");

const tabs = [
  {
    value: "",
    getAttribute() {
      return this.value;
    },
    classList: { toggle(name, enabled) { this[name] = enabled; } }
  },
  {
    value: "history",
    getAttribute() {
      return this.value;
    },
    classList: { toggle(name, enabled) { this[name] = enabled; } }
  }
];
const panels = [
  { id: "tab-main", classList: { toggle(name, enabled) { this[name] = enabled; } } },
  { id: "tab-history", classList: { toggle(name, enabled) { this[name] = enabled; } } }
];
const calls = [];
const navigation = Navigation.createController({
  document: {
    querySelectorAll(selector) {
      return selector === ".tab" ? tabs : panels;
    }
  },
  loadHistoryUi: () => calls.push("history"),
  loadWatchlistUi: () => calls.push("watch"),
  fillSettingsForm: () => calls.push("settings"),
  loadRecentStrip: () => calls.push("main"),
  setActiveTabName: (name) => calls.push(`active:${name}`)
});
navigation.switchTab("history");
assert.deepEqual(calls, ["active:history", "history"]);
assert.equal(tabs[1].classList.active, true);
assert.equal(panels[0].classList.hidden, true);
assert.equal(panels[1].classList.hidden, false);

const pending = { items: [], allItems: [] };
const rebuilt = SeriesState.rebuildVisibleItems(pending, {
  rangePref: "5",
  historyItems: [{ id: "done" }],
  buildVisibleItems(payload, history, annotate) {
    assert.equal(payload.rangePref, "5");
    assert.equal(history[0].id, "done");
    assert.equal(annotate("ok"), "annotated:ok");
    return { allItems: [{ id: "one" }], items: [{ id: "one" }] };
  },
  annotateSeriesDownloaded: (value) => `annotated:${value}`,
  resolveSeriesId: () => "series:one"
});
assert.equal(rebuilt, pending);
assert.deepEqual(pending.items, [{ id: "one" }]);
assert.equal(pending.rangePref, "5");
assert.equal(pending.seriesId, "series:one");
assert.equal(SeriesState.rebuildVisibleItems(null, {}), null);

console.log("popup wiring modules: navigation and series state passed");
