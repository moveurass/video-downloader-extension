/**
 * Universal Video Downloader — Background Service Worker
 * Detect media, merge HLS, save via chrome.downloads (verified complete).
 */
importScripts(
  "history-model.js",
  "uvd-common.js",
  "progress-protocol.js",
  "background-download-jobs.js",
  "background-page-fallback.js",
  "site-detection.js",
  "download-routing.js",
  "download-engine.js",
  "background-filename.js",
  "background-site-helper.js",
  "download-message-handler.js",
  "background-message-router.js",
  "background-context-menus.js",
  "background-quality-messages.js",
  "background-download-messages.js",
  "background-direct-download-messages.js",
  "background-series-messages.js",
  "background-media-messages.js",
  "background-helper-messages.js",
  "background-chunk-assembly.js",
  "background-smart-download.js",
  "background-download-execution.js",
  "background-scheduled-jobs.js",
  "background-media-state.js",
  "background-save-pipeline.js",
  "background-direct-media.js",
  "background-hls-runtime.js",
  "hls-downloader.js",
  "naming.js",
  "ytdlp.js"
);

/** yt-dlp formats probe cache: url → { data, at } (probing takes seconds) */
const formatsCache = new Map();
const FORMATS_CACHE_TTL = 3 * 60 * 1000;
/** Refcounted SW keep-alive while any download runs */
const BG_MAX_CONCURRENT_STARTS = 6;
function MAX_CONCURRENT_STARTS_BG() {
  return BG_MAX_CONCURRENT_STARTS;
}
const {
  hostOf,
  isYoutubeUrl,
  isTiktokUrl,
  isInstagramHostUrl,
  isInstagramPostUrl,
  isInstagramUrl,
  isInstagramCdnUrl,
  isTiktokCdnUrl,
  looksLikeVideoFileUrl,
  isXUrl,
  isFacebookUrl,
  isBilibiliUrl,
  needsYtDlpHelper,
  siteKind,
  siteDefaultTitle
} = UVDSites;
const {
  extFromUrl,
  isHlsUrl,
  isRealHls,
  sniffIsVideo,
  classifyMedia,
  withTimeout,
  friendlyFetchError,
  parseSpeedFromMessage,
  phaseRank,
  hlsPhasePercent,
  estimateSavePercent
} = UVDDownloadEngine;
const isLikelyMedia = (url, mime = "", size = 0) =>
  UVDDownloadEngine.isLikelyMedia(url, mime, size, {
    isInstagramCdnUrl,
    isJunkMedia: Naming.isJunkMedia
  });
const {
  safeDownloadName: filenameSafeDownloadName,
  relDownloadPath: filenameRelDownloadPath,
  buildSaveFilename: filenameBuildSaveFilename,
  normalizeIncomingFilename: filenameNormalizeIncomingFilename,
  titlesMatchVideo: filenameTitlesMatchVideo,
  lockSaveName: filenameLockSaveName,
  applyQualityToLockedName: filenameApplyQualityToLockedName,
  ytdlpFilenameHint: filenameYtdlpHint,
  filenameFromUrl: filenameFromMediaUrl
} = UVDBackgroundFilename.createManager({
  UVD,
  Naming,
  UVDDownloadEngine
});

// ─── helpers ───────────────────────────────────────────────

function qualityLabel(height) {
  const h = height || 0;
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  if (h > 0) return `${h}p`;
  return null;
}

function hashUrl(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Download cover image next to the video file (same basename .jpg).
 * Best-effort — never fails the main download.
 */
async function saveCompanionThumbnail(job, result) {
  try {
    const settings = await UVD.getSettings();
    if (settings.saveThumbnail === false) return;
    if ((job?.mediaMode || settings.mediaMode) === "audio") return;
    // yt-dlp already wrote thumb when writeThumbnail was set
    if (result?.method === "yt-dlp" || result?.ytdlp) {
      // Still try if we have a URL and helper didn't (some extractors skip thumbs)
    }
    let thumbUrl = job?.thumbnail || "";
    if (!thumbUrl && job?.tabId != null && job.tabId >= 0) {
      thumbUrl = mediaStore.getTabMeta(job.tabId)?.thumbnail || "";
    }
    if (!thumbUrl || !/^https?:/i.test(thumbUrl)) return;

    const videoName =
      result?.filename ||
      job?.filename ||
      (result?.path ? String(result.path).split(/[/\\]/).pop() : "") ||
      "영상.mp4";
    let base = String(videoName).replace(/\.[a-z0-9]{2,5}$/i, "");
    if (!base || UVD.isGenericSaveName(base)) {
      base = (job?.title || "영상")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "영상";
    }
    const jpgName = filenameSafeDownloadName(`${base}.jpg`, "image/jpeg");
    const rel = await filenameRelDownloadPath(jpgName);

    // Prefer chrome.downloads direct URL (simple, no blob memory)
    try {
      await startChromeDownload(thumbUrl, rel);
      return;
    } catch {
      /* fall through to fetch */
    }
    try {
      const res = await fetch(thumbUrl, {
        credentials: "omit",
        cache: "no-store",
        headers: job?.pageUrl ? { Referer: job.pageUrl } : {}
      });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob.size || blob.size < 500) return;
      // small image via data URL
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
      const dataUrl = `data:${mime};base64,${b64}`;
      await startChromeDownload(dataUrl, rel);
    } catch (e) {
      console.warn("[UVD] thumb save", e);
    }
  } catch (e) {
    console.warn("[UVD] saveCompanionThumbnail", e);
  }
}

