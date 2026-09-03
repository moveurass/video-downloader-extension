"use strict";

const assert = require("node:assert/strict");
const BaseUVD = require("../src/uvd-common.js");
const Naming = require("../src/naming.js");
const UVDDownloadEngine = require("../src/download-engine.js");
const { createManager } = require("../src/background-filename.js");

let assertions = 0;
const equal = (...args) => {
  assertions += 1;
  assert.equal(...args);
};

async function main() {
  let settingsCalls = 0;
  const UVD = {
    ...BaseUVD,
    async getSettings() {
      settingsCalls += 1;
      return {
        ...BaseUVD.DEFAULT_SETTINGS,
        subfolder: "Chosen/Subfolder",
        mediaMode: "video"
      };
    }
  };
  const manager = createManager({ UVD, Naming, UVDDownloadEngine });

  // Construction must not read settings or mutate external state.
  equal(settingsCalls, 0);

  // A real page/video title always wins over URL codes and old filename hints.
  equal(
    manager.lockSaveName({
      filenameHint: "ABP-123 Old video.mp4",
      title: "ABP-123 Old video",
      pageUrl: "https://example.test/watch/ssis-001",
      quality: "1080p"
    }),
    "ABP-123 Old video_1080p.mp4"
  );
  equal(
    manager.lockSaveName({
      filenameHint: "SSIS-001 Real title.mp4",
      title: "SSIS-001 Real title",
      pageUrl: "https://example.test/watch/ssis-001"
    }),
    "SSIS-001 Real title.mp4"
  );
  equal(manager.titlesMatchVideo("SSIS-001 first title", "SSIS-001 other title"), true);
  equal(manager.titlesMatchVideo("SSIS-001 title", "ABP-123 title"), false);
  equal(manager.titlesMatchVideo("Same title_720p", "Same title 1080p"), true);

  equal(
    await manager.buildSaveFilename({
      title: "Episode title",
      playlistTitle: "My Playlist",
      seriesIndex: 3,
      seriesTotal: 12,
      quality: "720p"
    }),
    "My Playlist 03. Episode title_720p.mp4"
  );
  equal(
    manager.lockSaveName({
      title: "Episode title",
      seriesKey: "SSIS-003",
      playlistTitle: "My Playlist",
      seriesIndex: 3,
      seriesTotal: 12,
      quality: "720p"
    }),
    "My Playlist 03. Episode title_720p.mp4"
  );
  equal(
    manager.lockSaveName({
      filenameHint: "host_784923.mp4",
      title: "Actual page title",
      pageUrl: "https://ordinary.test/watch/abc-123",
      mediaUrl: "https://cdn.test/9f8e7d6c5b4a3210.webm"
    }),
    "Actual page title.webm"
  );
  equal(
    manager.lockSaveName({
      filenameHint: "SSIS-001.mp4",
      title: "Human title without a code",
      pageUrl: "https://123av.com/watch/ssis-001"
    }),
    "Human title without a code.mp4"
  );
  equal(
    manager.lockSaveName({
      title: "Episode title",
      playlistTitle: "My Playlist",
      seriesIndex: 3,
      mediaUrl: "https://cdn.test/episode.webm"
    }),
    "My Playlist 03. Episode title.webm"
  );

  equal(
    manager.applyQualityToLockedName(
      "SSIS-001 Real title_720p.mp4",
      "1080p"
    ),
    "SSIS-001 Real title_1080p.mp4"
  );
  equal(
    manager.applyQualityToLockedName("Track.mp3", "best", "audio"),
    "Track.mp3"
  );
  equal(manager.applyQualityToLockedName("", "1080p"), "");

  equal(manager.ytdlpFilenameHint("video.mp4"), undefined);
  equal(manager.ytdlpFilenameHint("dQw4w9WgXcQ.mp4"), undefined);
  equal(manager.ytdlpFilenameHint("host_12891.mp4"), undefined);
  equal(manager.ytdlpFilenameHint("9f8e7d6c5b4a3210.mp4"), undefined);
  equal(
    manager.ytdlpFilenameHint("video.mp4", "A human title"),
    "A human title.mp4"
  );
  equal(
    manager.ytdlpFilenameHint("Old URL basename.mp4", "Actual extractor title"),
    "Actual extractor title.mp4"
  );
  equal(
    manager.filenameFromUrl("https://example.test/media/My%20Clip.webm"),
    "My Clip.webm"
  );
  equal(
    manager.filenameFromUrl("https://example.test/media/master.m3u8"),
    "example video.mp4"
  );
  equal(
    manager.lockSaveName({
      title: "Readable direct title",
      pageUrl: "https://example.test/watch/1",
      mediaUrl: "https://cdn.test/files/opaque.webm"
    }),
    "Readable direct title.webm"
  );
  equal(
    manager.applyQualityToLockedName("Readable title.webm", "720p"),
    "Readable title_720p.webm"
  );

  equal(
    await manager.relDownloadPath("Readable title.mp4"),
    "Chosen/Subfolder/Readable title.mp4"
  );
  equal(
    await manager.buildSaveFilename({ title: "Song title", mediaMode: "audio" }),
    "Song title.mp3"
  );
  equal(settingsCalls, 3);

  // Generic-site titles must stay readable: "<word> <number>" is not a
  // product code, and a code-looking path segment on an ordinary host does
  // not replace a real title.
  for (const [title, expected] of [
    ["Top 10 goals of 2024", "Top 10 goals of 2024"],
    ["iPhone 15 review", "iPhone 15 review"],
    ["Episode 12 The Return", "Episode 12 The Return"],
    ["The 100 best songs", "The 100 best songs"],
    ["[ssis-001] title", "SSIS-001 title"],
    ["ssis_001 x", "SSIS-001 x"],
    ["SSIS 001 title", "SSIS-001 title"],
    ["MIDV123 abc", "MIDV-123 abc"]
  ]) {
    equal(Naming.cleanPageTitle(title), expected);
  }
  equal(
    Naming.bindTitleToPage("https://site.test/episode-12/", "Top 10 goals of 2024"),
    "Top 10 goals of 2024"
  );
  equal(
    Naming.bindTitleToPage("https://site.test/blog/page-10", "Windows 11 tips"),
    "Windows 11 tips"
  );
  equal(
    Naming.bindTitleToPage("https://site.test/abcd-123/", "Some show"),
    "Some show",
    "unknown host: URL code needs the title to confirm it"
  );
  equal(Naming.bindTitleToPage("https://site.test/abcd-123/", ""), "");
  equal(
    Naming.bindTitleToPage("https://123av.com/ja/v/snos-309", "대규모 정전"),
    "대규모 정전",
    "known code site: a usable title remains authoritative"
  );
  equal(
    Naming.bindTitleToPage("https://example.test/watch/ssis-001", "ABP-123 Old video"),
    "ABP-123 Old video",
    "a real title is never replaced by a URL code"
  );
  equal(
    Naming.bindTitleToPage("https://123av.com/ja/v/snos-309", ""),
    "SNOS-309",
    "known code site may use its code only when no title exists"
  );
  equal(Naming.extractProductCode("https://example.com/watch/ep-05"), "");
  equal(Naming.extractProductCode("https://example.com/ssis-001"), "SSIS-001");
  equal(
    manager.lockSaveName({
      title: "Top 10 goals of 2024",
      pageUrl: "https://videos.example/episode-12/",
      quality: "1080p"
    }),
    "Top 10 goals of 2024_1080p.mp4"
  );

  console.log(`background_filename_unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
