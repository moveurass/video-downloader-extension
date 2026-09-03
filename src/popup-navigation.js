(function initPopupNavigation(root, factory) {
  const api = factory();
  root.UVDPopupNavigation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupNavigation() {
    "use strict";

    function createController(deps) {
      const {
        document,
        loadHistoryUi,
        loadWatchlistUi,
        fillSettingsForm,
        loadRecentStrip,
        setActiveTabName
      } = deps;

      function switchTab(name) {
        setActiveTabName(name);
        document.querySelectorAll(".tab").forEach((tab) => {
          const active = tab.getAttribute("data-tab") === name;
          tab.classList.toggle("active", active);
          tab.setAttribute?.("aria-selected", active ? "true" : "false");
          tab.tabIndex = active ? 0 : -1;
        });
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          const hidden = panel.id !== `tab-${name}`;
          panel.classList.toggle("hidden", hidden);
          panel.setAttribute?.("aria-hidden", hidden ? "true" : "false");
        });
        if (name === "history") loadHistoryUi();
        if (name === "watch") loadWatchlistUi();
        if (name === "settings") fillSettingsForm();
        if (name === "main") loadRecentStrip();
      }

      return { switchTab };
    }

    return { createController };
  }
);