const downloadJobManager = UVDBackgroundDownloadJobs.createManager({
  chrome,
  UVD,
  UVDProgress,
  Naming,
  YtDlp,
  parseSpeedFromMessage,
  getTabMeta: (...args) => mediaStore.getTabMeta(...args),
  saveCompanionThumbnail: (...args) => saveCompanionThumbnail(...args),
  downloadPageFromUi: (...args) => downloadPageFromUi(...args),
  startKeepAlive: (...args) => startKeepAlive(...args),
  stopKeepAlive: (...args) => stopKeepAlive(...args),
  console
});
const {
  activeDownloads,
  tabJobMap,
  jobAbortControllers,
  hlsProgress,
  notifActions,
  getCurrentJobContext,
  publicJob,
  throwIfJobStopped,
  finalizePausedJob,
  finishCancelledJob,
  jobIsStopping,
  cancelDownloadJob,
  pauseDownloadJob,
  resumeDownloadJob,
  persistJobs,
  advanceJobEvent,
  broadcastJob,
  createDownloadJob,
  countRunningJobs,
  findRunningJob,
  withJobContext,
  updateDownloadJob,
  finishDownloadJob,
  notifyDownloadFinished,
  bindNotificationListener,
  listActiveDownloads,
  updateDownloadBadge,
  detachJobsFromTab,
  emitDownloadProgress
} = downloadJobManager;

const {
  ensureContentScripts: ensurePageContentScripts,
  pageDownloadAllFrames: pageDownloadAllFramesFallback
} = UVDBackgroundPageFallback.createFallback({
  chrome,
  withTimeout,
  activeDownloads,
  getCurrentJobContext,
  console
});

const mediaStore = UVDBackgroundMediaState.createStore({
  chrome,
  Naming,
  HLS,
  hostOf,
  isYoutubeUrl,
  isTiktokUrl,
  isInstagramPostUrl,
  isXUrl,
  isFacebookUrl,
  isBilibiliUrl,
  needsYtDlpHelper,
  siteKind,
  siteDefaultTitle,
  isLikelyMedia,
  classifyMedia,
  qualityLabel,
  hashUrl,
  titlesMatchVideo: filenameTitlesMatchVideo,
  withTabReferer: (tabId, operation) => withTabReferer(tabId, operation),
  detachJobsFromTab: (tabId) => detachJobsFromTab(tabId),
  console
});
const {
  addMedia,
  broadcastUpdate,
  getMediaForTab,
  getMediaForTabAsync,
  getTabItems,
  getTabMap,
  makeSitePlaceholder,
  maybeProbeHls,
  pageIdentityKey,
  resolveFilename,
  setTabMeta
} = mediaStore;

const siteHelperRunner = UVDBackgroundSiteHelper.createRunner({
  chrome,
  UVD,
  YtDlp,
  URL,
  Blob,
  Uint8Array,
  fetch,
  setTimeout,
  now: Date.now,
  console,
  isTiktokCdnUrl,
  isTiktokUrl,
  isInstagramUrl,
  isInstagramCdnUrl,
  looksLikeVideoFileUrl,
  siteKind,
  sniffIsVideo,
  withTimeout,
  safeDownloadName: filenameSafeDownloadName,
  ytdlpFilenameHint: filenameYtdlpHint,
  getCurrentJobContext: (...args) => getCurrentJobContext(...args),
  getActiveDownload: (jobId) => activeDownloads.get(jobId),
  getTabItems: (...args) => getTabItems(...args),
  ensureContentScripts: (...args) => ensurePageContentScripts(...args),
  withTabReferer: (...args) => withTabReferer(...args),
  downloadBlob: (...args) => downloadBlob(...args),
  throwIfJobStopped: (...args) => throwIfJobStopped(...args),
  emitDownloadProgress: (...args) => emitDownloadProgress(...args)
});

