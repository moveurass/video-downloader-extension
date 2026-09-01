(function initDownloadEngine(root, factory) {
  const api = factory(root);
  root.UVDDownloadEngine = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDownloadEngine(root) {
  "use strict";

  const MEDIA_EXTENSIONS = new Set([
    "mp4", "webm", "mkv", "mov", "m4v", "mp3", "m4a", "aac", "wav",
    "m3u8", "mpd", "ts", "m4s"
  ]);

  function extFromUrl(url) {
    try {
      const match = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})(?:$|[?#])/);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  function isHlsUrl(url) {
    return /\.m3u8(\?|$|#)/i.test(url || "") || /m3u8/i.test(url || "");
  }

  function isRealHls(url, mediaType) {
    if (!url) return false;
    if (/\.m3u8(\?|$|#)/i.test(url)) return true;
    return /m3u8/i.test(url) &&
      (mediaType === "stream" || /playlist|format=m3u8/i.test(url));
  }

  function sniffIsVideo(bytes) {
    if (!bytes || bytes.length < 12) return false;
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return false;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return false;
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return false;
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
      bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45
    ) {
      return false;
    }
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return true;
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return true;
    }
    return bytes[0] === 0x47;
  }

  function classifyMedia(url, mime = "") {
    const ext = extFromUrl(url);
    const value = String(mime || "").toLowerCase();
    if (ext === "m3u8" || value.includes("mpegurl") || value.includes("m3u8")) {
      return { type: "stream" };
    }
    if (ext === "mpd" || value.includes("dash+xml")) return { type: "stream" };
    if (ext === "ts" || ext === "m4s") return { type: "segment" };
    if (value.startsWith("audio/") || ["mp3", "m4a", "aac", "wav"].includes(ext)) {
      return { type: "audio" };
    }
    return { type: "video" };
  }

  function isLikelyMedia(url, mime = "", size = 0, deps = {}) {
    if (!url || /^(chrome|data:|blob:)/i.test(url)) return false;
    if (/\.m3u8(\?|$|#)/i.test(url) || /mpegurl|m3u8/i.test(mime)) return true;
    if (/googlevideo\.com\/videoplayback/i.test(url) && !/[&?]oad=/i.test(url)) return true;
    if (
      /tiktokcdn|musical\.ly|byteicdn|ibyteimg|tiktokv\.com|byteoversea|tiktok\.com\/aweme/i.test(url) &&
      (/video|play|media|mime_type=video|\.mp4|\/play\//i.test(url) || mime.startsWith("video/"))
    ) {
      return true;
    }
    if (deps.isInstagramCdnUrl?.(url)) return true;
    if (mime.startsWith("video/") && /cdninstagram|fbcdn\.net/i.test(url)) return true;
    if (deps.isJunkMedia?.({ url, size, type: "video" })) return false;
    if (/\d+_\d{2,4}x\d{2,4}/i.test(url)) return false;
    if (/doubleclick|googlesyndication|exoclick|trafficjunky/i.test(url)) return false;
    return MEDIA_EXTENSIONS.has(extFromUrl(url)) ||
      mime.toLowerCase().startsWith("video/") ||
      mime.toLowerCase().startsWith("audio/");
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(message || `시간 초과 (${Math.round(ms / 1000)}초)`)),
        ms
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function friendlyFetchError(error) {
    const message = String(error?.message || error || "");
    return /Failed to fetch|NetworkError|Load failed/i.test(message)
      ? "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 시도해 주세요"
      : message;
  }

  function parseSpeedFromMessage(message) {
    const match = String(message || "").match(
      /(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|KB|MB|GB|kB|mB|B)\/s/i
    );
    if (!match) return 0;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2].toLowerCase();
    if (unit === "b") return value;
    if (unit === "kib" || unit === "kb") return value * 1024;
    if (unit === "mib" || unit === "mb") return value * 1024 * 1024;
    if (unit === "gib" || unit === "gb") return value * 1024 * 1024 * 1024;
    return 0;
  }

  function phaseRank(phase) {
    const value = String(phase || "");
    if (value === "start" || value === "playlist") return 1;
    if (value === "download" || value === "segments" || value === "running") return 2;
    if (value === "merge" || value === "save") return 3;
    if (value === "done" || value === "error") return 4;
    return 2;
  }

  function hlsPhasePercent(progress = {}) {
    if (progress.phase === "save") {
      return typeof progress.percent === "number" && progress.percent >= 0
        ? Math.max(85, Math.min(98, progress.percent))
        : 86;
    }
    if (progress.phase === "segments") {
      if (progress.total > 0) {
        const ratio = Math.max(0, Math.min(1, Number(progress.current) / Number(progress.total)));
        return Math.round(5 + ratio * 73);
      }
      return 5;
    }
    if (progress.phase === "merge") {
      if (progress.total > 0 && progress.current >= 0) {
        const ratio = Math.max(0, Math.min(1, Number(progress.current) / Number(progress.total)));
        return Math.round(78 + ratio * 7);
      }
      return 80;
    }
    if (progress.phase === "done") return 100;
    if (["playlist", "init", "start"].includes(progress.phase)) return 3;
    if (typeof progress.percent === "number" && progress.percent >= 0) {
      return Math.max(0, Math.min(98, progress.percent));
    }
    return 3;
  }

  function estimateSavePercent(blobSize, startedAt, bytesReceived, totalBytes) {
    if (totalBytes > 0 && bytesReceived > 0) {
      return Math.round(85 + Math.min(1, bytesReceived / totalBytes) * 13);
    }
    const elapsed = Math.max(0, Date.now() - (startedAt || Date.now()));
    const estimatedMs = Math.min(
      10 * 60 * 1000,
      Math.max(3000, ((blobSize || 50_000_000) / (60 * 1024 * 1024)) * 1000)
    );
    return Math.round(85 + Math.min(0.92, elapsed / estimatedMs) * 12);
  }

  function safeDownloadName(filename, mime = "", Naming = root.Naming) {
    const defaultExtension = String(mime).includes("audio") ? ".mp3" : ".mp4";
    let name = String(filename || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
    name = name
      .replace(
        /\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*\.(mp4|webm|mkv|mp3|m4a)$/i,
        ".$1"
      )
      .replace(/\.(mp4|webm|mkv|mp3|m4a)\s*\(\d{1,3}\)\s*$/i, ".$1")
      .replace(/\s*\(\d{1,3}\)\s*(?=\.[a-z0-9]{2,5}$)/i, "")
      .replace(/\s*\(\d{1,3}\)\s*$/g, "")
      .replace(/[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi, " ")
      .replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ")
      .replace(
        /[-–—|·•:_\s]*(No\s*Mosaic|Demosaic|Uncut|Raw)(?=[_\s\-–—.]|$)/gi,
        " "
      )
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[\u{2600}-\u{27BF}]/gu, "")
      .replace(/[♥❤💕💗💖💘⭐✨…·•]/g, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/[\u2010-\u2015\u2212]+/g, " ")
      .replace(/\s+-\s+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\.ts$/i, ".mp4")
      .replace(/\.m3u8$/i, ".mp4")
      .replace(/^\.+/, "")
      .trim();

    let extension = defaultExtension;
    let peelGuard = 0;
    while (peelGuard++ < 6 && /\.[a-z0-9]{2,5}$/i.test(name)) {
      const match = name.match(/(\.[a-z0-9]{2,5})$/i);
      if (!match) break;
      const candidate = match[1].toLowerCase();
      if (candidate === ".ts" || candidate === ".m3u8") {
        extension = ".mp4";
      } else if (
        [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".mp3", ".m4a", ".aac"].includes(candidate)
      ) {
        extension = candidate;
      } else {
        break;
      }
      name = name.slice(0, -match[1].length).trim();
      if (/^\d{3,4}p$/i.test(name)) break;
    }
    name = name.replace(/^[.\s_-]+|[.\s_-]+$/g, "").trim();
    if (Naming?.cleanPageTitle) {
      const cleaned = Naming.cleanPageTitle(name);
      if (cleaned && cleaned.length >= 2) name = cleaned;
    }
    if (
      !name ||
      name.length < 2 ||
      /^(best|all|unknown|video|media|download|file|영상|동영상|mp4|webm|mkv|mp3|m4a)$/i.test(name)
    ) {
      name = `영상_${Date.now()}`;
    }
    let full = `${name}${extension.startsWith(".") ? extension : `.${extension}`}`;
    full = full.replace(
      /\.(mp4|webm|mkv|mp3|m4a)\.(mp4|webm|mkv|mp3|m4a)$/i,
      ".$2"
    );
    if (full.length > 100) {
      const ext = extension.startsWith(".") ? extension : `.${extension}`;
      full = name.slice(0, Math.max(8, 100 - ext.length)).trim() + ext;
    }
    if (!/^[^\s/\\].+\.[a-z0-9]{2,5}$/i.test(full) || full.startsWith(".")) {
      return `영상_${Date.now()}${defaultExtension}`;
    }
    return full;
  }

  return {
    extFromUrl,
    isHlsUrl,
    isRealHls,
    sniffIsVideo,
    classifyMedia,
    isLikelyMedia,
    withTimeout,
    friendlyFetchError,
    parseSpeedFromMessage,
    phaseRank,
    hlsPhasePercent,
    estimateSavePercent,
    safeDownloadName
  };
});
