(function initPopupHelperState(root, factory) {
  const api = factory();
  root.UVDPopupHelperState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupHelperState() {
    "use strict";

    function createController(deps) {
      const setIntervalFn = deps.setInterval || setInterval;
      const clearIntervalFn = deps.clearInterval || clearInterval;
      let helperOk = false;
      let helperPollTimer = null;
      let helperOutDirCache = "";
      let helperWasOk = null;

      function getHelperOk() {
        return helperOk;
      }

      function setHelperOk(value) {
        helperOk = value;
      }

      function getHelperOutDirCache() {
        return helperOutDirCache;
      }

      function setHelperOutDirCache(value) {
        helperOutDirCache = value;
      }

      function stopHelperPoll() {
        if (helperPollTimer) {
          clearIntervalFn(helperPollTimer);
          helperPollTimer = null;
        }
      }

      /** Keep polling while popup is open so helper reconnect is picked up without reload */
      function startHelperPoll(intervalMs = 2800) {
        if (helperPollTimer) return;
        helperPollTimer = setIntervalFn(() => {
          refreshHelperStatus(true).catch(() => {});
        }, intervalMs);
      }

      function updateHelperOutDirUi(outDir) {
        if (outDir) helperOutDirCache = String(outDir);
        const el = deps.$("#setHelperOutDir");
        if (!el) return;
        el.textContent = helperOutDirCache
          ? helperOutDirCache
          : helperOk
            ? "연결됨 (경로 미보고)"
            : "도우미 꺼짐 — 실행 후 여기에 표시됩니다";
      }

      async function refreshHelperStatus(force = false) {
        const helperBar = deps.helperBar;
        const helperText = deps.helperText;
        if (!helperBar) return;
        const need =
          deps.isSitePage(deps.getCurrentTabUrl()) ||
          deps.getAllItems().some((i) => i.isSiteDownload || i.site) ||
          !!deps.$("#linkInput")?.value ||
          helperBar.classList.contains("warn") ||
          helperWasOk === false;
        const fixBtn = deps.$("#btnHelperFix");
        const startBtn = deps.$("#btnHelperStart");
        const recheckBtn = deps.$("#btnHelperRecheck");
        if (!need && helperOk) {
          helperBar.classList.add("hidden");
          fixBtn?.classList.add("hidden");
          startBtn?.classList.add("hidden");
          recheckBtn?.classList.add("hidden");
          // Slow poll so reconnect / disconnect still surfaces
          if (!helperPollTimer) startHelperPoll(8000);
          return;
        }
        helperBar.classList.remove("hidden");
        helperBar.classList.remove("ok", "warn");
        if (helperText && !force) helperText.textContent = "도우미 확인 중…";
        try {
          const h = await deps.sendMessage({ type: "YTDLP_HEALTH", force });
          const nowOk = !!(h?.ok && h?.ytdlp);
          if (h?.outDir) helperOutDirCache = String(h.outDir);
          updateHelperOutDirUi(helperOutDirCache);
          // Reconnected while popup open
          if (helperWasOk === false && nowOk) {
            deps.toast("도우미 연결됨 — YouTube 등 받기 가능", "ok");
          }
          helperWasOk = nowOk;
          helperOk = nowOk;
          if (helperOk) {
            helperBar.classList.add("ok");
            if (helperText) {
              const pathHint = h.outDir
                ? ` · ${String(h.outDir).replace(/\/$/, "").split(/[/\\]/).slice(-2).join("/")}`
                : "";
              helperText.textContent = `도우미 준비됨${
                h.ytdlpVersion ? ` · yt-dlp ${h.ytdlpVersion}` : ""
              }${pathHint}`;
            }
            fixBtn?.classList.add("hidden");
            startBtn?.classList.add("hidden");
            recheckBtn?.classList.add("hidden");
            // Stay on slow poll to notice if helper dies
            stopHelperPoll();
            startHelperPoll(8000);
          } else {
            helperBar.classList.add("warn");
            if (helperText) {
              helperText.textContent =
                "도우미 꺼짐 — 실행 파일 저장 후 더블클릭 (자동 재확인 중)";
            }
            fixBtn?.classList.remove("hidden");
            startBtn?.classList.remove("hidden");
            recheckBtn?.classList.remove("hidden");
            stopHelperPoll();
            startHelperPoll(2800);
          }
        } catch {
          const was = helperOk;
          helperOk = false;
          helperWasOk = false;
          helperBar.classList.add("warn");
          if (helperText) {
            helperText.textContent =
              "도우미 꺼짐 — 실행 파일 저장 후 더블클릭 (자동 재확인 중)";
          }
          fixBtn?.classList.remove("hidden");
          startBtn?.classList.remove("hidden");
          recheckBtn?.classList.remove("hidden");
          updateHelperOutDirUi("");
          stopHelperPoll();
          startHelperPoll(2800);
          if (was) deps.toast("도우미 연결이 끊겼습니다", "error");
        }
      }

      return {
        stopHelperPoll,
        startHelperPoll,
        updateHelperOutDirUi,
        refreshHelperStatus,
        getHelperOk,
        setHelperOk,
        getHelperOutDirCache,
        setHelperOutDirCache
      };
    }

    return { createController };
  }
);
