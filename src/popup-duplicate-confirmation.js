(function initPopupDuplicateConfirmation(root, factory) {
  const api = factory();
  root.UVDPopupDuplicateConfirmation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupDuplicateConfirmation() {
    "use strict";

    function createController(deps) {
      const {
        $,
        UVD,
        uiJobs,
        toast,
        formatTimeAgo,
        sendMessage,
        getUvdSettings
      } = deps;

      /**
       * If this URL was already downloaded successfully, ask before re-downloading.
       * @returns {Promise<boolean>} true = proceed, false = cancel
       */
      async function confirmNotDuplicate(url, { force = false } = {}) {
        if (force || getUvdSettings().warnDuplicates === false) return true;
        if (!url || !/^https?:/i.test(url)) return true;

        // Also skip if already running in queue
        const key = UVD.normalizeUrlKey(url);
        for (const j of uiJobs.values()) {
          if (
            j.status === "running" &&
            UVD.normalizeUrlKey(j.pageUrl || "") === key
          ) {
            toast("이미 받는 중입니다", "ok");
            return false;
          }
        }

        let dup = null;
        try {
          dup = await UVD.findDuplicateDone(url);
        } catch {
          dup = null;
        }
        if (!dup) return true;

        return new Promise((resolve) => {
          const modal = $("#dupModal");
          const text = $("#dupModalText");
          const meta = $("#dupModalMeta");
          if (!modal) {
            resolve(true);
            return;
          }
          const when = formatTimeAgo(dup.at);
          const size =
            dup.size >= 1024 * 1024
              ? `${(dup.size / 1024 / 1024).toFixed(1)}MB`
              : "";
          if (text) {
            text.textContent = `「${(dup.title || "영상").slice(0, 40)}」은(는) 이전에 저장했습니다.`;
          }
          if (meta) {
            meta.textContent = [when, size, dup.filename || ""]
              .filter(Boolean)
              .join(" · ");
          }
          modal.classList.remove("hidden");
          modal.dataset.path = dup.path || "";
          modal.dataset.did =
            dup.downloadId != null ? String(dup.downloadId) : "";

          const cleanup = (result) => {
            modal.classList.add("hidden");
            $("#btnDupForce")?.removeEventListener("click", onForce);
            $("#btnDupCancel")?.removeEventListener("click", onCancel);
            $("#btnDupFolder")?.removeEventListener("click", onFolder);
            resolve(result);
          };
          const onForce = () => cleanup(true);
          const onCancel = () => cleanup(false);
          const onFolder = async () => {
            try {
              await sendMessage({
                type: "SHOW_DOWNLOAD",
                downloadId: dup.downloadId,
                path: dup.path || ""
              });
            } catch {
              /* ignore */
            }
            cleanup(false);
          };
          $("#btnDupForce")?.addEventListener("click", onForce);
          $("#btnDupCancel")?.addEventListener("click", onCancel);
          $("#btnDupFolder")?.addEventListener("click", onFolder);
        });
      }

      return { confirmNotDuplicate };
    }

    return { createController };
  }
);
