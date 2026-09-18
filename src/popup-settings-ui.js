(function initPopupSettingsUI(root, factory) {
  const api = factory();
  root.UVDPopupSettingsUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupSettingsUI() {
    "use strict";

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/'/g, "&#39;");
    }

    function createController(deps) {
      const {
        $,
        document,
        sendMessage,
        UVD,
        updateHelperOutDirUi,
        setupClipboardWatch,
        applySiteDefaultQuality,
        toast,
        userError,
        render,
        getUvdSettings,
        setUvdSettings,
        getHelperOutDirCache,
        setHelperOutDirCache,
        getSitePacksCache,
        setSitePacksCache,
        getCurrentTabUrl,
        getAllItems
      } = deps;

      async function loadSettings() {
        try {
          const res = await sendMessage({ type: "GET_SETTINGS" });
          if (res?.settings) setUvdSettings(res.settings);
        } catch {
          try {
            setUvdSettings(await UVD.getSettings());
          } catch {
            /* defaults */
          }
        }
        applyModeChips();
        applyCompactUi();
        updateFooterNote();
      }

      function applyCompactUi() {
        applyUiLayout();
      }

      function applyTheme() {
        const theme = getUvdSettings().theme || "system";
        const value = ["light", "dark", "system"].includes(theme)
          ? theme
          : "system";
        for (const el of [document.documentElement, document.body]) {
          el?.setAttribute?.("data-theme", value);
        }
      }

      function applyUiLayout() {
        applyTheme();
        const uvdSettings = getUvdSettings();
        const width = uvdSettings.popupWidth || "normal";
        document.body.classList.remove(
          "width-narrow",
          "width-normal",
          "width-wide"
        );
        document.body.classList.add(
          width === "narrow"
            ? "width-narrow"
            : width === "wide"
              ? "width-wide"
              : "width-normal"
        );

        const density =
          uvdSettings.uiDensity ||
          (uvdSettings.compactUi === false ? "full" : "compact");
        document.body.classList.remove("compact-ui", "ultra-ui", "full-ui");
        if (density === "ultra") {
          document.body.classList.add("compact-ui", "ultra-ui");
        } else if (density === "full") {
          document.body.classList.add("full-ui");
        } else {
          document.body.classList.add("compact-ui");
        }

        const fontSize = ["large", "xlarge"].includes(
          uvdSettings.fontSize || ""
        )
          ? uvdSettings.fontSize
          : "default";
        document.body.classList.remove("font-large", "font-xlarge");
        if (fontSize === "large") document.body.classList.add("font-large");
        if (fontSize === "xlarge") document.body.classList.add("font-xlarge");
      }

      function applyModeChips() {
        const mode = getUvdSettings().mediaMode || "video";
        document.querySelectorAll(".mode-chip").forEach((chip) => {
          chip.classList.toggle(
            "active",
            chip.getAttribute("data-mode") === mode
          );
        });
      }

      function effectiveSaveTarget(settings) {
        const picked = String(settings?.downloadDir || "");
        if (!picked) {
          return `다운로드/${settings?.subfolder || "VideoDownloader"}`;
        }
        const sub = String(settings?.subfolder || "");
        return sub ? `${picked}/${sub}` : picked;
      }

      function updateFooterNote() {
        const el = $("#footerNote");
        if (!el) return;
        const uvdSettings = getUvdSettings();
        const mode = UVD.mediaModeLabel(uvdSettings.mediaMode);
        el.textContent = `저장: ${effectiveSaveTarget(uvdSettings)} · ${mode} · v1.26.0`;
      }

      function updatePickFolderUi() {
        const uvdSettings = getUvdSettings();
        const hint = $("#setFolderHint");
        if (hint) {
          hint.textContent = uvdSettings.downloadDir
            ? "선택한 폴더 아래 경로 (선택사항)"
            : "다운로드 폴더 아래 경로예요. 예: VideoDownloader/YouTube";
        }
        const reset = $("#btnResetFolder");
        if (reset) {
          reset.classList.toggle("hidden", !uvdSettings.downloadDir);
        }
      }

      /** 도우미 저장 위치 line — the picked folder wins while one is set. */
      function refreshSaveLocationDisplay() {
        const picked = getUvdSettings().downloadDir;
        if (picked) {
          const el = $("#setHelperOutDir");
          if (el) el.textContent = `${picked} (직접 선택)`;
          return;
        }
        updateHelperOutDirUi(getHelperOutDirCache());
      }

      function fillSettingsForm() {
        const uvdSettings = getUvdSettings();
        const sub = $("#setSubfolder");
        const tpl = $("#setTemplate");
        const mode = $("#setMediaMode");
        const maxHistory = $("#setMaxHistory");
        const notify = $("#setNotify");
        const clip = $("#setClipboard");
        const warnDup = $("#setWarnDup");
        const qbs = uvdSettings.qualityBySite || {};
        if (sub) {
          sub.value =
            uvdSettings.subfolder || (uvdSettings.downloadDir ? "" : "VideoDownloader");
        }
        updatePickFolderUi();
        if (tpl) {
          const stored = String(uvdSettings.filenameTemplate || "legacy");
          tpl.value = /^legacy$/i.test(stored) ? "" : stored;
        }
        if (mode) mode.value = uvdSettings.mediaMode || "video";
        if (maxHistory) {
          maxHistory.value = String(uvdSettings.maxHistory || 50);
        }
        if (notify) notify.checked = uvdSettings.notifyOnComplete !== false;
        if (clip) clip.checked = !!uvdSettings.clipboardWatch;
        if (warnDup) warnDup.checked = uvdSettings.warnDuplicates !== false;
        refreshSaveLocationDisplay();
        // Refresh helper path when opening settings
        sendMessage({ type: "YTDLP_HEALTH", force: false })
          .then((health) => {
            if (health?.outDir) setHelperOutDirCache(String(health.outDir));
            refreshSaveLocationDisplay();
          })
          .catch(() => refreshSaveLocationDisplay());
        const saveThumb = $("#setSaveThumb");
        if (saveThumb) {
          saveThumb.checked = uvdSettings.saveThumbnail !== false;
        }
        const density = $("#setUiDensity");
        if (density) {
          density.value =
            uvdSettings.uiDensity ||
            (uvdSettings.compactUi === false ? "full" : "compact");
        }
        const width = $("#setPopupWidth");
        if (width) width.value = uvdSettings.popupWidth || "normal";
        const fontSize = $("#setFontSize");
        if (fontSize) {
          fontSize.value = ["large", "xlarge"].includes(
            uvdSettings.fontSize || ""
          )
            ? uvdSettings.fontSize
            : "default";
        }
        const theme = $("#setTheme");
        if (theme) {
          const current = uvdSettings.theme || "system";
          theme.value = ["system", "light", "dark"].includes(current)
            ? current
            : "system";
        }
        const completeSound = $("#setCompleteSound");
        if (completeSound) completeSound.checked = !!uvdSettings.completionSound;
        const badge = $("#setShowBadge");
        if (badge) badge.checked = uvdSettings.showBadge !== false;
        const seriesComplete = $("#setSeriesComplete");
        if (seriesComplete) {
          seriesComplete.checked = uvdSettings.seriesComplete !== false;
        }
        const seriesCount = $("#setSeriesCount");
        if (seriesCount) {
          const count = String(uvdSettings.seriesCompleteCount || 5);
          if ([...seriesCount.options].some((option) => option.value === count)) {
            seriesCount.value = count;
          }
        }
        const compact = $("#setCompact");
        if (compact) compact.checked = uvdSettings.compactUi !== false;
        loadSitePacksUi();
        const setSelect = (id, value) => {
          const el = $(id);
          if (!el) return;
          const selected = value || "best";
          if ([...el.options].some((option) => option.value === selected)) {
            el.value = selected;
          } else {
            el.value = "best";
          }
        };
        setSelect("#setQDefault", qbs.default);
        setSelect("#setQYoutube", qbs.youtube);
        setSelect("#setQTiktok", qbs.tiktok);
        setSelect("#setQInstagram", qbs.instagram);
        setSelect("#setQX", qbs.x);
        setSelect("#setQFacebook", qbs.facebook);
        setSelect("#setQBilibili", qbs.bilibili);
        const codec = $("#setCodecPref");
        if (codec) {
          const codecPref = uvdSettings.codecPref || "best";
          codec.value = ["best", "h264", "compat"].includes(codecPref)
            ? codecPref
            : "best";
        }
        const speed = $("#setDownloadSpeed");
        if (speed) {
          const downloadSpeed = uvdSettings.downloadSpeed || "fast";
          speed.value = ["fast", "normal", "safe"].includes(downloadSpeed)
            ? downloadSpeed
            : "fast";
        }
        updateSettingsPreview();
      }

      function updateSettingsPreview() {
        const uvdSettings = getUvdSettings();
        const template =
          $("#setTemplate")?.value ||
          uvdSettings.filenameTemplate ||
          "legacy";
        const mode =
          $("#setMediaMode")?.value || uvdSettings.mediaMode || "video";
        const base =
          UVD.applyFilenameTemplate(template, {
            title: "SSIS-001 예제 영상 제목",
            quality: "1080p",
            site: "youtube",
            mediaMode: mode
          }) || "SSIS-001 예제 영상 제목_1080p";
        const extension = mode === "audio" ? ".mp3" : ".mp4";
        const preview = $("#setPreview");
        if (preview) {
          const typedSub =
            $("#setSubfolder")?.value?.trim() ??
            uvdSettings.subfolder ??
            "";
          const target =
            uvdSettings.downloadDir
              ? `${uvdSettings.downloadDir}${typedSub ? `/${typedSub}` : ""}`
              : `${typedSub || "VideoDownloader"}`;
          preview.textContent = `${target}/${base}${base.endsWith(extension) ? "" : extension}`;
        }
      }

      async function saveSettingsFromForm() {
        const template = $("#setTemplate")?.value?.trim() || "legacy";
        const uiDensity = $("#setUiDensity")?.value || "compact";
        const pickedDir = getUvdSettings().downloadDir || "";
        const patch = {
          subfolder:
            $("#setSubfolder")?.value?.trim() ||
            (pickedDir ? "" : "VideoDownloader"),
          filenameTemplate: template,
          mediaMode: $("#setMediaMode")?.value || "video",
          maxHistory:
            parseInt($("#setMaxHistory")?.value || "50", 10) || 50,
          notifyOnComplete: $("#setNotify")?.checked !== false,
          completionSound: !!$("#setCompleteSound")?.checked,
          clipboardWatch: !!$("#setClipboard")?.checked,
          warnDuplicates: $("#setWarnDup")?.checked !== false,
          saveThumbnail: $("#setSaveThumb")?.checked !== false,
          uiDensity,
          compactUi: uiDensity !== "full",
          popupWidth: $("#setPopupWidth")?.value || "normal",
          fontSize: $("#setFontSize")?.value || "default",
          theme: $("#setTheme")?.value || "system",
          showBadge: $("#setShowBadge")?.checked !== false,
          seriesComplete: $("#setSeriesComplete")?.checked !== false,
          seriesCompleteCount:
            parseInt($("#setSeriesCount")?.value || "5", 10) || 5,
          codecPref: $("#setCodecPref")?.value || "best",
          downloadSpeed: $("#setDownloadSpeed")?.value || "fast",
          qualityBySite: {
            default: $("#setQDefault")?.value || "best",
            youtube: $("#setQYoutube")?.value || "best",
            tiktok: $("#setQTiktok")?.value || "best",
            instagram: $("#setQInstagram")?.value || "best",
            x: $("#setQX")?.value || "best",
            facebook: $("#setQFacebook")?.value || "best",
            bilibili: $("#setQBilibili")?.value || "best"
          }
        };
        try {
          const res = await sendMessage({
            type: "SET_SETTINGS",
            settings: patch
          });
          setUvdSettings(res?.settings || patch);
          applyModeChips();
          applyUiLayout();
          updateFooterNote();
          setupClipboardWatch();
          // Re-apply site quality to current video
          const currentTabUrl = getCurrentTabUrl();
          if (currentTabUrl) applySiteDefaultQuality(currentTabUrl);
          // Refresh badge policy
          sendMessage({ type: "REFRESH_BADGE" }).catch(() => {});
          toast("설정을 저장했습니다", "ok");
          if (getAllItems()[0]) render();
        } catch (error) {
          toast(userError(error?.message) || "설정 저장 실패", "error");
        }
      }

      async function loadSitePacksUi() {
        const root = $("#sitePackList");
        if (!root) return;
        let sitePacks;
        try {
          const res = await sendMessage({ type: "GET_SITE_PACKS" });
          sitePacks = res?.packs || UVD.BUILTIN_SITE_PACKS || [];
        } catch {
          sitePacks = UVD.BUILTIN_SITE_PACKS || [];
        }
        setSitePacksCache(sitePacks);
        root.innerHTML = sitePacks
          .map(
            (pack) => `
    <label class="site-pack-row">
      <input type="checkbox" data-pack-id="${escapeAttr(pack.id)}" ${
        pack.enabled !== false ? "checked" : ""
      } />
      <span class="site-pack-meta">
        <span class="site-pack-name">${escapeHtml(pack.name || pack.id)}</span>
        <span class="site-pack-note">${escapeHtml(
          pack.rules?.note || (pack.hosts || []).slice(0, 3).join(", ")
        )}</span>
      </span>
    </label>`
          )
          .join("");
        root.querySelectorAll("input[data-pack-id]").forEach((input) => {
          input.addEventListener("change", async () => {
            const id = input.getAttribute("data-pack-id");
            const nextPacks = getSitePacksCache().map((pack) =>
              pack.id === id ? { ...pack, enabled: input.checked } : pack
            );
            setSitePacksCache(nextPacks);
            await sendMessage({
              type: "SET_SITE_PACKS",
              packs: nextPacks
            }).catch(() => {});
            toast(input.checked ? `${id} 팩 사용` : `${id} 팩 끔`, "ok");
          });
        });
      }

      /**
       * 폴더 선택 button: open the helper's native macOS chooser, then save
       * the picked folder immediately (clearing the sub-path so files land
       * exactly there). Cancel is silent; failures surface via toast.
       */
      async function pickDownloadFolder(button) {
        const btn = button || $("#btnPickFolder");
        const original = btn?.textContent;
        if (btn) {
          btn.disabled = true;
          btn.textContent = "선택 중…";
        }
        try {
          const res = await sendMessage({ type: "PICK_FOLDER" });
          if (res?.ok === false) {
            throw new Error(res.error || "폴더를 선택하지 못했습니다");
          }
          if (!res?.picked) return; // user closed the dialog
          const path = String(res.path || "");
          const saved = await sendMessage({
            type: "SET_SETTINGS",
            settings: { downloadDir: path, subfolder: "" }
          });
          setUvdSettings(saved?.settings || { ...getUvdSettings(), downloadDir: path, subfolder: "" });
          const sub = $("#setSubfolder");
          if (sub) sub.value = "";
          updatePickFolderUi();
          updateSettingsPreview();
          updateFooterNote();
          toast("저장 폴더를 변경했습니다", "ok");
        } catch (error) {
          toast(userError(error?.message) || "폴더를 선택하지 못했습니다", "error");
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = original || "폴더 선택";
          }
        }
      }

      /** 기본 폴더 button: drop the picked folder, back to Downloads/VideoDownloader. */
      async function resetDownloadFolder(button) {
        const btn = button || $("#btnResetFolder");
        if (btn) btn.disabled = true;
        try {
          const saved = await sendMessage({
            type: "SET_SETTINGS",
            settings: { downloadDir: "", subfolder: "VideoDownloader" }
          });
          setUvdSettings(saved?.settings || { ...getUvdSettings(), downloadDir: "", subfolder: "VideoDownloader" });
          const sub = $("#setSubfolder");
          if (sub) sub.value = "VideoDownloader";
          updatePickFolderUi();
          updateSettingsPreview();
          updateFooterNote();
          toast("기본 저장 폴더로 되돌렸습니다", "ok");
        } catch (error) {
          toast(userError(error?.message) || "되돌리지 못했습니다", "error");
        } finally {
          if (btn) btn.disabled = false;
        }
      }

      return {
        loadSettings,
        applyCompactUi,
        applyTheme,
        applyUiLayout,
        applyModeChips,
        updateFooterNote,
        updatePickFolderUi,
        fillSettingsForm,
        updateSettingsPreview,
        saveSettingsFromForm,
        pickDownloadFolder,
        resetDownloadFolder,
        loadSitePacksUi
      };
    }

    return { createController };
  }
);
