"use strict";

const assert = require("node:assert/strict");
const Sites = require("../src/site-detection.js");
const { createRunner } = require("../src/background-site-helper.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};
const deepEqual = (...args) => {
  assertions += 1;
  assert.deepEqual(...args);
};
const rejects = async (...args) => {
  assertions += 1;
  await assert.rejects(...args);
};

function baseDeps(overrides = {}) {
  return {
    chrome: {
      cookies: { getAll: async () => [] },
      tabs: { sendMessage: async () => ({ urls: [] }) }
    },
    UVD: {
      getSettings: async () => ({
        mediaMode: "video",
        saveThumbnail: true,
        codecPref: "best",
        downloadSpeed: "fast",
        subfolder: "VideoDownloader"
      }),
      isPlaylistOnlyUrl: () => false,
      isPlaylistUrl: () => false
    },
    YtDlp: {
      available: async () => true,
      downloadAndWait: async () => ({})
    },
    URL,
    Blob,
    Uint8Array,
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
    setTimeout: (fn) => fn(),
    now: () => 123,
    console: { warn() {} },
    isTiktokCdnUrl: Sites.isTiktokCdnUrl,
    isTiktokUrl: Sites.isTiktokUrl,
    isInstagramUrl: Sites.isInstagramUrl,
    isInstagramCdnUrl: Sites.isInstagramCdnUrl,
    looksLikeVideoFileUrl: (url) => /\.mp4(?:[?#]|$)/i.test(url),
    siteKind: Sites.siteKind,
    sniffIsVideo: () => true,
    withTimeout: (promise) => promise,
    safeDownloadName: (name) => name,
    ytdlpFilenameHint: (name) => name,
    getCurrentJobContext: () => null,
    getActiveDownload: () => null,
    getTabItems: () => [],
    ensureContentScripts: async () => {},
    withTabReferer: (_tabId, operation) => operation(),
    downloadBlob: async (_blob, filename) => ({ filename, size: 100_001 }),
    throwIfJobStopped: () => {},
    emitDownloadProgress: () => {},
    ...overrides
  };
}

async function main() {
  let constructionCalls = 0;
  const lazyRunner = createRunner(baseDeps({
    ensureContentScripts: async () => {
      constructionCalls += 1;
    },
    getCurrentJobContext: () => {
      constructionCalls += 1;
      return null;
    }
  }));
  equal(constructionCalls, 0, "construction is side-effect free");
  equal(typeof lazyRunner.download, "function");
  equal(lazyRunner.download, lazyRunner.downloadViaYtDlp);
  equal(lazyRunner.getCookieHeader, lazyRunner.getCookieHeaderForUrl);
  equal(lazyRunner.collectCookies, lazyRunner.collectCookiesForUrl);
  equal(lazyRunner.downloadDirect, lazyRunner.downloadDirectMediaUrl);

  const cookieQueries = [];
  const original = {
    name: "sid",
    value: "domain",
    domain: ".tiktok.com",
    path: "/",
    secure: true,
    httpOnly: true,
    expirationDate: 99
  };
  const cookieRunner = createRunner(baseDeps({
    chrome: {
      cookies: {
        getAll: async (query) => {
          cookieQueries.push(query);
          if (query.domain === "tiktok.com") {
            return [
              original,
              { name: "", value: "ignored", domain: ".tiktok.com", path: "/" },
              { ...original, name: "theme", value: "dark", path: "/video" }
            ];
          }
          if (query.url) return [{ ...original, value: "url-wins" }];
          return [];
        }
      },
      tabs: { sendMessage: async () => ({ urls: [] }) }
    }
  }));
  const cookies = await cookieRunner.collectCookiesForUrl(
    "https://www.tiktok.com/@user/video/1"
  );
  const queriedDomains = cookieQueries.filter((q) => q.domain).map((q) => q.domain);
  deepEqual(
    queriedDomains,
    [
      "www.tiktok.com",
      "tiktok.com",
      ".tiktok.com",
      "m.tiktok.com",
      "www.tiktokv.com",
      ".tiktokv.com"
    ],
    "all TikTok cookie domains are queried in insertion order"
  );
  deepEqual(cookies, [
    {
      name: "sid",
      value: "url-wins",
      domain: ".tiktok.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: 99
    },
    {
      name: "theme",
      value: "dark",
      domain: ".tiktok.com",
      path: "/video",
      secure: true,
      httpOnly: true,
      expirationDate: 99
    }
  ]);
  equal(await cookieRunner.getCookieHeaderForUrl("https://www.tiktok.com/video/1"),
    "sid=url-wins; theme=dark");
  equal((await cookieRunner.collectCookiesForUrl("not a url")).length, 0);

  equal(
    lazyRunner.normalizeInstagramUrl(
      "https://instagr.am/reels/ABC123?igsh=tracking#fragment"
    ),
    "https://www.instagram.com/reel/ABC123/"
  );
  equal(
    lazyRunner.normalizeInstagramUrl(" https://instagram.com/p/POST "),
    "https://instagram.com/p/POST/"
  );
  equal(lazyRunner.normalizeInstagramUrl("not a url "), "not a url");

  let ensureCalls = 0;
  const mediaRunner = createRunner(baseDeps({
    chrome: {
      cookies: { getAll: async () => [] },
      tabs: {
        sendMessage: async () => ({
          urls: [
            "https://v16m.tiktokcdn.com/video.mp4?one=1",
            "https://v16m.tiktokcdn.com/video.mp4?two=2",
            "https://www.tiktok.com/@user/video/123",
            "https://other.example/video/tos/valid.mp4",
            "javascript:alert(1)"
          ]
        })
      }
    },
    ensureContentScripts: async () => {
      ensureCalls += 1;
    },
    isTiktokCdnUrl: (url) => /tiktokcdn\.com/.test(url),
    getTabItems: () => [
      { url: "https://other.example/file.jpg" },
      { url: "https://other.example/path?mime_type=video" }
    ]
  }));
  deepEqual(await mediaRunner.collectTikTokMediaUrls(7, "https://tiktok.com/video/1"), [
    "https://v16m.tiktokcdn.com/video.mp4?one=1",
    "https://other.example/video/tos/valid.mp4",
    "https://other.example/path?mime_type=video"
  ]);
  equal(ensureCalls, 1);
  await rejects(
    () => mediaRunner.downloadDirectMediaUrl(7, "https://example.test/image.jpg"),
    /영상 파일이 아닌 주소입니다/
  );
  await rejects(
    () => createRunner(baseDeps({
      fetch: async () => ({
        ok: true,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new ArrayBuffer(100_001)
      }),
      withTabReferer: (_tabId, operation) => operation()
    })).downloadDirectMediaUrl(7, "https://example.test/video.mp4"),
    /영상이 아닌 응답 \(image\/jpeg\)/
  );
  await rejects(
    () => createRunner(baseDeps({
      fetch: async () => ({
        ok: true,
        headers: { get: () => "video/mp4" },
        arrayBuffer: async () => new ArrayBuffer(99_999)
      })
    })).downloadDirectMediaUrl(7, "https://example.test/video.mp4"),
    /파일이 너무 작음/
  );
  await rejects(
    () => createRunner(baseDeps({
      fetch: async () => ({
        ok: true,
        headers: { get: () => "video/mp4" },
        arrayBuffer: async () => new ArrayBuffer(100_001)
      }),
      sniffIsVideo: () => false
    })).downloadDirectMediaUrl(7, "https://example.test/video.mp4"),
    /영상 바이너리가 아닙니다/
  );

  const progress = [];
  const job = {};
  let helperPayload;
  let helperTimeout;
  const downloadRunner = createRunner(baseDeps({
    chrome: {
      cookies: {
        getAll: async ({ domain, url }) => {
          if (domain === "x.com" || url) {
            return [{ name: "auth", value: "yes", domain: ".x.com", path: "/" }];
          }
          return [];
        }
      },
      tabs: { sendMessage: async () => ({ urls: [] }) }
    },
    UVD: {
      getSettings: async () => ({
        mediaMode: "video_subs",
        saveThumbnail: true,
        codecPref: "h264",
        downloadSpeed: "fast",
        subfolder: "Social"
      }),
      isPlaylistOnlyUrl: () => true,
      isPlaylistUrl: () => false
    },
    YtDlp: {
      available: async () => true,
      downloadAndWait: async (payload, onProgress, timeout) => {
        helperPayload = payload;
        helperTimeout = timeout;
        onProgress({ percent: 120, message: "Merging formats", helperJobId: "helper-1" });
        onProgress({ percent: -4, message: "[download] bytes", status: "download" });
        return { path: "/tmp/video.mp4", filename: "final.mp4", size: 42 };
      }
    },
    getActiveDownload: (id) => id === "job-1" ? job : null,
    emitDownloadProgress: (...args) => progress.push(args)
  }));
  const result = await downloadRunner.downloadViaYtDlp(
    9,
    "https://x.com/user/status/1",
    "https://x.com/user/status/1",
    "Readable.mp4",
    "1080p",
    "job-1",
    {
      mediaMode: "video_subs",
      audioTrackId: "251",
      subtitleLanguages: ["ko", "ja"]
    }
  );
  equal(helperTimeout, 40 * 60 * 1000);
  equal(helperPayload.site, "x");
  equal(helperPayload.cookieHeader, "auth=yes");
  equal(helperPayload.cookiesList.length, 1);
  equal(helperPayload.filename, "Readable.mp4");
  equal(helperPayload.quality, "1080p");
  equal(helperPayload.writeSubs, true);
  equal(helperPayload.audioTrackId, "251");
  deepEqual(helperPayload.subtitleLanguages, ["ko", "ja"]);
  equal(helperPayload.yesPlaylist, true);
  equal(job.helperJobId, "helper-1");
  deepEqual(progress.at(-3).slice(1, 4), [98, "파일 합치는 중… (시간이 걸릴 수 있어요)", "download"]);
  deepEqual(progress.at(-2).slice(1, 4), [2, "받는 중… -4%", "download"]);
  deepEqual(progress.at(-1).slice(1, 4), [100, "저장 완료", "done"]);
  deepEqual(result, {
    ok: true,
    method: "yt-dlp",
    downloadId: null,
    ytdlp: true,
    path: "/tmp/video.mp4",
    outDir: "",
    filename: "final.mp4",
    size: 42
  });

  console.log(`background_site_helper_unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