function bestNonBlobAlternative(tabId, excludeUrl) {
  const items = getTabItems(tabId).filter(
    (i) => i.url && i.url !== excludeUrl && !i.url.startsWith("blob:") && !Naming.isJunkMedia(i)
  );
  items.sort((a, b) => {
    const hs = (x) => (/\.m3u8/i.test(x.url || "") ? 500 : 0) + Naming.mediaScore(x);
    return hs(b) - hs(a);
  });
  return items[0] || null;
}

// ─── network capture / tab lifecycle ──────────────────────

mediaStore.bind();

// ─── context menus ─────────────────────────────────────────

const contextMenuController = UVDBackgroundContextMenus.createController({
  chrome,
  UVD,
  Naming,
  addMedia,
  getTabMap,
  resolveFilename,
  needsYtDlpHelper,
  getMediaForTabAsync,
  runTrackedDownloadAsync: (...args) => runTrackedDownloadAsync(...args),
  downloadSmart: (...args) => downloadSmart(...args),
  downloadPageFromUi: (...args) => downloadPageFromUi(...args),
  setTimeout,
  console
});
contextMenuController.bind();

/** Remove HLS part records leaked by a crashed/killed download. */
async function cleanupStaleHlsParts() {
  try {
    const db = await openBlobDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(
          IDBKeyRange.bound("hls_", "hls_\uffff")
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
chrome.runtime.onInstalled.addListener(() => cleanupStaleHlsParts());
chrome.runtime.onStartup.addListener(() => cleanupStaleHlsParts());

const downloadExecutor = UVDDownloadExecution.createExecutor({
  chrome,
  UVD,
  Naming,
  activeDownloads,
  getCurrentJobContext,
  siteKind,
  lockSaveName: filenameLockSaveName,
  downloadViaYtDlp: siteHelperRunner.downloadViaYtDlp,
  ensureContentScripts: ensurePageContentScripts,
  getMediaForTabAsync,
  emitDownloadProgress,
  downloadSmart: (...args) => downloadSmart(...args),
  broadcastJob,
  createDownloadJob,
  withJobContext,
  finalizePausedJob,
  finishCancelledJob,
  finishDownloadJob
});
const {
  sameVideoPage,
  waitTabComplete,
  findOrOpenTabForPage,
  downloadPageFromUi,
  startKeepAlive,
  stopKeepAlive,
  settleTrackedJob,
  runTrackedDownload,
  runTrackedDownloadAsync
} = downloadExecutor;

// Keyboard shortcuts (popup closed — runs in service worker)
// Alt+Shift+D 현재 탭 영상
// Alt+Shift+A 오디오만
// Alt+Shift+B 최고 화질
chrome.commands?.onCommand?.addListener(async (command) => {
  const map = {
    "download-current-page": { label: "영상" },
    "download-audio-only": { mediaMode: "audio", preferQuality: "best", label: "오디오" },
    "download-best-quality": { mediaMode: "video", preferQuality: "best", label: "최고 화질" }
  };
  const force = map[command];
  if (!force) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("탭 없음");
    const settings = await UVD.getSettings();
    // Default always highest quality (shortcut B forces best too)
    const quality = force.preferQuality || "best";
    const mediaMode = force.mediaMode || settings.mediaMode || "video";
    const title =
      Naming.cleanPageTitle(tab.title || "") || tab.title || force.label || "영상";
    // Prefer human page title as save name (legacy readable style)
    const fname =
      (await filenameBuildSaveFilename({
        title,
        quality: quality === "best" ? "" : quality,
        pageUrl: tab.url,
        mediaMode
      })) || "";
    await runTrackedDownloadAsync(
      {
        tabId: tab.id,
        title,
        pageUrl: tab.url,
        filename: fname,
        mediaMode,
        quality,
        thumbnail: mediaStore.getTabMeta(tab.id)?.thumbnail || ""
      },
      (jobId) =>
        downloadPageFromUi(tab.id, tab.url, quality, jobId, {
          mediaMode,
          preferQuality: quality
        })
    );
  } catch (e) {
    console.warn("[UVD] command download", command, e);
    try {
      if (chrome.notifications?.create) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "다운로드 실패",
          message: String(e?.message || e).slice(0, 120)
        });
      }
    } catch {
      /* ignore */
    }
  }
});

