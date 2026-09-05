(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.UVDPopupInit = factory();
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    "use strict";

    function start(rootOverride) {
      const root =
        rootOverride ||
        (typeof globalThis !== "undefined" ? globalThis : {});
      const {
        document,
        navigator,
        setInterval,
        clearInterval,
        setTimeout,
        URL,
        chrome,
        UVD,
        UVDSites,
        UVDPopupMedia,
        Naming,
        UVDPopupDisplayUtils,
        UVDPopupHelperState,
        UVDPopupQualityState,
        UVDQuality,
        UVDPopupProgressUI,
        UVDPopupSound,
        UVDQueueState,
        UVDPopupQueueUI,
        UVDPopupRecoveryUI,
        UVDPopupClipboardHistory,
        UVDPopupLibraryUI,
        UVDPopupSettingsUI,
        UVDPopupSeriesUI,
        UVDPopupSeriesDiscovery,
        UVDPopupSeriesNetwork,
        UVDPopupSeriesWatchlistFlow,
        UVDPopupWatchlistUI,
        UVDPopupSeriesBannerUI,
        UVDPopupDuplicateConfirmation,
        UVDPopupPlaylistUI,
        UVDPopupMediaRenderer,
        UVDPopupMediaLoader,
        UVDPopupDownloadRequests,
        UVDPopupDomEvents,
        UVDPopupRuntimeEvents,
        UVDPopupNavigation,
        UVDPopupSeriesState
      } = root;

      let currentTabId = null;
      let currentTabUrl = null;
      let allItems = [];
      /** Background job ids tracked by this popup session */
      let trackedJobIds = new Set();
      /** Avoid double toast for the same completed job */
      let toastedJobIds = new Set();
      /** Local mirror of active download jobs for multi-queue UI @type {Map<string, object>} */
      const uiJobs = new Map();
      /** Max concurrent starts from this popup (SW can still hold more) */
      const MAX_CONCURRENT_STARTS = 6;
      /** @type {object} */
      let uvdSettings = { ...(UVD?.DEFAULT_SETTINGS || {}) };
      /** @type {Array<object>} */
      let historyItems = [];
      /** @type {Array<object>} */
      let watchlistItems = [];
      let activeTabName = "main";

      /** @type {{ url: string, title: string, entries: Array, playlistCount: number } | null} */
      let playlistInfo = null;
      let playlistLoading = false;
      /** Playlist download progress tracking for UI */
      let playlistDl = { active: false, total: 0, done: 0, jobIds: new Set() };

      /** Series complete pending payload */
      let seriesPending = null;
      /** Last series run id for batch failure retry */
      let lastSeriesRun = null;
      /** Default range for series preview: 3 | 5 | 10 | 'all' */
      let seriesRangePref = "5";
      /** Library filter state */
      let libFilter = { q: "", status: "done", site: "", series: "" };
      /** Cached site packs for settings */
      let sitePacksCache = [];

      const $ = (sel) => document.querySelector(sel);
      const listEl = $("#list");
      const emptyEl = $("#empty");
      const pageHost = $("#pageHost");
      const helperBar = $("#helperBar");
      const helperDot = $("#helperDot");
      const helperText = $("#helperText");

      const {
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramHostUrl: isInstagramHost,
        isInstagramPostUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isDownloadableSiteVideo,
        siteKind: siteKindFromUrl
      } = UVDSites;
      const isSitePage = isDownloadableSiteVideo;
      const isKnownDownloadablePage = (url) => {
        if (isDownloadableSiteVideo(url)) return true;
        return !!Naming.isKnownCodeVideoPage?.(url);
      };
      const { formatSize, formatDuration, formatKind, estimateSize } =
        UVDPopupMedia;
      const isHlsItem = UVDPopupMedia.isHlsItem;
      const isUglyName = UVDPopupMedia.isUglyName;

      const {
        buildLocalSiteItem,
        toast,
        cleanTitleText,
        siteLabel,
        displayName,
        downloadFilename,
        thumbHtml,
        formatTimeAgo,
        formatDurShort,
        updateLinkCount,
        escapeHtml,
        escapeAttr,
        userError,
        pageKey,
        ensureSiteItems
      } = UVDPopupDisplayUtils.createUtils({
        $,
        document,
        setTimeout,
        URL,
        pageHost,
        UVDSites,
        UVDPopupMedia,
        Naming,
        UVD,
        isSitePage,
        isKnownDownloadablePage,
        getCurrentTabUrl: () => currentTabUrl,
        getAllItems: () => allItems,
        getUvdSettings: () => uvdSettings,
        getSelectedQuality: () => getSelectedQuality()
      });

      const helperStateController = UVDPopupHelperState.createController({
        $,
        helperBar,
        helperText,
        isSitePage,
        getCurrentTabUrl: () => currentTabUrl,
        getAllItems: () => allItems,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        toast: (...args) => toast(...args)
      });
      const {
        stopHelperPoll,
        startHelperPoll,
        updateHelperOutDirUi,
        refreshHelperStatus,
        getHelperOk,
        setHelperOk,
        getHelperOutDirCache,
        setHelperOutDirCache
      } = helperStateController;

      const qualityController = UVDPopupQualityState.createController({
        UVDQuality,
        UVDPopupMedia,
        UVD,
        $,
        getCurrentTabId: () => currentTabId,
        getCurrentTabUrl: () => currentTabUrl,
        getAllItems: () => allItems,
        setAllItems: (value) => {
          allItems = value;
        },
        getUvdSettings: () => uvdSettings,
        isDownloadableSiteVideo,
        isSitePage,
        sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
        sendTabMessage: (tabId, message) =>
          chrome.tabs.sendMessage(tabId, message),
        getDocumentTitle: () =>
          typeof document !== "undefined" ? document.title : "",
        siteLabel: (...args) => siteLabel(...args),
        escapeHtml: (...args) => escapeHtml(...args),
        escapeAttr: (...args) => escapeAttr(...args)
      });
      const {
        FALLBACK_QUALITY_CHIPS,
        heightToQualityId,
        concreteQualityChip,
        ensureQualityChoices,
        formatMb,
        getSelectedQuality,
        setSelectedQuality,
        getAvailableQualities,
        setAvailableQualities,
        getAvailableAudioTracks,
        getAvailableSubtitleTracks,
        getSelectedAudioTrack,
        getSelectedSubtitleTracks,
        getQualitiesLoading,
        setQualitiesLoading,
        estimateForSelectedQuality,
        estimateBarHtml,
        metaRowsHtml,
        qualityPickerHtml,
        trackPickerHtml,
        bindTrackPicker,
        formatQualityChipLabel,
        qualityIdFromHeight,
        qualityFromMediaUrl,
        fetchPlayerHeight,
        isOnlyBareBest,
        loadAvailableQualities,
        applySiteDefaultQuality,
        syncGlobalQualityBox
      } = qualityController;

      let recoveryActionsHtml;
      let bindRecoveryButtons;
      let downloadHelperStarter;
      let showHelperHelp;
      const soundController = UVDPopupSound.createController({
        getSettings: () => uvdSettings
      });
      const progressController = UVDPopupProgressUI.createController({
        $,
        UVD,
        UVDQueueState,
        UVDPopupQueueUI,
        uiJobs,
        trackedJobIds,
        toastedJobIds,
        cleanTitleText,
        isUglyName,
        siteLabel,
        escapeHtml,
        escapeAttr,
        toast,
        userError,
        maxConcurrentStarts: MAX_CONCURRENT_STARTS,
        playCompletionSound: () => soundController.playCompletion(),
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        recoveryActionsHtml: (...args) => recoveryActionsHtml(...args),
        bindRecoveryButtons: (...args) => bindRecoveryButtons(...args),
        getPlaylistDl: () => playlistDl,
        updatePlaylistProgressUi: (...args) =>
          updatePlaylistProgressUi(...args)
      });
      const {
        runningJobCount,
        canStartAnotherDownload,
        ensureQueuePoll,
        refreshJobsFromBackground,
        upsertUiJob,
        renderDownloadQueue,
        showProgress,
        applyJobProgress,
        restoreActiveDownloads
      } = progressController;

      const recoveryController = UVDPopupRecoveryUI.createController({
        jobs: uiJobs,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        toast,
        userError,
        upsertUiJob,
        refreshJobsFromBackground,
        ensureQueuePoll,
        renderDownloadQueue,
        downloadByPastedLink: (...args) => downloadByPastedLink(...args),
        startHelperPoll,
        refreshHelperStatus
      });
      recoveryActionsHtml = (errMeta, pageUrl, job) =>
        UVDPopupRecoveryUI.recoveryActionsHtml(
          errMeta,
          pageUrl,
          job,
          escapeAttr
        );
      ({
        bindRecoveryButtons,
        downloadHelperStarter,
        showHelperHelp
      } = recoveryController);

      let switchTab;

      const {
        hideClipBanner,
        setupClipboardWatch,
        autofillOnce,
        loadHistoryUi,
        updateRetryFailedButton,
        loadRecentStrip,
        retryFailedDownloads,
        renderHistory,
        dismissClipboard
      } = UVDPopupClipboardHistory.createController({
        $,
        navigator,
        setInterval,
        clearInterval,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        UVD,
        UVDPopupLibraryUI,
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isSitePage,
        pageKey: (...args) => pageKey(...args),
        normalizePastedUrl: (...args) => normalizePastedUrl(...args),
        updateLinkCount: (...args) => updateLinkCount(...args),
        escapeHtml: (...args) => escapeHtml(...args),
        escapeAttr: (...args) => escapeAttr(...args),
        formatTimeAgo: (...args) => formatTimeAgo(...args),
        bindRecoveryButtons: (...args) => bindRecoveryButtons(...args),
        updateSeriesRetryButton: (...args) =>
          updateSeriesRetryButton(...args),
        retrySeriesFailed: (...args) => retrySeriesFailed(...args),
        switchTab: (...args) => switchTab(...args),
        offerSeriesComplete: (...args) => offerSeriesComplete(...args),
        toast: (...args) => toast(...args),
        refreshHelperStatus: (...args) => refreshHelperStatus(...args),
        ensureQueuePoll: (...args) => ensureQueuePoll(...args),
        refreshJobsFromBackground: (...args) =>
          refreshJobsFromBackground(...args),
        downloadByPastedLink: (...args) => downloadByPastedLink(...args),
        userError: (...args) => userError(...args),
        maxConcurrentStarts: MAX_CONCURRENT_STARTS,
        getUvdSettings: () => uvdSettings,
        setUvdSettings: (value) => {
          uvdSettings = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        setCurrentTabUrl: (value) => {
          currentTabUrl = value;
        },
        getHistoryItems: () => historyItems,
        setHistoryItems: (value) => {
          historyItems = value;
        },
        getLibFilter: () => libFilter,
        setLibFilter: (value) => {
          libFilter = value;
        },
        getLastSeriesRun: () => lastSeriesRun,
        setLastSeriesRun: (value) => {
          lastSeriesRun = value;
        },
        getCurrentTabId: () => currentTabId,
        setCurrentTabId: (value) => {
          currentTabId = value;
        },
        getSelectedQuality,
        setSelectedQuality,
        getSeriesPending: () => seriesPending,
        setSeriesPending: (value) => {
          seriesPending = value;
        }
      });

      const {
        loadSettings,
        applyCompactUi,
        applyUiLayout,
        applyModeChips,
        updateFooterNote,
        fillSettingsForm,
        updateSettingsPreview,
        saveSettingsFromForm,
        loadSitePacksUi
      } = UVDPopupSettingsUI.createController({
        $,
        document,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        UVD,
        updateHelperOutDirUi,
        setupClipboardWatch,
        applySiteDefaultQuality,
        toast,
        userError,
        render: (...args) => render(...args),
        getUvdSettings: () => uvdSettings,
        setUvdSettings: (value) => {
          uvdSettings = value;
        },
        getHelperOutDirCache,
        setHelperOutDirCache,
        getSitePacksCache: () => sitePacksCache,
        setSitePacksCache: (value) => {
          sitePacksCache = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        getAllItems: () => allItems
      });

      const seriesRangeLimit = (pref) =>
        UVDPopupSeriesUI.rangeLimit(
          pref == null ? seriesRangePref : pref
        );
      const resolveSeriesIdFromPayload = UVDPopupSeriesUI.resolveSeriesId;

      function rebuildSeriesVisibleItems() {
        UVDPopupSeriesState.rebuildVisibleItems(seriesPending, {
          rangePref: seriesRangePref,
          historyItems,
          buildVisibleItems: UVDPopupSeriesUI.buildVisibleItems,
          annotateSeriesDownloaded: UVD.annotateSeriesDownloaded,
          resolveSeriesId: resolveSeriesIdFromPayload
        });
      }

      const shortUrlDisplay = UVDPopupSeriesUI.shortUrlDisplay;
      const seriesDiscovery = UVDPopupSeriesDiscovery.createDiscovery({
        $,
        document,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        UVD,
        UVDPopupSeriesUI,
        UVDPopupSeriesNetwork,
        toast,
        userError,
        refreshHelperStatus,
        getAllItems: () => allItems,
        setAllItems: (value) => {
          allItems = value;
        },
        getHistoryItems: () => historyItems,
        setHistoryItems: (value) => {
          historyItems = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        setCurrentTabUrl: (value) => {
          currentTabUrl = value;
        },
        getCurrentTabId: () => currentTabId,
        setCurrentTabId: (value) => {
          currentTabId = value;
        },
        getHelperOk,
        setHelperOk,
        getSeriesPending: () => seriesPending,
        setSeriesPending: (value) => {
          seriesPending = value;
        },
        getSeriesRangePref: () => seriesRangePref,
        setSeriesRangePref: (value) => {
          seriesRangePref = value;
        },
        getUvdSettings: () => uvdSettings,
        setUvdSettings: (value) => {
          uvdSettings = value;
        },
        seriesRangeLimit,
        showSeriesBanner: (payload) => showSeriesBanner(payload),
        hideSeriesBanner: () => hideSeriesBanner(),
        showSeriesVerifyProgress: () => showSeriesVerifyProgress(),
        hideSeriesVerifyProgress: () => hideSeriesVerifyProgress(),
        updateSeriesVerifyProgress: (progress) =>
          updateSeriesVerifyProgress(progress)
      });
      const {
        seriesAnchorThumbnail,
        historyThumbForSeriesKey,
        guessSeriesItemUrls,
        seriesThumbCandidates,
        seriesNetwork,
        seriesThumbCache,
        fetchThumbDataUrl,
        resolveSeriesThumbDataUrl,
        hydrateSeriesThumbs,
        seriesItemThumbnail,
        patchSeriesRowThumb,
        enrichSeriesThumbnails,
        ensureHistoryLoaded,
        openSeriesFromPlaylist,
        offerSeriesComplete,
        seriesVerifyFailHint,
        seriesProbeErrorHint,
        validateProductSeriesItems
      } = seriesDiscovery;

      const seriesWatchlistController =
        UVDPopupSeriesWatchlistFlow.createController({
          $,
          document,
          URL,
          sendMessage: (message) => chrome.runtime.sendMessage(message),
          UVD,
          UVDPopupWatchlistUI,
          isDownloadableSiteVideo,
          isYoutubeUrl,
          isTiktokUrl,
          isInstagramHost,
          isInstagramPostUrl,
          isInstagramUrl,
          isXUrl,
          isFacebookUrl,
          isBilibiliUrl,
          isSitePage,
          resolveSeriesIdFromPayload,
          normalizePastedUrl: (...args) => normalizePastedUrl(...args),
          fnameBaseFromLink: (...args) => fnameBaseFromLink(...args),
          cleanTitleText,
          pageKey,
          isHlsItem,
          looksLikeDirectMedia: (...args) => looksLikeDirectMedia(...args),
          formatTimeAgo,
          escapeHtml,
          escapeAttr,
          downloadByPastedLink: (...args) =>
            downloadByPastedLink(...args),
          refreshHelperStatus,
          ensureQueuePoll,
          refreshJobsFromBackground,
          switchTab: (...args) => switchTab(...args),
          hideSeriesBanner: (...args) => hideSeriesBanner(...args),
          updateSeriesGoButton: (...args) =>
            updateSeriesGoButton(...args),
          toast,
          userError,
          maxConcurrentStarts: MAX_CONCURRENT_STARTS,
          getSeriesPending: () => seriesPending,
          setSeriesPending: (value) => {
            seriesPending = value;
          },
          getLastSeriesRun: () => lastSeriesRun,
          setLastSeriesRun: (value) => {
            lastSeriesRun = value;
          },
          getHistoryItems: () => historyItems,
          setHistoryItems: (value) => {
            historyItems = value;
          },
          getCurrentTabId: () => currentTabId,
          setCurrentTabId: (value) => {
            currentTabId = value;
          },
          getSelectedQuality,
          setSelectedQuality,
          getWatchlistItems: () => watchlistItems,
          setWatchlistItems: (value) => {
            watchlistItems = value;
          },
          getAllItems: () => allItems,
          setAllItems: (value) => {
            allItems = value;
          },
          getCurrentTabUrl: () => currentTabUrl,
          setCurrentTabUrl: (value) => {
            currentTabUrl = value;
          },
          getActiveTabName: () => activeTabName,
          setActiveTabName: (value) => {
            activeTabName = value;
          }
        });
      const {
        updateSeriesRetryButton,
        retrySeriesFailed,
        runSeriesComplete,
        loadWatchlistUi,
        renderWatchlist,
        downloadWatchSeriesGroup,
        removeWatchSeriesGroup,
        isWatchlistableUrl,
        resolveWatchlistUrl,
        addCurrentToWatchlist,
        downloadAllWatchlist
      } = seriesWatchlistController;

      ({ switchTab } = UVDPopupNavigation.createController({
        document,
        loadHistoryUi,
        loadWatchlistUi,
        fillSettingsForm,
        loadRecentStrip,
        setActiveTabName: (value) => {
          activeTabName = value;
        }
      }));

      const {
        hideSeriesBanner,
        showSeriesBanner,
        renderSeriesRangeChips,
        toggleSeriesMissingOnly,
        renderSeriesListBody,
        setSeriesSelection,
        setSeriesRange,
        updateSeriesGoButton,
        showSeriesVerifyProgress,
        hideSeriesVerifyProgress,
        updateSeriesVerifyProgress
      } = UVDPopupSeriesBannerUI.createController({
        $,
        getSeriesPending: () => seriesPending,
        setSeriesPending: (value) => {
          seriesPending = value;
        },
        getSeriesRangePref: () => seriesRangePref,
        setSeriesRangePref: (value) => {
          seriesRangePref = value;
        },
        getSelectedQuality,
        resolveSeriesIdFromPayload,
        rebuildSeriesVisibleItems,
        seriesItemThumbnail,
        seriesThumbCache,
        formatDurShort,
        shortUrlDisplay,
        escapeHtml,
        escapeAttr,
        hydrateSeriesThumbs,
        updateSeriesRetryButton
      });
      const { confirmNotDuplicate } =
        UVDPopupDuplicateConfirmation.createController({
          $,
          UVD,
          uiJobs,
          toast: (...args) => toast(...args),
          formatTimeAgo,
          sendMessage: (message) => chrome.runtime.sendMessage(message),
          getUvdSettings: () => uvdSettings
        });

      const playlistController = UVDPopupPlaylistUI.createController({
        $,
        UVD,
        jobs: uiJobs,
        trackedJobIds,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        getInfo: () => playlistInfo,
        setInfo: (value) => {
          playlistInfo = value;
        },
        getLoading: () => playlistLoading,
        setLoading: (value) => {
          playlistLoading = value;
        },
        getDownload: () => playlistDl,
        setDownload: (value) => {
          playlistDl = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        getCurrentTabId: () => currentTabId,
        getHelperOk,
        getSelectedQuality,
        getSeriesPending: () => seriesPending,
        getSeriesRangePref: () => seriesRangePref,
        setLastSeriesRun: (value) => {
          lastSeriesRun = value;
        },
        refreshHelperStatus,
        openSeriesFromPlaylist,
        seriesRangeLimit,
        runSeriesComplete,
        ensureQueuePoll,
        refreshJobsFromBackground,
        toast,
        userError
      });
      const {
        hide: hidePlaylistBox,
        render: renderPlaylistPanel,
        updateProgress: updatePlaylistProgressUi,
        load: loadPlaylistInfo,
        maxCount: playlistMaxCount,
        selectForDownload: selectPlaylistForDownload,
        downloadAll: downloadPlaylistAll
      } = playlistController;

      const mediaRenderer = UVDPopupMediaRenderer.createRenderer({
        listEl,
        chrome,
        document,
        ensureSiteItems,
        pageKey,
        syncGlobalQualityBox,
        isInstagramHost,
        isInstagramPostUrl,
        isYoutubeUrl,
        isTiktokUrl,
        isDownloadableSiteVideo,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        escapeHtml,
        escapeAttr,
        displayName,
        downloadFilename,
        siteLabel,
        thumbHtml,
        metaRowsHtml,
        estimateBarHtml,
        qualityPickerHtml,
        trackPickerHtml,
        bindTrackPicker,
        isOnlyBareBest,
        formatQualityChipLabel,
        loadAvailableQualities,
        canStartAnotherDownload,
        downloadItem: (...args) => downloadItem(...args),
        isWatchlistableUrl,
        addCurrentToWatchlist,
        offerSeriesComplete,
        toast,
        MAX_CONCURRENT_STARTS,
        getAllItems: () => allItems,
        setAllItems: (items) => {
          allItems = items;
        },
        getCurrentTabUrl: () => currentTabUrl,
        getCurrentTabId: () => currentTabId,
        getSelectedQuality,
        setSelectedQuality,
        getAvailableQualities,
        getAvailableAudioTracks,
        getAvailableSubtitleTracks,
        getQualitiesLoading,
        getSeriesPending: () => seriesPending
      });
      const render = mediaRenderer.render;
      const patchMedia = mediaRenderer.patch;

      const {
        resolveActiveTab,
        loadMedia,
        siteDisplayName,
        updateQuickPageUi,
        autofillLinkFromCurrentTab
      } = UVDPopupMediaLoader.createLoader({
        chrome,
        listEl,
        pageHost,
        $,
        UVD,
        ensureSiteItems,
        pageKey,
        isInstagramUrl,
        isTiktokUrl,
        isYoutubeUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isSitePage,
        isHlsItem,
        cleanTitleText,
        isUglyName,
        refreshHelperStatus,
        render,
        patchMedia,
        loadAvailableQualities,
        loadPlaylistInfo,
        hidePlaylistBox,
        getAllItems: () => allItems,
        setAllItems: (value) => {
          allItems = value;
        },
        getCurrentTabId: () => currentTabId,
        setCurrentTabId: (value) => {
          currentTabId = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        setCurrentTabUrl: (value) => {
          currentTabUrl = value;
        },
        getAvailableQualities,
        setAvailableQualities,
        getQualitiesLoading,
        setQualitiesLoading
      });

      const {
        downloadItem,
        normalizePastedUrl,
        fnameBaseFromLink,
        downloadByPastedLink,
        downloadThisPage,
        looksLikeDirectMedia
      } = UVDPopupDownloadRequests.createController({
        $,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        UVD,
        uiJobs,
        trackedJobIds,
        isYoutubeUrl,
        isTiktokUrl,
        isInstagramUrl,
        isXUrl,
        isFacebookUrl,
        isBilibiliUrl,
        isHlsItem,
        isWatchlistableUrl,
        isSitePage,
        downloadFilename,
        cleanTitleText,
        displayName,
        pageKey,
        refreshHelperStatus,
        confirmNotDuplicate,
        upsertUiJob,
        renderDownloadQueue,
        runningJobCount,
        ensureQueuePoll,
        updateLinkCount,
        updateQuickPageUi,
        loadPlaylistInfo,
        applySiteDefaultQuality,
        refreshJobsFromBackground,
        toast,
        userError,
        MAX_CONCURRENT_STARTS,
        getAllItems: () => allItems,
        getCurrentTabId: () => currentTabId,
        getCurrentTabUrl: () => currentTabUrl,
        getSelectedQuality,
        getSelectedAudioTrack,
        getSelectedSubtitleTracks,
        getHelperOk,
        getUvdSettings: () => uvdSettings
      });

      UVDPopupDomEvents.bind({
        $,
        document,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        loadMedia,
        render,
        downloadByPastedLink,
        downloadThisPage,
        updateLinkCount,
        switchTab,
        applyModeChips,
        updateFooterNote,
        toast,
        saveSettingsFromForm,
        updateSettingsPreview,
        previewCompletionSound: () => soundController.playChime(),
        renderHistory,
        updateRetryFailedButton,
        retryFailedDownloads,
        showHelperHelp,
        downloadHelperStarter,
        refreshHelperStatus,
        downloadPlaylistAll,
        selectPlaylistForDownload,
        loadPlaylistInfo,
        runSeriesComplete,
        hideSeriesBanner,
        retrySeriesFailed,
        setSeriesSelection,
        toggleSeriesMissingOnly,
        setSeriesRange,
        loadHistoryUi,
        addCurrentToWatchlist,
        downloadAllWatchlist,
        renderWatchlist,
        hideClipBanner,
        dismissClipboard,
        getUvdSettings: () => uvdSettings,
        setUvdSettings: (value) => {
          uvdSettings = value;
        },
        getAllItems: () => allItems,
        setAllItems: (value) => {
          allItems = value;
        },
        getHistoryItems: () => historyItems,
        setHistoryItems: (value) => {
          historyItems = value;
        },
        getWatchlistItems: () => watchlistItems,
        setWatchlistItems: (value) => {
          watchlistItems = value;
        },
        getHelperOk,
        setHelperOk,
        getPlaylistInfo: () => playlistInfo,
        setPlaylistInfo: (value) => {
          playlistInfo = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        setCurrentTabUrl: (value) => {
          currentTabUrl = value;
        },
        getLibFilter: () => libFilter,
        setLibFilter: (value) => {
          libFilter = value;
        },
        getCurrentTabId: () => currentTabId,
        setCurrentTabId: (value) => {
          currentTabId = value;
        }
      });

      // One-shot autofill when clipboard watch is OFF (legacy convenience)
      autofillOnce();

      UVDPopupRuntimeEvents.bind({
        chrome,
        $,
        pageKey,
        isKnownCodeSite: Naming.isKnownCodeSite,
        ensureSiteItems,
        render,
        patchMedia,
        loadMedia,
        refreshHelperStatus,
        applyJobProgress,
        updateQuickPageUi,
        loadRecentStrip,
        runningJobCount,
        renderHistory,
        updateRetryFailedButton,
        renderWatchlist,
        getCurrentTabId: () => currentTabId,
        setCurrentTabId: (value) => {
          currentTabId = value;
        },
        getCurrentTabUrl: () => currentTabUrl,
        setCurrentTabUrl: (value) => {
          currentTabUrl = value;
        },
        getAllItems: () => allItems,
        setAllItems: (value) => {
          allItems = value;
        },
        getHistoryItems: () => historyItems,
        setHistoryItems: (value) => {
          historyItems = value;
        },
        getWatchlistItems: () => watchlistItems,
        setWatchlistItems: (value) => {
          watchlistItems = value;
        },
        getActiveTabName: () => activeTabName,
        setActiveTabName: (value) => {
          activeTabName = value;
        },
        getTrackedJobIds: () => trackedJobIds,
        setTrackedJobIds: (value) => {
          trackedJobIds = value;
        },
        getAvailableQualities,
        loadAvailableQualities,
        setTimeout,
        clearTimeout
      });

      // Restore settings + in-flight downloads, then load page media
      (async () => {
        await loadSettings();
        setupClipboardWatch();
        await restoreActiveDownloads();
        await loadMedia();
        updateLinkCount();
        await loadRecentStrip();
      })();
    }

    return { start };
  }
);
