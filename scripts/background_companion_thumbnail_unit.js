"use strict";

const assert = require("node:assert/strict");
const { createSaver } = require("../src/background-companion-thumbnail.js");
const DownloadEngine = require("../src/download-engine.js");

function makeHarness(options = {}) {
  const downloads = [];
  const fetches = [];
  const warnings = [];
  const saver = createSaver({
    UVD: {
      getSettings: async () => ({
        saveThumbnail: options.saveThumbnail,
        mediaMode: options.settingsMode || "video"
      }),
      isGenericSaveName: (name) => !name || name === "video"
    },
    Uint8Array,
    btoa: (binary) => Buffer.from(binary, "binary").toString("base64"),
    async fetch(url, init) {
      fetches.push({ url, init });
      return {
        ok: options.fetchOk !== false,
        async blob() {
          const bytes = new Uint8Array(options.blobSize ?? 600);
          return {
            size: bytes.length,
            type: options.blobType || "image/webp",
            arrayBuffer: async () => bytes.buffer
          };
        }
      };
    },
    safeDownloadName: DownloadEngine.safeDownloadName,
    relDownloadPath: async (name) => `VideoDownloader/${name}`,
    getTabMeta: () => ({ thumbnail: "https://cdn.test/meta.jpg" }),
    async startChromeDownload(url, filename) {
      downloads.push({ url, filename });
      if (options.directFails && downloads.length === 1) {
        throw new Error("direct failed");
      }
    },
    console: {
      warn(...args) {
        warnings.push(args);
      }
    }
  });
  return { ...saver, downloads, fetches, warnings };
}

async function main() {
  const fetched = makeHarness();
  await fetched.saveCompanionThumbnail(
    {
      thumbnail: "https://cdn.test/job.jpg",
      filename: "movie.mp4",
      pageUrl: "https://example.test/watch"
    },
    { filename: "result.mp4" }
  );
  assert.equal(fetched.fetches.length, 1);
  assert.deepEqual(fetched.fetches[0].init.headers, {
    Referer: "https://example.test/watch"
  });
  assert.equal(fetched.downloads.length, 1);
  assert.match(fetched.downloads[0].url, /^data:image\/webp;base64,/);
  assert.equal(fetched.downloads[0].filename, "VideoDownloader/result.webp");

  const protocolRelative = makeHarness();
  await protocolRelative.saveCompanionThumbnail(
    { thumbnail: "//cdn.test/job.jpg", filename: "movie.mp4" },
    { filename: "result.mp4" }
  );
  assert.equal(protocolRelative.fetches[0].url, "https://cdn.test/job.jpg");

  const dataThumb = makeHarness();
  await dataThumb.saveCompanionThumbnail(
    {
      thumbnail: "data:image/jpeg;base64,/9j/4AAQ",
      filename: "movie.mp4"
    },
    { filename: "result.mp4" }
  );
  assert.equal(dataThumb.fetches.length, 0);
  assert.deepEqual(dataThumb.downloads, [{
    url: "data:image/jpeg;base64,/9j/4AAQ",
    filename: "VideoDownloader/result.jpg"
  }]);

  const fallback = makeHarness({ fetchOk: false });
  await fallback.saveCompanionThumbnail(
    { tabId: 9, filename: "video.mp4", title: "A: title", pageUrl: "https://page.test" },
    {}
  );
  assert.equal(fallback.fetches.length, 2);
  assert.deepEqual(fallback.fetches[0].init.headers, {
    Referer: "https://page.test"
  });
  assert.equal(fallback.downloads[0].url, "https://cdn.test/meta.jpg");
  assert.equal(fallback.downloads[0].filename, "VideoDownloader/A title.jpg");

  const disabled = makeHarness({ saveThumbnail: false });
  await disabled.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg" },
    {}
  );
  assert.equal(disabled.downloads.length, 0);

  const audio = makeHarness();
  await audio.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", mediaMode: "audio" },
    {}
  );
  assert.equal(audio.downloads.length, 0);

  const requestedButMissing = makeHarness();
  await requestedButMissing.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", filename: "movie.mp4" },
    {
      ytdlp: true,
      downloadId: null,
      path: "/Downloads/VideoDownloader/movie.mp4",
      writeThumbnail: true
    }
  );
  assert.equal(
    requestedButMissing.downloads.length,
    1,
    "a requested helper thumbnail that never landed still gets a companion save"
  );

  const publishedThumbnail = makeHarness();
  await publishedThumbnail.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", filename: "movie.mp4" },
    {
      downloadId: null,
      path: "/Downloads/VideoDownloader/movie.mp4",
      thumbnailPath: "/Downloads/VideoDownloader/movie.jpg"
    }
  );
  assert.equal(publishedThumbnail.downloads.length, 0);

  const helperWithoutThumbnail = makeHarness();
  await helperWithoutThumbnail.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", filename: "movie.mp4" },
    {
      ytdlp: true,
      downloadId: null,
      path: "/Downloads/VideoDownloader/movie.mp4",
      writeThumbnail: false
    }
  );
  assert.equal(helperWithoutThumbnail.downloads.length, 1);

  const tiny = makeHarness({ blobSize: 100 });
  await tiny.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", filename: "movie.mp4" },
    {}
  );
  assert.equal(tiny.downloads.length, 1);
  assert.equal(tiny.downloads[0].url, "https://cdn.test/job.jpg");

  console.log("background companion thumbnail: fetch, data URL, and helper fallback passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
