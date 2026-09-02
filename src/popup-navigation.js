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
          tab.classList.toggle(
            "active",
            tab.getAttribute("data-tab") === name
          );
        });
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          panel.classList.toggle("hidden", panel.id !== `tab-${name}`);
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