// ─── downloads ─────────────────────────────────────────────

const {
  startChromeDownload,
  waitDownloadComplete,
  blobToDataUrl,
  downloadBlobViaServiceWorker,
  downloadBlobViaDataUrl,
  IDB_NAME,
  IDB_STORE,
  openBlobDb,
  idbPutBlob,
  idbDeleteBlob,
  idbPartKey,
  idbPutPart,
  idbDeleteParts,
  downloadPartsViaTab,
  downloadBlobViaTab,
  downloadBlob
} = UVDBackgroundSavePipeline.createPipeline({
  chrome,
  indexedDB,
  IDBKeyRange,
  safeDownloadName: filenameSafeDownloadName,
  relDownloadPath: filenameRelDownloadPath,
  startKeepAlive,
  stopKeepAlive
});

const {
  probeContentLength,
  downloadDirectViaHelper,
  downloadMedia,
  withTabReferer,
  resolvePageUrl
} = UVDBackgroundDirectMedia.createTransport({
  chrome,
  fetch,
  UVD,
  YtDlp,
  activeDownloads,
  getCookieHeaderForUrl: siteHelperRunner.getCookieHeaderForUrl,
  ytdlpFilenameHint: filenameYtdlpHint,
  throwIfJobStopped,
  emitDownloadProgress,
  safeDownloadName: filenameSafeDownloadName,
  filenameFromUrl: filenameFromMediaUrl,
  startChromeDownload,
  relDownloadPath: filenameRelDownloadPath,
  waitDownloadComplete
});

const { runHlsDownload } = UVDBackgroundHlsRuntime.createRunner({
  HLS,
  UVD,
  Naming,
  activeDownloads,
  getCurrentJobContext,
  jobAbortControllers,
  hlsProgress,
  resolvePageUrl,
  lockSaveName: filenameLockSaveName,
  applyQualityToLockedName: filenameApplyQualityToLockedName,
  safeDownloadName: filenameSafeDownloadName,
  hlsPhasePercent,
  estimateSavePercent,
  emitDownloadProgress,
  broadcastJob,
  throwIfJobStopped,
  openBlobDb,
  idbPutPart,
  idbPartKey,
  idbDeleteParts,
  downloadPartsViaTab,
  downloadBlob
});

const { downloadSmart } = UVDBackgroundSmartDownload.createRouter({
  UVD,
  YtDlp,
  UVDDownloadRouting,
  activeDownloads,
  getCurrentJobContext,
  resolvePageUrl,
  emitDownloadProgress,
  downloadViaYtDlp: siteHelperRunner.downloadViaYtDlp,
  needsYtDlpHelper,
  isRealHls,
  bestNonBlobAlternative,
  pageDownloadAllFrames: pageDownloadAllFramesFallback,
  withTimeout,
  withTabReferer,
  runHlsDownload,
  friendlyFetchError,
  probeContentLength,
  downloadDirectViaHelper,
  downloadMedia
});

// ─── messages ──────────────────────────────────────────────

const handleDownloadMessage = UVDDownloadMessages.createHandler({
  cancel: cancelDownloadJob,
  pause: pauseDownloadJob,
  resume: resumeDownloadJob,
  list: listActiveDownloads,
  progress: (tabId) =>
    hlsProgress.get(-1) ||
    (tabId != null ? hlsProgress.get(tabId) : null)
});
const routeBackgroundMessage = UVDBackgroundMessages.createRouter({
  UVD,
  alarms: chrome.alarms,
  tabs: chrome.tabs,
  updateDownloadBadge,
  clearMedia: mediaStore.clearMedia,
  version: "1.21.0"
});
const handleQualityMessage = UVDQualityMessages.createHandler({
  HLS,
  YtDlp,
  tabs: chrome.tabs,
  getTabMap,
  qualityLabel,
  withTabReferer: (tabId, operation) => withTabReferer(tabId, operation),
  needsHelper: needsYtDlpHelper,
  cache: formatsCache,
  cacheTtl: FORMATS_CACHE_TTL,
  getCookieHeader: siteHelperRunner.getCookieHeader,
  collectCookies: siteHelperRunner.collectCookies,
  siteKind
});
const handleBackgroundDownloadMessage =
  UVDBackgroundDownloadMessages.createHandler({
    UVD,
    Naming,
    lockSaveName: filenameLockSaveName,
    runTrackedDownload,
    downloadPageFromUi
  });
