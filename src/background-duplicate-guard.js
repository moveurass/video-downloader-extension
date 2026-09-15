(function initBackgroundDuplicateGuard(root, factory) {
  const api = factory();
  root.UVDBackgroundDuplicateGuard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDuplicateGuard() {
  "use strict";

  const NOTIF_PREFIX = "uvd-dup-";
  const NOTIF_TTL_MS = 30_000;

  /**
   * Background download entry points (keyboard commands, context menus) have
   * no popup to show the duplicate modal in. This guard checks the download
   * history instead and asks via a notification: "그래도 받기" re-runs the
   * stored starter, "취소"/ignore drops it.
   */
  function createDuplicateGuard(deps) {
    const pending = new Map();
    let bound = false;

    function formatWhen(at) {
      const t = new Date(at || 0).getTime();
      return Number.isFinite(t) && t > 0
        ? new Date(t).toLocaleString("ko-KR")
        : "";
    }

    /**
     * @param {string} pageUrl the URL the download will be recorded under
     * @returns {Promise<boolean>} true = proceed, false = held for the user
     */
    async function allowOrAsk(pageUrl, { title, starter } = {}) {
      if (!pageUrl) return true;
      try {
        const settings = await deps.UVD.getSettings();
        if (settings?.warnDuplicates === false) return true;
      } catch {
        /* default is to warn */
      }
      let dup = null;
      try {
        dup = await deps.UVD.findDuplicateDone(pageUrl);
      } catch {
        dup = null;
      }
      if (!dup) return true;

      const message = [
        `「${String(dup.title || title || "영상").slice(0, 32)}」은(는) 이미 받았어요`,
        formatWhen(dup.at),
        "다시 받으려면 '그래도 받기'를 누르세요"
      ]
        .filter(Boolean)
        .join("\n");

      const id =
        NOTIF_PREFIX + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      try {
        deps.chrome.notifications.create(
          id,
          {
            type: "basic",
            iconUrl: deps.chrome.runtime.getURL("icons/icon128.png"),
            title: "이미 받은 영상",
            message: message.slice(0, 300),
            buttons: [{ title: "그래도 받기" }, { title: "취소" }],
            requireInteraction: true
          },
          () => {
            void deps.chrome.runtime.lastError;
            if (typeof starter === "function") pending.set(id, starter);
            deps.setTimeout(() => {
              if (pending.delete(id)) {
                try {
                  deps.chrome.notifications.clear(
                    id,
                    () => void deps.chrome.runtime.lastError
                  );
                } catch {
                  /* ignore */
                }
              }
            }, NOTIF_TTL_MS);
          }
        );
      } catch {
        /* notifications unavailable — fail closed (skip the re-download) */
      }
      return false;
    }

    function bind() {
      if (bound) return;
      bound = true;
      const n = deps.chrome.notifications;
      if (!n) return;
      n.onButtonClicked?.addListener((id, buttonIndex) => {
        const starter = pending.get(id);
        if (!starter || buttonIndex !== 0) return;
        pending.delete(id);
        starter();
      });
      // Platforms without notification buttons: clicking the body means go.
      n.onClicked?.addListener((id) => {
        const starter = pending.get(id);
        if (!starter) return;
        pending.delete(id);
        starter();
      });
      n.onClosed?.addListener((id) => {
        pending.delete(id);
      });
    }

    return { allowOrAsk, bind };
  }

  return { createDuplicateGuard };
});
