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

  // A stale popup title must be rebound to the identity in this job's page URL.
  equal(
    manager.lockSaveName({
      filenameHint: "ABP-123 Old video.mp4",
      title: "ABP-123 Old video",
      pageUrl: "https://example.test/watch/ssis-001",
      quality: "1080p"
    }),
    "SSIS-001 1080p.mp4"
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
      playlistTitle: "My Playlist",
      seriesIndex: 3,
      seriesTotal: 12,
      quality: "720p"
    }),
    "My Playlist 03. Episode title_720p.mp4"
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
  equal(
    manager.ytdlpFilenameHint("video.mp4", "A human title"),
    "A human title.mp4"
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

  console.log(`background_filename_unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
