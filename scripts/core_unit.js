"use strict";

const assert = require("node:assert/strict");
const UVD = require("../src/uvd-common.js");
const Naming = require("../src/naming.js");
const HLS = require("../src/hls-downloader.js");
const Quality = require("../src/media-quality.js");
const Sites = require("../src/site-detection.js");
const Progress = require("../src/progress-protocol.js");
const QueueState = require("../src/download-queue-state.js");
const HistoryModel = require("../src/history-model.js");
const DownloadRouting = require("../src/download-routing.js");
const DownloadEngine = require("../src/download-engine.js");
const PopupMedia = require("../src/popup-media.js");
const PopupQueueUI = require("../src/popup-queue-ui.js");
const PopupSeriesUI = require("../src/popup-series-ui.js");
const QualityMessages = require("../src/background-quality-messages.js");
const LibraryUI = require("../src/popup-library-ui.js");
const WatchlistUI = require("../src/popup-watchlist-ui.js");
const DownloadExecution = require("../src/background-download-execution.js");
const RecoveryUI = require("../src/popup-recovery-ui.js");
const PlaylistUI = require("../src/popup-playlist-ui.js");
const SavePipeline = require("../src/background-save-pipeline.js");
const MediaRenderer = require("../src/popup-media-renderer.js");
const SeriesBannerUI = require("../src/popup-series-banner-ui.js");
const HlsRuntime = require("../src/background-hls-runtime.js");
const DirectMedia = require("../src/background-direct-media.js");
const MediaLoader = require("../src/popup-media-loader.js");
const SeriesDiscovery = require("../src/popup-series-discovery.js");
const PopupSeriesNetwork = require("../src/popup-series-network.js");
const PopupDownloadRequests = require("../src/popup-download-requests.js");

const series = UVD.extractSeriesInfo("SSIS-001 테스트 제목");
assert.deepEqual(
  { prefix: series?.prefix, num: series?.num, key: series?.key },
  { prefix: "SSIS", num: 1, key: "SSIS-001" }
);
assert.equal(UVD.extractSeriesInfo("Hello world"), null);
assert.equal(UVD.classifyError("Segment HTTP 403").code, "forbidden");
assert.equal(Naming.extractProductCode("https://example.com/ssis-001"), "SSIS-001");

const heights = [
  ["https://cdn.example/uuid/720p/video.m3u8", 720],
  ["https://cdn.example/uuid/720/seg0.ts", 720],
  ["https://x.com/a/1080p.m3u8", 1080],
  ["https://x.com/video_1080.m3u8", 1080],
  ["720", 720],
  ["https://surrit.com/abc/playlist.m3u8", 0]
];
for (const [value, expected] of heights) {
  assert.equal(HLS.heightFromString(value), expected, value);
}
const hlsMaster = HLS.parsePlaylist(
  [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="dub"',
    "video/720.m3u8"
  ].join("\n"),
  "https://media.example/master.m3u8"
);
assert.equal(hlsMaster.audioRenditions.length, 1);
assert.equal(hlsMaster.audioRenditions[0].url, "https://media.example/audio/en.m3u8");
assert.equal(hlsMaster.variants[0].audioGroup, "dub");
const liveMedia = HLS.parsePlaylist(
  "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:6,\nsegment.ts",
  "https://media.example/live.m3u8"
);
assert.equal(liveMedia.isLive, true);
assert.equal(liveMedia.segments[0].sequence, 42);
assert.equal(
  HLS.segmentIdentity(liveMedia.segments[0]),
  "42:https://media.example/segment.ts"
);

// Chip ↔ download contract: the label the popup derives (bandwidth fallback
// when RESOLUTION is absent) must select that same variant.
const bandwidthOnly = HLS.parsePlaylist(
  [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=6000000",
    "a.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2500000",
    "b.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=800000",
    "c.m3u8"
  ].join("\n"),
  "https://media.example/master.m3u8"
);
// estimate = 55% of peak → 1080p / 720p / 360p, the labels the popup shows
assert.equal(HLS.pickVariant(bandwidthOnly.variants, "360p").url, "https://media.example/c.m3u8");
assert.equal(HLS.pickVariant(bandwidthOnly.variants, "720p").url, "https://media.example/b.m3u8");
assert.equal(HLS.pickVariant(bandwidthOnly.variants, "1080p").url, "https://media.example/a.m3u8");
assert.equal(HLS.pickVariant(bandwidthOnly.variants, "best").url, "https://media.example/a.m3u8");
// "best" is decided by resolution; codec taste only breaks ties at equal height.
const codecMix = HLS.parsePlaylist(
  [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="hev1.2.4.L153"',
    "uhd.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f"',
    "hd.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="vp09.00.31.08"',
    "hd-vp9.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=256x144",
    "tiny.m3u8"
  ].join("\n"),
  "https://media.example/master.m3u8"
);
assert.equal(HLS.pickVariant(codecMix.variants, "best").url, "https://media.example/uhd.m3u8");
assert.equal(HLS.pickVariant(codecMix.variants, "720p").url, "https://media.example/hd.m3u8");
assert.equal(HLS.pickVariant(codecMix.variants, "144p").url, "https://media.example/tiny.m3u8");

