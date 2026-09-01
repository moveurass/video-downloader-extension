"use strict";

const assert = require("node:assert/strict");
const { createSaver } = require("../src/background-companion-thumbnail.js");

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
    safeDownloadName: (name) => `safe-${name}`,
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
  const direct = makeHarness();
  await direct.saveCompanionThumbnail(
    {
      thumbnail: "https://cdn.test/job.jpg",
      filename: "movie.mp4",
      pageUrl: "https://example.test/watch"
    },
    { filename: "result.mp4" }
  );
  assert.deepEqual(direct.downloads, [{
    url: "https://cdn.test/job.jpg",
    filename: "VideoDownloader/safe-result.jpg"
  }]);
  assert.equal(direct.fetches.length, 0);

  const fallback = makeHarness({ directFails: true });
  await fallback.saveCompanionThumbnail(
    { tabId: 9, filename: "video.mp4", title: "A: title", pageUrl: "https://page.test" },
    {}
  );
  assert.equal(fallback.fetches.length, 1);
  assert.deepEqual(fallback.fetches[0].init.headers, {
    Referer: "https://page.test"
  });
  assert.match(fallback.downloads[1].url, /^data:image\/webp;base64,/);
  assert.equal(
    fallback.downloads[1].filename,
    "VideoDownloader/safe-A title.jpg"
  );
  assert.equal(fallback.warnings.length, 0);

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

  const tiny = makeHarness({ directFails: true, blobSize: 100 });
  await tiny.saveCompanionThumbnail(
    { thumbnail: "https://cdn.test/job.jpg", filename: "movie.mp4" },
    {}
  );
  assert.equal(tiny.downloads.length, 1);

  console.log("background companion thumbnail: direct and fallback saves passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
