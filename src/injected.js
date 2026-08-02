/**
 * Page-context hooks: discover media URLs + capture MSE/HLS segment bytes
 * so blob: players can be exported without re-play gymnastics.
 */
(function () {
  "use strict";
  if (window.__uvdInjected) return;
  window.__uvdInjected = true;

  const MAX = 300;
  const seen = new Set();

  /** @type {{chunks: Uint8Array[], total: number, mime: string, label: string}[]} */
  const mseStores = [];
  /** Ordered segment capture from network (HLS .ts / fMP4 .m4s) */
  const netSegments = [];
  let netMime = "video/mp2t";
  let netTotal = 0;
  const MAX_NET_BYTES = 800 * 1024 * 1024; // 800MB safety

  function emit(url, extra = {}) {
    if (!url || typeof url !== "string") return;
    if (seen.has(url)) return;
    if (seen.size > MAX) return;
    seen.add(url);

    window.postMessage(
      {
        source: "universal-video-downloader",
        type: "FOUND_MEDIA",
        items: [
          {
            url,
            type: classify(url),
            source: "injected",
            filename: filename(url),
            ...extra
          }
        ]
      },
      "*"
    );
  }

  function classify(url) {
    const u = url.toLowerCase();
    if (u.includes(".m3u8") || u.includes("m3u8")) return "stream";
    if (u.includes(".mpd")) return "stream";
    if (/\.(mp3|m4a|aac|wav|flac)(\?|$)/i.test(u)) return "audio";
    if (/\.(ts|m4s)(\?|$)/i.test(u)) return "segment";
    return "video";
  }

  function filename(url) {
    try {
      const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "");
      if (name && name.length < 180) return name.split("?")[0];
    } catch {}
    return `media_${Date.now()}.mp4`;
  }

  function looksMedia(url) {
    if (!url || typeof url !== "string") return false;
    return (
      /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|m3u8|mpd|ts|m4s|aac|ogg|wav)(\?|$|#)/i.test(url) ||
      /\/(video|media|stream|hls|dash|playlist|m3u8)/i.test(url) ||
      /[?&](format|type|mime|file)=(mp4|webm|m3u8|video|ts)/i.test(url)
    );
  }

  function looksSegment(url, ct) {
    const u = (url || "").toLowerCase();
    const c = (ct || "").toLowerCase();
    return (
      /\.(ts|m4s|m4v|mp4)(\?|$|#)/i.test(u) ||
      c.includes("mp2t") ||
      c.includes("mp4") ||
      c.includes("octet-stream")
    );
  }

  function pushNetSegment(buf, url, ct) {
    if (!buf || !buf.byteLength) return;
    if (netTotal + buf.byteLength > MAX_NET_BYTES) return;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // copy — response buffer may be detached later
    const copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    netSegments.push(copy);
    netTotal += copy.byteLength;
    if (ct && ct.includes("mp4")) netMime = "video/mp4";
    else if (/\.m4s|\.mp4/i.test(url || "")) netMime = "video/mp4";
  }

  function mergeChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /** Export best captured buffer as a page-origin blob URL */
  function exportBestCapture() {
    // Prefer MSE stores with most data
    let best = null;
    for (const s of mseStores) {
      if (!s.chunks.length) continue;
      if (!best || s.total > best.total) best = s;
    }
    if (best && best.total > 50_000) {
      const merged = mergeChunks(best.chunks);
      const blob = new Blob([merged], { type: best.mime || "video/mp4" });
      const blobUrl = URL.createObjectURL(blob);
      return {
        ok: true,
        blobUrl,
        size: best.total,
        mime: best.mime || "video/mp4",
        method: "mse",
        ext: (best.mime || "").includes("mp4") ? "mp4" : "mp4"
      };
    }

    if (netSegments.length && netTotal > 50_000) {
      const merged = mergeChunks(netSegments);
      const blob = new Blob([merged], { type: netMime });
      const blobUrl = URL.createObjectURL(blob);
      return {
        ok: true,
        blobUrl,
        size: netTotal,
        mime: netMime,
        method: "net-segments",
        ext: netMime.includes("mp4") ? "mp4" : "ts"
      };
    }

    return {
      ok: false,
      error: "아직 모인 영상 데이터가 없습니다",
      mse: mseStores.map((s) => s.total),
      netTotal
    };
  }

  // --- MediaSource / SourceBuffer capture ---
  try {
    if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sb = origAdd.call(this, mime);
        const store = {
          chunks: [],
          total: 0,
          mime: mime || "video/mp4",
          label: mime || "unknown"
        };
        mseStores.push(store);

        const origAppend = sb.appendBuffer.bind(sb);
        sb.appendBuffer = function (data) {
          try {
            let u8;
            if (data instanceof ArrayBuffer) {
              u8 = new Uint8Array(data.slice(0));
            } else if (ArrayBuffer.isView(data)) {
              u8 = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
            if (u8 && u8.byteLength) {
              if (store.total + u8.byteLength <= MAX_NET_BYTES) {
                store.chunks.push(u8);
                store.total += u8.byteLength;
              }
            }
          } catch {
            /* ignore */
          }
          return origAppend(data);
        };
        return sb;
      };
    }
  } catch {
    /* ignore */
  }

  // --- fetch hook ---
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      let reqUrl = "";
      try {
        const input = args[0];
        reqUrl = typeof input === "string" ? input : input?.url || "";
        if (looksMedia(reqUrl)) emit(reqUrl);
      } catch {
        /* ignore */
      }

      return origFetch.apply(this, args).then((res) => {
        try {
          const ct = res.headers?.get?.("content-type") || "";
          const finalUrl = res.url || reqUrl;
          if (
            ct.startsWith("video/") ||
            ct.startsWith("audio/") ||
            ct.includes("mpegurl") ||
            ct.includes("dash+xml") ||
            looksMedia(finalUrl)
          ) {
            emit(finalUrl);
          }
          // Capture segment bodies (clone so player still works)
          if (looksSegment(finalUrl, ct) && !/\.m3u8/i.test(finalUrl)) {
            res
              .clone()
              .arrayBuffer()
              .then((buf) => pushNetSegment(buf, finalUrl, ct))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return res;
      });
    };
  }

  // --- XHR hook ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__uvdUrl = String(url || "");
    try {
      if (looksMedia(this.__uvdUrl)) emit(this.__uvdUrl);
    } catch {
      /* ignore */
    }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener("load", function () {
        try {
          const url = this.__uvdUrl || this.responseURL || "";
          const ct = this.getResponseHeader?.("content-type") || "";
          if (looksMedia(url)) emit(url);
          if (looksSegment(url, ct) && this.response) {
            if (this.responseType === "arraybuffer" && this.response) {
              pushNetSegment(this.response, url, ct);
            } else if (this.response instanceof Blob) {
              this.response.arrayBuffer().then((b) => pushNetSegment(b, url, ct)).catch(() => {});
            }
          }
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    return origSend.apply(this, args);
  };

  // --- media element src ---
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (desc?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(v) {
          try {
            if (v) emit(String(v));
          } catch {
            /* ignore */
          }
          return desc.set.call(this, v);
        }
      });
    }
  } catch {
    /* ignore */
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      const src = this.currentSrc || this.src;
      if (src) {
        emit(src, {
          width: this.videoWidth || undefined,
          height: this.videoHeight || undefined
        });
      }
    } catch {
      /* ignore */
    }
    return origPlay.apply(this, args);
  };

  // Performance timeline
  try {
    performance.getEntriesByType("resource").forEach((e) => {
      if (looksMedia(e.name)) emit(e.name);
    });
    const po = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        if (looksMedia(e.name)) emit(e.name);
      });
    });
    po.observe({ entryTypes: ["resource"] });
  } catch {
    /* ignore */
  }

  // Content-script bridge
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "uvd-content") return;

    if (data.type === "EXPORT_CAPTURE") {
      const result = exportBestCapture();
      window.postMessage(
        {
          source: "universal-video-downloader",
          type: "CAPTURE_EXPORT",
          requestId: data.requestId,
          ...result
        },
        "*"
      );
    }

    if (data.type === "CAPTURE_STATUS") {
      window.postMessage(
        {
          source: "universal-video-downloader",
          type: "CAPTURE_STATUS",
          requestId: data.requestId,
          mse: mseStores.map((s) => ({ total: s.total, mime: s.mime })),
          netTotal,
          netCount: netSegments.length
        },
        "*"
      );
    }
  });
})();
