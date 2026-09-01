"use strict";

const assert = require("node:assert/strict");
const PopupSettingsUI = require("../src/popup-settings-ui.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function classList() {
  const values = new Set();
  return {
    values,
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    }
  };
}

function select(values, value = "") {
  return {
    value,
    options: values.map((optionValue) => ({ value: optionValue }))
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const state = {
    settings: {
      subfolder: "Saved",
      filenameTemplate: "legacy",
      mediaMode: "audio",
      notifyOnComplete: false,
      clipboardWatch: true,
      warnDuplicates: false,
      saveThumbnail: false,
      uiDensity: "ultra",
      compactUi: true,
      popupWidth: "wide",
      showBadge: false,
      seriesComplete: false,
      seriesCompleteCount: 10,
      codecPref: "compat",
      downloadSpeed: "safe",
      qualityBySite: {
        default: "720p",
        youtube: "1080p",
        tiktok: "720p",
        instagram: "480p",
        x: "1080p",
        facebook: "720p",
        bilibili: "4K"
      }
    },
    helperOutDir: "/old",
    packs: [],
    currentTabUrl: "https://example.com/video",
    allItems: [{ id: "video" }]
  };
  const elements = {
    "#footerNote": {},
    "#setSubfolder": { value: "" },
    "#setTemplate": { value: "" },
    "#setMediaMode": select(["video", "audio", "video_subs"]),
    "#setNotify": {},
    "#setClipboard": {},
    "#setWarnDup": {},
    "#setSaveThumb": {},
    "#setUiDensity": select(["full", "compact", "ultra"]),
    "#setPopupWidth": select(["narrow", "normal", "wide"]),
    "#setShowBadge": {},
    "#setSeriesComplete": {},
    "#setSeriesCount": select(["3", "5", "10"]),
    "#setCompact": {},
    "#setQDefault": select(["best", "1080p", "720p"]),
    "#setQYoutube": select(["best", "1080p", "720p"]),
    "#setQTiktok": select(["best", "1080p", "720p", "480p"]),
    "#setQInstagram": select(["best", "1080p", "720p", "480p"]),
    "#setQX": select(["best", "1080p", "720p", "480p"]),
    "#setQFacebook": select(["best", "1080p", "720p", "480p"]),
    "#setQBilibili": select(["best", "4K", "1080p", "720p"]),
    "#setCodecPref": select(["best", "h264", "compat"]),
    "#setDownloadSpeed": select(["fast", "normal", "safe"]),
    "#setPreview": {}
  };
  const chips = ["video", "audio", "video_subs"].map((mode) => ({
    mode,
    classList: classList(),
    getAttribute(name) {
      return name === "data-mode" ? mode : null;
    }
  }));
  const document = {
    body: { classList: classList() },
    querySelectorAll(selector) {
      return selector === ".mode-chip" ? chips : [];
    }
  };
  const sendMessage = async (message) => {
    calls.push(["sendMessage", message]);
    if (message.type === "GET_SETTINGS") {
      return { settings: state.settings };
    }
    if (message.type === "SET_SETTINGS") {
      return { settings: message.settings };
    }
    if (message.type === "YTDLP_HEALTH") {
      return { outDir: "/new" };
    }
    if (message.type === "GET_SITE_PACKS") {
      return { packs: state.packs };
    }
    return {};
  };
  const deps = {
    $: (selector) => elements[selector] || null,
    document,
    sendMessage,
    UVD: {
      BUILTIN_SITE_PACKS: [],
      getSettings: async () => ({ mediaMode: "video" }),
      mediaModeLabel: (mode) => `mode:${mode}`,
      applyFilenameTemplate: (_template, data) =>
        `${data.title}_${data.quality}`
    },
    updateHelperOutDirUi: (value) =>
      calls.push(["updateHelperOutDirUi", value]),
    setupClipboardWatch: () => calls.push(["setupClipboardWatch"]),
    applySiteDefaultQuality: (url) =>
      calls.push(["applySiteDefaultQuality", url]),
    toast: (...args) => calls.push(["toast", ...args]),
    userError: (message) => `friendly:${message}`,
    render: () => calls.push(["render"]),
    getUvdSettings: () => state.settings,
    setUvdSettings: (value) => {
      state.settings = value;
    },
    getHelperOutDirCache: () => state.helperOutDir,
    setHelperOutDirCache: (value) => {
      state.helperOutDir = value;
    },
    getSitePacksCache: () => state.packs,
    setSitePacksCache: (value) => {
      state.packs = value;
    },
    getCurrentTabUrl: () => state.currentTabUrl,
    getAllItems: () => state.allItems,
    ...overrides
  };
  return {
    calls,
    state,
    elements,
    chips,
    document,
    controller: PopupSettingsUI.createController(deps)
  };
}

async function main() {
  check(typeof PopupSettingsUI.createController, "function");

  {
    const harness = makeHarness();
    check(Object.keys(harness.controller), [
      "loadSettings",
      "applyCompactUi",
      "applyUiLayout",
      "applyModeChips",
      "updateFooterNote",
      "fillSettingsForm",
      "updateSettingsPreview",
      "saveSettingsFromForm",
      "loadSitePacksUi"
    ]);
    await harness.controller.loadSettings();
    check([...harness.document.body.classList.values].sort(), [
      "compact-ui",
      "ultra-ui",
      "width-wide"
    ]);
    check(
      harness.chips.map((chip) => chip.classList.values.has("active")),
      [false, true, false]
    );
    check(
      harness.elements["#footerNote"].textContent,
      "저장: 다운로드/Saved · mode:audio · v1.23.3"
    );
  }

  {
    const harness = makeHarness();
    harness.controller.fillSettingsForm();
    await new Promise((resolve) => setImmediate(resolve));
    check(harness.elements["#setTemplate"].value, "legacy");
    check(
      [
        harness.elements["#setQDefault"].value,
        harness.elements["#setQYoutube"].value,
        harness.elements["#setQTiktok"].value,
        harness.elements["#setQInstagram"].value,
        harness.elements["#setQX"].value,
        harness.elements["#setQFacebook"].value,
        harness.elements["#setQBilibili"].value
      ],
      ["720p", "1080p", "720p", "480p", "1080p", "720p", "4K"]
    );
    check(harness.state.helperOutDir, "/new");
    check(
      harness.elements["#setPreview"].textContent,
      "Saved/SSIS-001 예제 영상 제목_1080p.mp3"
    );
  }

  {
    const fallback = { mediaMode: "video", popupWidth: "normal" };
    const harness = makeHarness({
      sendMessage: async () => {
        throw new Error("runtime unavailable");
      },
      UVD: {
        getSettings: async () => fallback,
        mediaModeLabel: (mode) => `mode:${mode}`,
        applyFilenameTemplate: () => "preview"
      }
    });
    await harness.controller.loadSettings();
    check(harness.state.settings, fallback);
  }

  {
    const harness = makeHarness();
    harness.elements["#setSubfolder"].value = "  New Folder  ";
    harness.elements["#setMediaMode"].value = "video_subs";
    harness.elements["#setNotify"].checked = true;
    harness.elements["#setClipboard"].checked = false;
    harness.elements["#setWarnDup"].checked = true;
    harness.elements["#setSaveThumb"].checked = true;
    harness.elements["#setUiDensity"].value = "full";
    harness.elements["#setPopupWidth"].value = "narrow";
    harness.elements["#setShowBadge"].checked = true;
    harness.elements["#setSeriesComplete"].checked = true;
    harness.elements["#setSeriesCount"].value = "3";
    harness.elements["#setCodecPref"].value = "h264";
    harness.elements["#setDownloadSpeed"].value = "normal";
    for (const id of [
      "#setQDefault",
      "#setQYoutube",
      "#setQTiktok",
      "#setQInstagram",
      "#setQX",
      "#setQFacebook",
      "#setQBilibili"
    ]) {
      harness.elements[id].value = "720p";
    }
    await harness.controller.saveSettingsFromForm();
    const saved = harness.calls.find(
      (call) => call[0] === "sendMessage" && call[1].type === "SET_SETTINGS"
    )[1].settings;
    check(saved, {
      subfolder: "New Folder",
      filenameTemplate: "legacy",
      mediaMode: "video_subs",
      notifyOnComplete: true,
      clipboardWatch: false,
      warnDuplicates: true,
      saveThumbnail: true,
      uiDensity: "full",
      compactUi: false,
      popupWidth: "narrow",
      showBadge: true,
      seriesComplete: true,
      seriesCompleteCount: 3,
      codecPref: "h264",
      downloadSpeed: "normal",
      qualityBySite: {
        default: "720p",
        youtube: "720p",
        tiktok: "720p",
        instagram: "720p",
        x: "720p",
        facebook: "720p",
        bilibili: "720p"
      }
    });
    check(
      harness.calls.some(
        (call) =>
          call[0] === "sendMessage" && call[1].type === "REFRESH_BADGE"
      ),
      true
    );
    check(
      harness.calls.filter((call) =>
        [
          "setupClipboardWatch",
          "applySiteDefaultQuality",
          "render"
        ].includes(call[0])
      ),
      [
        ["setupClipboardWatch"],
        ["applySiteDefaultQuality", "https://example.com/video"],
        ["render"]
      ]
    );
    check(
      harness.calls.some(
        (call) =>
          call[0] === "toast" &&
          call[1] === "설정을 저장했습니다" &&
          call[2] === "ok"
      ),
      true
    );
  }

  {
    const harness = makeHarness();
    for (const element of Object.values(harness.elements)) {
      if ("value" in element) element.value = "";
    }
    await harness.controller.saveSettingsFromForm();
    const saved = harness.calls.find(
      (call) => call[0] === "sendMessage" && call[1].type === "SET_SETTINGS"
    )[1].settings;
    check(saved, {
      subfolder: "VideoDownloader",
      filenameTemplate: "legacy",
      mediaMode: "video",
      notifyOnComplete: true,
      clipboardWatch: false,
      warnDuplicates: true,
      saveThumbnail: true,
      uiDensity: "compact",
      compactUi: true,
      popupWidth: "normal",
      showBadge: true,
      seriesComplete: true,
      seriesCompleteCount: 5,
      codecPref: "best",
      downloadSpeed: "fast",
      qualityBySite: {
        default: "best",
        youtube: "best",
        tiktok: "best",
        instagram: "best",
        x: "best",
        facebook: "best",
        bilibili: "best"
      }
    });
  }

  {
    let listener;
    const input = {
      checked: false,
      getAttribute: () => "pack&one",
      addEventListener: (_name, callback) => {
        listener = callback;
      }
    };
    const root = {
      innerHTML: "",
      querySelectorAll: () => [input]
    };
    const harness = makeHarness({
      $: (selector) =>
        selector === "#sitePackList" ? root : null
    });
    harness.state.packs = [
      {
        id: "pack&one",
        name: "<Pack>",
        enabled: true,
        rules: { note: "\"safe\"" }
      }
    ];
    await harness.controller.loadSitePacksUi();
    check(root.innerHTML.includes('data-pack-id="pack&amp;one"'), true);
    check(root.innerHTML.includes("&lt;Pack&gt;"), true);
    await listener();
    check(harness.state.packs[0].enabled, false);
    check(
      harness.calls.some(
        (call) =>
          call[0] === "sendMessage" &&
          call[1].type === "SET_SITE_PACKS" &&
          call[1].packs[0].enabled === false
      ),
      true
    );
    check(
      harness.calls.some(
        (call) =>
          call[0] === "toast" &&
          call[1] === "pack&one 팩 끔" &&
          call[2] === "ok"
      ),
      true
    );
  }

  {
    const errorCalls = [];
    const harness = makeHarness({
      sendMessage: async (message) => {
        if (message.type === "SET_SETTINGS") throw new Error("broken");
        return {};
      },
      toast: (...args) => errorCalls.push(args),
      userError: (message) => `friendly:${message}`
    });
    await harness.controller.saveSettingsFromForm();
    check(errorCalls, [["friendly:broken", "error"]]);
  }

  console.log(`popup settings UI: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