const single = Quality.ensureQualityChoices([
  { id: "best", label: "최고" },
  { id: "720p", label: "720p", height: 720 }
]);
assert.equal(single.length, 1);
assert.equal(single[0].id, "720p");
assert.equal(
  Quality.ensureQualityChoices([{ id: "best", label: "최고", height: 1080 }])[0].id,
  "1080p"
);
assert.ok(
  Quality.ensureQualityChoices([
    { id: "best", label: "최고" },
    { id: "1080p", height: 1080 },
    { id: "720p", height: 720 }
  ]).length >= 2
);

assert.equal(Sites.siteKind("https://youtu.be/abc", ""), "youtube");
assert.equal(Sites.isInstagramPostUrl("https://instagram.com/reel/abc_123/"), true);
assert.equal(Sites.isInstagramPostUrl("https://instagram.com/example-user/"), false);
assert.equal(Sites.isTiktokCdnUrl("https://cdn.example/image.jpg"), false);

const current = {
  id: "job",
  status: "running",
  progressVersion: Progress.VERSION,
  progressAttempt: 1,
  progressSeq: 4,
  percent: 50
};
assert.equal(QueueState.shouldAccept(current, { ...current, progressSeq: 3 }), false);
assert.equal(
  QueueState.percentFor(current, { ...current, progressSeq: 5, percent: 45 }),
  50
);
assert.equal(
  QueueState.percentFor(current, {
    ...current,
    progressAttempt: 2,
    progressSeq: 5,
    percent: 4
  }),
  4
);

const historyItem = HistoryModel.buildItem(
  {
    id: "history-1",
    title: "SSIS-001 테스트",
    pageUrl: "https://example.com/watch/1",
    status: "done"
  },
  {
    siteFromUrl: () => "example",
    extractSeriesInfo: UVD.extractSeriesInfo,
    autoTags: UVD.autoTags,
    classifyError: UVD.classifyError
  },
  1234
);
assert.equal(historyItem.seriesKey, "SSIS-001");
assert.equal(historyItem.at, 1234);
assert.deepEqual(
  HistoryModel.prepend([historyItem], { ...historyItem, title: "수정" }, 10).map(
    (item) => item.title
  ),
  ["수정"]
);
assert.equal(
  DownloadRouting.shouldUseHelper({
    url: "https://youtube.com/watch?v=abc",
    pageUrl: "",
    item: {}
  }),
  true
);
assert.deepEqual(DownloadRouting.hlsAttemptOrder(true), ["page", "worker"]);
assert.deepEqual(DownloadRouting.hlsAttemptOrder(false), ["worker", "page"]);