const handleDirectDownloadMessage =
  UVDBackgroundDirectDownloadMessages.createHandler({
    Naming,
    lockSaveName: filenameLockSaveName,
    getTabMap,
    isHlsUrl,
    needsYtDlpHelper,
    runTrackedDownload,
    findOrOpenTabForPage,
    downloadSmart,
    chrome,
    setTimeout
  });
const handleBackgroundSeriesMessage =
  UVDBackgroundSeriesMessages.createHandler({
    UVD,
    YtDlp,
    activeDownloads,
    maxConcurrent: MAX_CONCURRENT_STARTS_BG,
    getCookieHeader: siteHelperRunner.getCookieHeader,
    collectCookies: siteHelperRunner.collectCookies,
    buildSaveFilename: filenameBuildSaveFilename,
    createDownloadJob,
    startKeepAlive,
    stopKeepAlive,
    withJobContext,
    downloadViaYtDlp: siteHelperRunner.downloadViaYtDlp,
    settleTrackedJob
  });
const handleMediaMessage = UVDBackgroundMediaMessages.createHandler({
  chrome,
  fetch,
  btoa,
  activeDownloads,
  jobIsStopping,
  hlsPhasePercent,
  emitDownloadProgress,
  setTabMeta,
  pageIdentityKey,
  addMedia,
  getMediaForTabAsync,
  needsYtDlpHelper,
  makeSitePlaceholder,
  getMediaForTab,
  probedUrls: mediaStore.probedUrls,
  maybeProbeHls,
  getTabMap
});
const handleHelperMessage = UVDBackgroundHelperMessages.createHandler({
  chrome,
  UVD,
  YtDlp,
  maxConcurrent: MAX_CONCURRENT_STARTS_BG,
  buildSaveFilename: filenameBuildSaveFilename,
  createDownloadJob,
  startKeepAlive,
  stopKeepAlive,
  withJobContext,
  downloadPageFromUi,
  finishDownloadJob
});
const handleChunkAssembly = UVDBackgroundChunkAssembly.createHandler({
  downloadBlob,
  Blob,
  Uint8Array,
  ArrayBuffer
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handled by dedicated listeners (save page / legacy offscreen)
  if (
    msg?.type === "SAVE_PAGE_DONE" ||
    msg?.type === "OFFSCREEN_SAVE" ||
    msg?.type === "OFFSCREEN_SAVE_IDB" ||
    msg?.type === "OFFSCREEN_CHUNK" ||
    msg?.type === "OFFSCREEN_FINISH"
  ) {
    return false;
  }

  const tabId = msg.tabId ?? sender.tab?.id;
  const downloadMessage = handleDownloadMessage(msg, sendResponse);
  if (downloadMessage.handled) return downloadMessage.keepChannel;
  const routedMessage = routeBackgroundMessage(msg, sendResponse);
  if (routedMessage.handled) return routedMessage.keepChannel;
  if (msg.type === "LIST_QUALITIES") {
    handleQualityMessage(msg, tabId)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error),
        qualities: [{ id: "best", label: "최고" }]
      }));
    return true;
  }
  const routedDownload = handleBackgroundDownloadMessage(
    msg,
    tabId,
    sendResponse
  );
  if (routedDownload.handled) return routedDownload.keepChannel;
  const routedSeries = handleBackgroundSeriesMessage(msg, tabId, sendResponse);
  if (routedSeries.handled) return routedSeries.keepChannel;
  const mediaMessage = handleMediaMessage(msg, tabId, sender, sendResponse);
  if (mediaMessage.handled) return mediaMessage.keepChannel;
  const helperMessage = handleHelperMessage(msg, tabId, sendResponse);
  if (helperMessage.handled) return helperMessage.keepChannel;
  const chunkAssembly = handleChunkAssembly(msg, sendResponse);
  if (chunkAssembly.handled) return chunkAssembly.keepChannel;
  const directDownload = handleDirectDownloadMessage(msg, tabId, sendResponse);
  if (directDownload.handled) return directDownload.keepChannel;
  return false;
});

UVDBackgroundScheduledJobs.createScheduler({
  chrome,
  UVD,
  startKeepAlive,
  stopKeepAlive,
  runTrackedDownloadAsync,
  downloadPageFromUi,
  console
}).bind();

console.log("[VideoDownloader] ready v1.23.3");
