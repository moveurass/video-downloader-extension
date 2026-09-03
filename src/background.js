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
  "background-media-utils.js",
  "background-companion-thumbnail.js",
  "background-housekeeping.js",
  "background-keyboard-commands.js",
  "background-runtime-messages.js",
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
  isRealDash,
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

const { qualityLabel, hashUrl } = UVDBackgroundMediaUtils;
const { saveCompanionThumbnail } =
  UVDBackgroundCompanionThumbnail.createSaver({
    UVD,
    Uint8Array,
    btoa,
    fetch,
    safeDownloadName: filenameSafeDownloadName,
    relDownloadPath: filenameRelDownloadPath,
    getTabMeta: (...args) => mediaStore.getTabMeta(...args),
    startChromeDownload: (...args) => startChromeDownload(...args),
    console
  });

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
  cleanupResumeState: (state) =>
    state?.partBase ? idbDeleteParts(state.partBase) : Promise.resolve(),
  waitForChromeDownload: (downloadId) =>
    waitDownloadComplete(downloadId, 40 * 60 * 1000),
  console
});
const {
  ready: downloadJobsReady,
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
const bestNonBlobAlternative =
  UVDBackgroundMediaUtils.createAlternativeSelector({
    Naming,
    getTabItems: (...args) => getTabItems(...args)
  });

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
  lockSaveName: filenameLockSaveName,
  needsYtDlpHelper,
  getMediaForTabAsync,
  runTrackedDownloadAsync: (...args) => runTrackedDownloadAsync(...args),
  downloadSmart: (...args) => downloadSmart(...args),
  downloadPageFromUi: (...args) => downloadPageFromUi(...args),
  setTimeout,
  console
});
contextMenuController.bind();

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
UVDBackgroundKeyboardCommands.createController({
  chrome,
  UVD,
  Naming,
  buildSaveFilename: filenameBuildSaveFilename,
  getTabMeta: (...args) => mediaStore.getTabMeta(...args),
  runTrackedDownloadAsync,
  downloadPageFromUi,
  console
}).bind();

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
  idbListParts,
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
UVDBackgroundHousekeeping.createController({
  chrome,
  IDBKeyRange,
  storeName: IDB_STORE,
  openBlobDb
}).bind();

const {
  probeContentLength,
  downloadDirectViaHelper,
  downloadDashViaHelper,
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
  collectCookiesForUrl: siteHelperRunner.collectCookiesForUrl,
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
  idbListParts,
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
  isRealDash,
  bestNonBlobAlternative,
  pageDownloadAllFrames: pageDownloadAllFramesFallback,
  withTimeout,
  withTabReferer,
  runHlsDownload,
  friendlyFetchError,
  probeContentLength,
  downloadDirectViaHelper,
  downloadDashViaHelper,
  downloadMedia
});

// ─── messages ──────────────────────────────────────────────

const handleDownloadMessage = UVDDownloadMessages.createHandler({
  cancel: cancelDownloadJob,
  pause: pauseDownloadJob,
  resume: resumeDownloadJob,
  list: async () => {
    await downloadJobsReady;
    return listActiveDownloads();
  },
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
  version: chrome.runtime.getManifest?.()?.version || "unknown"
});
const handleQualityMessage = UVDQualityMessages.createHandler({
  HLS,
  YtDlp,
  tabs: chrome.tabs,
  getTabMap,
  qualityLabel,
  withTabReferer: (tabId, operation) => withTabReferer(tabId, operation),
  needsHelper: (url, pageUrl) =>
    isRealDash(url, "stream") || needsYtDlpHelper(url, pageUrl),
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
  ArrayBuffer,
  atob
});

const { dispatch: dispatchRuntimeMessage } =
  UVDBackgroundRuntimeMessages.createDispatcher({
    handleDownloadMessage,
    routeBackgroundMessage,
    handleQualityMessage,
    handleBackgroundDownloadMessage,
    handleBackgroundSeriesMessage,
    handleMediaMessage,
    handleHelperMessage,
    handleChunkAssembly,
    handleDirectDownloadMessage
  });
chrome.runtime.onMessage.addListener(dispatchRuntimeMessage);

UVDBackgroundScheduledJobs.createScheduler({
  chrome,
  UVD,
  startKeepAlive,
  stopKeepAlive,
  runTrackedDownloadAsync,
  downloadPageFromUi,
  console
}).bind();

console.log("[VideoDownloader] ready v1.26.0");