assert.equal(DownloadEngine.classifyMedia("https://cdn.example/video.m3u8").type, "stream");
assert.equal(DownloadEngine.hlsPhasePercent({ phase: "segments", current: 5, total: 10 }), 42);
assert.equal(DownloadEngine.hlsPhasePercent({ phase: "done" }), 100);
assert.equal(DownloadEngine.parseSpeedFromMessage("받는 중 1.5MiB/s"), 1.5 * 1024 * 1024);
assert.equal(DownloadEngine.safeDownloadName("title.mp4.mp4"), "title.mp4");
assert.equal(DownloadEngine.safeDownloadName("clip.ts"), "clip.mp4");
assert.equal(DownloadEngine.safeDownloadName("CON.mp4"), "CON_.mp4");
assert.equal(DownloadEngine.safeDownloadName("nul"), "nul_.mp4");
assert.equal(DownloadEngine.safeDownloadName("com1.webm"), "com1_.webm");
assert.equal(DownloadEngine.safeDownloadName("Console log.mp4"), "Console log.mp4");
assert.equal(
  DownloadEngine.safeDownloadName("poster.jpeg", "image/jpeg"),
  "poster.jpg"
);
assert.equal(
  DownloadEngine.safeDownloadName("poster.jpg.jpeg", "image/jpeg"),
  "poster.jpg"
);
assert.equal(
  DownloadEngine.safeDownloadName("poster.jpg", "image/png"),
  "poster.png"
);
assert.equal(
  DownloadEngine.safeDownloadName("poster.jpg", "image/webp"),
  "poster.webp"
);
assert.equal(
  DownloadEngine.safeDownloadName("poster", "image/webp; charset=binary"),
  "poster.webp"
);
assert.equal(
  Naming.buildFilename({
    title: "Readable page title",
    url: "https://cdn.example/media/source.webm"
  }),
  "Readable page title.webm"
);
assert.equal(
  Naming.buildFilename({
    title: "Readable page title",
    url: "https://cdn.example/media/master.m3u8"
  }),
  "Readable page title.mp4"
);
assert.equal(PopupMedia.formatDuration(65), "1:05");
assert.equal(PopupMedia.isHlsItem({ url: "https://cdn.example/master.m3u8" }), true);
assert.equal(
  PopupMedia.displayName(
    { title: "테스트 영상", pageUrl: "https://example.com/watch/1" },
    { Naming }
  ),
  "테스트 영상"
);
assert.equal(
  Sites.isDownloadableSiteVideo("https://www.youtube.com/watch?v=abc"),
  true
);
assert.equal(Sites.isDownloadableSiteVideo("https://www.youtube.com/"), false);
assert.equal(Sites.isDownloadableSiteVideo("https://www.facebook.com/"), false);
const youtubePlaceholder = Sites.buildSiteItem({
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Actual video title - YouTube"
});
assert.equal(youtubePlaceholder.title, "Actual video title");
assert.equal(
  youtubePlaceholder.thumbnail,
  "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
);
assert.equal(youtubePlaceholder.filename, "Actual video title.mp4");

const queuePresenter = PopupQueueUI.createPresenter({
  UVD,
  cleanTitleText: (value) => String(value || ""),
  isUglyName: () => false,
  siteLabel: () => "YouTube",
  now: () => 20_000
});
assert.equal(
  queuePresenter.jobDisplayInfo({
    title: "테스트",
    filename: "테스트.mp4",
    pageUrl: "https://youtube.com/watch?v=abc",
    quality: "1080p"
  }).quality,
  "1080p"
);
assert.equal(queuePresenter.jobPhaseLabel({ status: "paused" }), "일시정지");
assert.equal(queuePresenter.cleanJobMessage("[download] 10% ETA 00:10", "download"), "받는 중…");

