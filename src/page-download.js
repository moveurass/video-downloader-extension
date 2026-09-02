/**
 * Page-context download helpers.
 * Critical: after HLS merge, save via background chrome.downloads
 * (anchor <a download> fails after long async — user gesture is gone).
 */
(function () {
  "use strict";

  const MIN_VIDEO_BYTES = 200_000; // 200KB — reject playlist-sized fakes
  /** Active download abort — content STOP_DOWNLOAD calls abort() */
  let activeAbort = null;

  function pageTitleFilename(ext = "mp4") {
    let title = String(document.title || "")
      .replace(/^\(\d{1,4}\)\s*/, "")
      .replace(/\s*[-–—|]\s*(YouTube|TikTok|Instagram|Facebook|X|Twitter|Vimeo).*$/i, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title || /^(video|media|download|untitled|영상|동영상)$/i.test(title)) {
      try {
        title = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      } catch {
        title = "";
      }
    }
    title = title
      .replace(/\.(mp4|webm|mkv|mov|m4v|m3u8|mpd|ts)$/i, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `${title || "Downloaded video"}.${ext}`;
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `시간 초과 (${ms}ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function throwIfPageStopped() {
    if (window.__UVD_STOP_DOWNLOAD__ || activeAbort?.signal?.aborted) {
      const e = new Error("CANCELLED");
      e.code = "CANCELLED";
      throw e;
    }
  }

  async function fetchWithTimeout(url, init = {}, ms = 25000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const outer = init.signal || activeAbort?.signal;
    const onOuter = () => {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    };
    if (outer) {
      if (outer.aborted) {
        clearTimeout(timer);
        throw new Error("CANCELLED");
      }
      outer.addEventListener("abort", onOuter, { once: true });
    }
    try {
      const { signal: _s, ...rest } = init;
      return await fetch(url, { ...rest, signal: ctrl.signal });
    } catch (e) {
      if (e?.name === "AbortError" || /abort/i.test(String(e?.message || ""))) {
        if (outer?.aborted || window.__UVD_STOP_DOWNLOAD__) {
          throw new Error("CANCELLED");
        }
        throw new Error("요청 시간 초과");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) {
        try {
          outer.removeEventListener("abort", onOuter);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Reliable save: send bytes to service worker → chrome.downloads
   */
  async function saveBlobThroughBackground(blob, filename, onProgress) {
    if (!blob || !blob.size) throw new Error("저장할 데이터가 없습니다");
    if (blob.size < MIN_VIDEO_BYTES) {
      throw new Error(
        `파일이 너무 작습니다 (${Math.round(blob.size / 1024)}KB). 영상 병합에 실패했을 수 있습니다`
      );
    }

    const mime = blob.type || "video/mp4";
    const mimeExt = /webm/i.test(mime) ? "webm" : /audio\/mpeg/i.test(mime) ? "mp3" : "mp4";
    let name = (filename || pageTitleFilename(mimeExt))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\.ts$/i, ".mp4")
      .replace(/\.m3u8$/i, ".mp4")
      .replace(/\.mpd$/i, ".mp4")
      .trim();
    if (!/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac)$/i.test(name)) {
      name = name.replace(/\.[a-z0-9]{2,5}$/i, "") + `.${mimeExt}`;
    }

    onProgress?.({ phase: "save", percent: 92, message: "파일 저장 중…" });

    const buffer = await blob.arrayBuffer();
    const totalBytes = buffer.byteLength;
    const CHUNK = 4 * 1024 * 1024; // 4MB
    const totalChunks = Math.ceil(totalBytes / CHUNK);
    const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK;
      const end = Math.min(start + CHUNK, totalBytes);
      const chunk = buffer.slice(start, end);
      const res = await chrome.runtime.sendMessage({
        type: "VIDEO_CHUNK",
        id,
        index: i,
        totalChunks,
        totalBytes,
        chunk,
        filename: name,
        mime
      });
      if (!res?.ok) throw new Error(res?.error || "청크 전송 실패");
      const pct = 92 + Math.round(((i + 1) / totalChunks) * 6);
      onProgress?.({
        phase: "save",
        percent: pct,
        message: `저장 중… ${i + 1}/${totalChunks}`
      });
    }

    const fin = await chrome.runtime.sendMessage({
      type: "VIDEO_CHUNK_FINISH",
      id,
      filename: name,
      mime
    });
    if (!fin?.ok) throw new Error(fin?.error || "파일 저장 실패");

    onProgress?.({ phase: "done", percent: 100, message: "저장 완료" });
    if (fin.downloadId == null) {
      throw new Error("파일이 저장되지 않았습니다 (downloadId 없음)");
    }
    return {
      ok: true,
      size: totalBytes,
      filename: fin.filename || name,
      downloadId: fin.downloadId,
      path: fin.path || "",
      method: "chrome-downloads"
    };
  }

  async function fetchAsBlob(url, ms = 90000) {
    const attempts = [{ credentials: "include" }, { credentials: "omit" }];
    let lastErr;
    for (const init of attempts) {
      try {
        const res = await fetchWithTimeout(url, init, ms);
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        const blob = await res.blob();
        if (!blob.size) {
          lastErr = new Error("빈 파일");
          continue;
        }
        return blob;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("fetch 실패");
  }

  function looksHls(url, type) {
    if (!url) return false;
    if (/\.m3u8(\?|$|#)/i.test(url)) return true;
    if (/[?&].*(format=m3u8|type=hls|playlist\.m3u8)/i.test(url)) return true;
    if (type === "stream" && /m3u8/i.test(url)) return true;
    return false;
  }

  function requestPageCapture(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const requestId = "cap_" + Math.random().toString(36).slice(2);
      const onMsg = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "universal-video-downloader") return;
        if (data.type !== "CAPTURE_EXPORT" || data.requestId !== requestId) return;
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        resolve(data);
      };
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve({ ok: false, error: "캡처 응답 시간 초과" });
      }, timeoutMs);
      window.addEventListener("message", onMsg);
      window.postMessage(
        { source: "uvd-content", type: "EXPORT_CAPTURE", requestId },
        "*"
      );
    });
  }

  async function downloadFromCapture(filename, onProgress) {
    onProgress?.({ phase: "capture", percent: 20, message: "버퍼에서 추출 중…" });
    const cap = await requestPageCapture(12000);
    if (!cap?.ok || !cap.blobUrl) {
      throw new Error(cap?.error || "추출할 버퍼 없음");
    }
    const res = await fetch(cap.blobUrl);
    const blob = await res.blob();
    try {
      URL.revokeObjectURL(cap.blobUrl);
    } catch {
      /* ignore */
    }
    if (blob.size < MIN_VIDEO_BYTES) {
      throw new Error("버퍼 데이터가 부족합니다. 영상을 조금 재생한 뒤 다시 시도하세요");
    }
    const ext = cap.ext || (cap.mime?.includes("mp4") ? "mp4" : "ts");
    let name = filename || pageTitleFilename(ext);
    if (!/\.(mp4|ts|webm)$/i.test(name)) {
      name = name.replace(/\.[^.]+$/, "") + "." + ext;
    }
    return saveBlobThroughBackground(blob, name, onProgress);
  }

  async function downloadDirect(url, filename, onProgress) {
    onProgress?.({ phase: "start", percent: 15, message: "파일 받는 중…" });
    if (/\.m3u8(\?|$|#)/i.test(url)) {
      return downloadHls(url, filename, "best", onProgress);
    }
    const blob = await fetchAsBlob(url, 120_000);
    if (blob.type && blob.type.includes("text/html")) {
      throw new Error("영상 대신 웹페이지가 반환됨");
    }
    // Small — might be m3u8 text
    if (blob.size < 500_000) {
      const text = await blob.text();
      if (text.includes("#EXTM3U")) {
        return downloadHls(url, filename, "best", onProgress);
      }
      const b2 = new Blob([text], { type: blob.type || "application/octet-stream" });
      if (b2.size < MIN_VIDEO_BYTES) {
        throw new Error("파일이 너무 작아 영상이 아닙니다");
      }
      return saveBlobThroughBackground(b2, filename, onProgress);
    }
    return saveBlobThroughBackground(blob, filename, onProgress);
  }

  async function downloadHls(
    url,
    filename,
    preferQuality,
    onProgress,
    trackOptions = {}
  ) {
    if (typeof HLS === "undefined" || !HLS.downloadAndMerge) {
      throw new Error("HLS 모듈 없음 — 페이지를 새로고침 하세요");
    }
    throwIfPageStopped();
    onProgress?.({ phase: "playlist", percent: 5, message: "재생목록 분석 중…" });

    // Page origin as Referer — critical to avoid Segment HTTP 403 on hotlink CDNs
    const pageUrl = location.href || "";
    const signal = activeAbort?.signal || null;
    const result = await withTimeout(
      HLS.downloadAndMerge(url, {
        preferQuality: preferQuality || "best",
        audioTrackId: trackOptions.audioTrackId || "",
        pageUrl,
        referer: pageUrl,
        signal,
        shouldStop: throwIfPageStopped,
        // Do not set mode:"cors" — causes Failed to fetch on many CDNs in CS
        requestInit: {
          credentials: "include",
          cache: "no-store",
          headers: pageUrl ? { Referer: pageUrl } : {},
          signal: signal || undefined
        },
        allowPartial: true,
        onProgress: (p) => {
          throwIfPageStopped();
          // Same bands as background: segments 5–78, merge 78–85, save later
          let percent = 3;
          if (p.phase === "segments" && p.total > 0) {
            percent = Math.round(5 + (p.current / p.total) * 73);
          } else if (p.phase === "merge") {
            if (p.total > 0) {
              percent = Math.round(
                78 + (Math.min(p.current, p.total) / p.total) * 7
              );
            } else percent = 80;
          } else if (p.phase === "done") percent = 85;
          else if (p.phase === "playlist" || p.phase === "init") percent = 3;
          onProgress?.({
            ...p,
            percent,
            // Keep HLS size-based message (MB); never rewrite to segment counts
            message:
              p.phase === "merge"
                ? p.message || "파일 만드는 중…"
                : p.phase === "segments"
                  ? p.message || "받는 중…"
                  : p.message || "준비 중…"
          });
        }
      }),
      30 * 60 * 1000,
      "스트리밍 다운로드 시간 초과"
    );

    if (!result?.blob || result.size < MIN_VIDEO_BYTES) {
      throw new Error(
        `병합 실패: 결과 크기 ${result?.size || 0}바이트 (조각 ${result?.segmentCount || 0}개)`
      );
    }

    // Always .mp4 for users
    let name = filename || result.filename || pageTitleFilename("mp4");
    name = name.replace(/\.ts$/i, ".mp4").replace(/\.m3u8$/i, ".mp4");
    if (!/\.mp4$/i.test(name)) {
      name = name.replace(/\.[^.]+$/, "") + ".mp4";
    }

    // MUST use chrome.downloads — a[download] does not work after long async
    const saved = await saveBlobThroughBackground(result.blob, name, onProgress);
    return {
      ...saved,
      quality: result.quality,
      segmentCount: result.segmentCount,
      method: "page-hls"
    };
  }

  async function downloadBlobUrl(url, filename, onProgress) {
    onProgress?.({ phase: "start", percent: 8, message: "blob 확인 중…" });
    try {
      const res = await fetchWithTimeout(url, {}, 8000);
      const blob = await res.blob();
      if (blob.size >= MIN_VIDEO_BYTES) {
        return saveBlobThroughBackground(
          blob,
          filename || pageTitleFilename(blob.type?.includes("webm") ? "webm" : "mp4"),
          onProgress
        );
      }
    } catch {
      /* MSE */
    }
    return downloadFromCapture(filename, onProgress);
  }

  async function smartDownload(opts, onProgress) {
    const { url, filename, preferQuality, type, audioTrackId } = opts || {};
    if (!url) throw new Error("받을 주소가 없습니다");

    // Fresh abort controller per download
    activeAbort = new AbortController();
    window.__UVD_STOP_DOWNLOAD__ = false;
    try {
      throwIfPageStopped();
      onProgress?.({ phase: "start", percent: 3, message: "시작…" });

      if (url.startsWith("blob:")) {
        return await downloadBlobUrl(url, filename, onProgress);
      }
      if (looksHls(url, type)) {
        return await downloadHls(url, filename, preferQuality, onProgress, {
          audioTrackId: audioTrackId || ""
        });
      }
      return await downloadDirect(url, filename, onProgress);
    } finally {
      // Keep controller until STOP can still abort mid-flight cleanup
    }
  }

  function abort() {
    window.__UVD_STOP_DOWNLOAD__ = true;
    try {
      activeAbort?.abort();
    } catch {
      /* ignore */
    }
  }

  window.__UVD_PAGE_DOWNLOAD__ = {
    smartDownload,
    abort,
    downloadDirect,
    downloadHls,
    downloadBlobUrl,
    downloadFromCapture,
    saveBlobThroughBackground
  };
})();
