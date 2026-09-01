(function initBackgroundKeyboardCommands(root, factory) {
  const api = factory();
  root.UVDBackgroundKeyboardCommands = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeKeyboardCommands() {
  "use strict";

  function createController(deps) {
    let bound = false;
    const commands = {
      "download-current-page": { label: "영상" },
      "download-audio-only": {
        mediaMode: "audio",
        preferQuality: "best",
        label: "오디오"
      },
      "download-best-quality": {
        mediaMode: "video",
        preferQuality: "best",
        label: "최고 화질"
      }
    };

    async function onCommand(command) {
      const force = commands[command];
      if (!force) return;
      try {
        const [tab] = await deps.chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab?.id || !tab.url) throw new Error("탭 없음");
        const settings = await deps.UVD.getSettings();
        const quality = force.preferQuality || "best";
        const mediaMode = force.mediaMode || settings.mediaMode || "video";
        const title =
          deps.Naming.cleanPageTitle(tab.title || "") ||
          tab.title ||
          force.label ||
          "영상";
        const filename =
          (await deps.buildSaveFilename({
            title,
            quality: quality === "best" ? "" : quality,
            pageUrl: tab.url,
            mediaMode
          })) || "";
        await deps.runTrackedDownloadAsync(
          {
            tabId: tab.id,
            title,
            pageUrl: tab.url,
            filename,
            mediaMode,
            quality,
            thumbnail: deps.getTabMeta(tab.id)?.thumbnail || ""
          },
          (jobId) =>
            deps.downloadPageFromUi(tab.id, tab.url, quality, jobId, {
              mediaMode,
              preferQuality: quality
            })
        );
      } catch (error) {
        deps.console.warn("[UVD] command download", command, error);
        try {
          if (deps.chrome.notifications?.create) {
            deps.chrome.notifications.create({
              type: "basic",
              iconUrl: deps.chrome.runtime.getURL("icons/icon128.png"),
              title: "다운로드 실패",
              message: String(error?.message || error).slice(0, 120)
            });
          }
        } catch {
          // Notifications are optional.
        }
      }
    }

    function bind() {
      if (bound || !deps.chrome.commands?.onCommand) return;
      bound = true;
      deps.chrome.commands.onCommand.addListener(onCommand);
    }

    return { onCommand, bind };
  }

  return { createController };
});