assert.equal(PopupSeriesUI.isYouTubeVideoId("dQw4w9WgXcQ"), true);
assert.equal(PopupSeriesUI.isYouTubeVideoId("SSIS-001"), false);
assert.equal(
  PopupSeriesUI.youtubeVideoIdFromItem({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }),
  "dQw4w9WgXcQ"
);
assert.equal(
  PopupSeriesUI.normalizePlaylistEntry({ id: "dQw4w9WgXcQ" }).thumbnail,
  "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
);
assert.equal(PopupSeriesUI.rangeLimit("all"), 999);
assert.equal(
  PopupSeriesUI.buildVisibleItems(
    {
      allItems: [{ id: "one" }, { id: "two", downloaded: true }],
      items: [],
      rangePref: "5",
      missingOnly: true
    },
    [],
    (items) => items
  ).items.length,
  1
);
assert.equal(QualityMessages.heightFromBandwidth(2_500_000), 1080);
assert.equal(
  QualityMessages.heightFromString("https://cdn.example/720p/index.m3u8"),
  720
);
assert.ok(
  QualityMessages.playlistCandidates("https://cdn.example/720p/video.m3u8")
    .some((url) => url.endsWith("master.m3u8"))
);
assert.deepEqual(
  LibraryUI.filterValues([
    { site: "youtube", seriesPrefix: "EP" },
    { site: "tiktok", seriesKey: "SSIS-001" }
  ]),
  { sites: ["tiktok", "youtube"], series: ["EP", "SSIS"] }
);
assert.ok(
  LibraryUI.renderHistory([], {
    UVD,
    formatTimeAgo: () => "방금",
    escapeHtml: String,
    escapeAttr: String
  }).includes("검색 결과가 없어요")
);
assert.equal(
  WatchlistUI.groupKey({ seriesId: "series:code:EP" }, UVD),
  "series:code:EP"
);
assert.deepEqual(
  WatchlistUI.computeSchedule("1h", 1000),
  { scheduleAt: 3_601_000, scheduleLabel: "1시간 후" }
);
assert.equal(
  DownloadExecution.sameVideoPage(
    "https://www.example.com/watch?v=1",
    "https://example.com/watch?v=2"
  ),
  true
);
assert.equal(
  DownloadExecution.sameVideoPage(
    "https://example.com/watch",
    "https://example.com/other"
  ),
  false
);
assert.ok(
  RecoveryUI.recoveryActionsHtml(
    { actions: ["retry", "helper"] },
    "https://example.com/video",
    null,
    String
  ).includes('data-act="retry"')
);
assert.equal(
  RecoveryUI.resolveRealJobId(
    "local_1",
    new Map([
      ["local_1", { title: "Video" }],
      ["job_1", { title: "Video", status: "running" }]
    ])
  ),
  "job_1"
);
assert.equal(typeof PlaylistUI.createController, "function");
const savePipeline = SavePipeline.createPipeline({
  chrome: {},
  indexedDB: null,
  IDBKeyRange: null,
  safeDownloadName: String,
  relDownloadPath: async (name) => name,
  startKeepAlive: () => true,
  stopKeepAlive: () => {}
});
assert.equal(savePipeline.IDB_NAME, "uvd-blobs");
assert.equal(savePipeline.IDB_STORE, "blobs");
assert.equal(savePipeline.idbPartKey("hls_job", 12), "hls_job:p:000012");
assert.equal(typeof MediaRenderer.createRenderer({}).render, "function");
assert.equal(typeof SeriesBannerUI.createController({}).showSeriesBanner, "function");
assert.equal(typeof HlsRuntime.createRunner({}).runHlsDownload, "function");
assert.equal(typeof DirectMedia.createTransport({}).withTabReferer, "function");
assert.equal(typeof MediaLoader.createLoader({}).loadMedia, "function");
const discovery = SeriesDiscovery.createDiscovery({
  UVD,
  UVDPopupSeriesUI: PopupSeriesUI,
  UVDPopupSeriesNetwork: PopupSeriesNetwork,
  sendMessage: async () => ({}),
  getAllItems: () => [],
  getHistoryItems: () => [],
  getCurrentTabUrl: () => "",
  getCurrentTabId: () => -1
});
assert.equal(typeof discovery.offerSeriesComplete, "function");
assert.ok(discovery.seriesProbeErrorHint("HTTP 403").includes("차단"));

const downloadRequests = PopupDownloadRequests.createController({
  UVD,
  isYoutubeUrl: Sites.isYoutubeUrl,
  isTiktokUrl: Sites.isTiktokUrl,
  isInstagramUrl: Sites.isInstagramUrl,
  isXUrl: Sites.isXUrl,
  isFacebookUrl: Sites.isFacebookUrl,
  isBilibiliUrl: Sites.isBilibiliUrl
});
assert.equal(
  downloadRequests.normalizePastedUrl("youtube.com/watch?v=abc"),
  "https://youtube.com/watch?v=abc"
);
assert.equal(
  downloadRequests.normalizePastedUrl(" https://example.com/video "),
  "https://example.com/video"
);
assert.equal(downloadRequests.normalizePastedUrl("ftp://example.com/video"), "");
assert.equal(downloadRequests.normalizePastedUrl("not a url"), "");
assert.equal(downloadRequests.looksLikeDirectMedia("https://cdn.example/video.mp4?x=1"), true);
assert.equal(downloadRequests.looksLikeDirectMedia("https://cdn.example/a?mime_type=video"), true);
assert.equal(downloadRequests.looksLikeDirectMedia("https://cdn.example/videoplayback?id=1"), true);
assert.equal(downloadRequests.looksLikeDirectMedia("https://cdn.example/poster.jpg"), false);
assert.equal(
  downloadRequests.fnameBaseFromLink("https://youtube.com/watch?v=dQw4w9WgXcQ"),
  "YouTube_dQw4w9WgXcQ"
);
assert.equal(
  downloadRequests.fnameBaseFromLink("https://tiktok.com/@name/video/123456789"),
  "TikTok_123456789"
);
assert.equal(
  downloadRequests.fnameBaseFromLink("https://instagram.com/reel/ABC_123/"),
  "Instagram_ABC_123"
);
assert.equal(
  downloadRequests.fnameBaseFromLink("https://x.com/name/status/987654321"),
  "X_987654321"
);

console.log("core modules: 98 assertions passed");
