(function initBackgroundSavePipeline(root, factory) {
  const api = factory();
  root.UVDBackgroundSavePipeline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundSavePipeline() {
  "use strict";

  function createPipeline(deps) {
    const {
      chrome,
      indexedDB,
      IDBKeyRange,
      safeDownloadName,
      relDownloadPath,
      startKeepAlive,
      stopKeepAlive
    } = deps;

    function startChromeDownload(url, filename) {
      return new Promise((resolve, reject) => {
        // Chrome requires a relative path (optional subfolder) with a valid basename
        let fname = String(filename || "").trim();
        // Only an absolute path is unrecoverable here; a ".." *segment* is
        // dropped by the per-segment filter below, and ".." inside a title
        // ("Wait.. what") is a legal filename that must keep its name+folder.
        if (!fname || fname.startsWith("/")) {
          fname = safeDownloadName(`영상_${Date.now()}.mp4`);
        }
        // If path has folders, sanitize only the leaf
        if (fname.includes("/") || fname.includes("\\")) {
          const parts = fname.replace(/\\/g, "/").split("/").filter(Boolean);
          const leaf = safeDownloadName(parts.pop() || `영상_${Date.now()}.mp4`);
          const dirs = parts
            .map((p) =>
              String(p)
                .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
                .trim()
            )
            .filter((p) => p && p !== "." && p !== "..");
          fname = [...dirs, leaf].join("/");
        } else {
          fname = safeDownloadName(fname);
        }
        chrome.downloads.download(
          {
            url,
            filename: fname,
            saveAs: false,
            conflictAction: "uniquify"
          },
          (id) => {
            if (chrome.runtime.lastError || id == null) {
              const err = chrome.runtime.lastError?.message || "다운로드 시작 실패";
              // Retry once with a plain safe name (invalid path / restricted chars)
              if (/invalid|filename|path|name/i.test(err) && fname.includes("/")) {
                chrome.downloads.download(
                  {
                    url,
                    filename: safeDownloadName(fname.split("/").pop()),
                    saveAs: false,
                    conflictAction: "uniquify"
                  },
                  (id2) => {
                    if (chrome.runtime.lastError || id2 == null) {
                      reject(
                        new Error(
                          chrome.runtime.lastError?.message ||
                            err ||
                            "다운로드 시작 실패"
                        )
                      );
                    } else {
                      resolve(id2);
                    }
                  }
                );
                return;
              }
              reject(new Error(err));
            } else {
              resolve(id);
            }
          }
        );
      });
    }

    /**
     * Wait until Chrome reports complete.
     * CRITICAL: never treat "in_progress" as success for blob/data URLs —
     * if we stop keepAlive early, SW dies and the download is interrupted.
     * @param {number} downloadId
     * @param {number} [timeoutMs]
     * @param {{ onProgress?: (p:{bytesReceived:number,totalBytes:number})=>void }} [opts]
     */
    function waitDownloadComplete(downloadId, timeoutMs = 180000, opts = {}) {
      const onProgress = opts.onProgress || null;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          try {
            chrome.downloads.onChanged.removeListener(onChanged);
          } catch {
            /* ignore */
          }
          fn(v);
        };

        const reportWrite = (item) => {
          if (!onProgress || !item) return;
          try {
            onProgress({
              bytesReceived: item.bytesReceived || 0,
              totalBytes: item.totalBytes > 0 ? item.totalBytes : item.fileSize || 0
            });
          } catch {
            /* ignore */
          }
        };

        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === "complete") {
            finish(resolve, { state: "complete", downloadId });
          } else if (delta.state?.current === "interrupted") {
            const code = delta.error?.current || "";
            finish(
              reject,
              new Error(
                code === "USER_CANCELED"
                  ? "다운로드가 취소되었습니다"
                  : code
                    ? `다운로드 중단 (${code})`
                    : "다운로드가 중단되었습니다"
              )
            );
          } else if (
            delta.bytesReceived ||
            delta.totalBytes ||
            delta.fileSize
          ) {
            // Live write progress while Chrome flushes the blob
            chrome.downloads
              .search({ id: downloadId })
              .then(([item]) => reportWrite(item))
              .catch(() => {});
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);

        const poll = setInterval(async () => {
          try {
            const [item] = await chrome.downloads.search({ id: downloadId });
            if (!item) return;
            if (item.state === "in_progress") {
              reportWrite(item);
            }
            if (item.state === "complete") {
              finish(resolve, {
                state: "complete",
                downloadId,
                path: item.filename,
                bytesReceived: item.bytesReceived
              });
            } else if (item.state === "interrupted") {
              finish(
                reject,
                new Error(
                  item.error
                    ? `다운로드 중단 (${item.error})`
                    : "다운로드가 중단되었습니다"
                )
              );
            }
            // Do NOT resolve on in_progress — blob URL would die with SW
          } catch {
            /* ignore */
          }
        }, 500);

        const timer = setTimeout(async () => {
          try {
            const [item] = await chrome.downloads.search({ id: downloadId });
            if (item?.state === "complete") {
              finish(resolve, {
                state: "complete",
                downloadId,
                path: item.filename,
                bytesReceived: item.bytesReceived
              });
            } else if (item?.state === "in_progress" && (item.bytesReceived || 0) > 0) {
              // Still writing after long wait — accept only if substantial progress
              // and keep the blob URL alive a bit longer outside this promise.
              finish(resolve, {
                state: "in_progress",
                downloadId,
                path: item.filename,
                bytesReceived: item.bytesReceived,
                partial: true
              });
            } else {
              finish(
                reject,
                new Error("다운로드가 완료되지 않았습니다. chrome://downloads 를 확인해 주세요")
              );
            }
          } catch {
            finish(reject, new Error("다운로드 상태 확인 실패"));
          }
        }, timeoutMs);
      });
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("FileReader 실패"));
        reader.readAsDataURL(blob);
      });
    }

    /**
     * Save via service worker blob URL.
     * Keep SW alive and do not revoke until chrome.downloads reports complete.
     * @param {Blob} blob
     * @param {string} name
     * @param {{ onProgress?: Function }} [opts]
     */
    async function downloadBlobViaServiceWorker(blob, name, opts = {}) {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("이 Chrome 버전에서는 blob 저장을 지원하지 않습니다");
      }
      const objectUrl = URL.createObjectURL(blob);
      // Large files need long wait; never clear keepAlive before this returns
      const timeoutMs = Math.min(45 * 60 * 1000, Math.max(180_000, blob.size / 8));
      const saveStartedAt = Date.now();
      // Blob: downloads often report 0 bytes until complete — pulse time-based progress
      let pulse = null;
      if (opts.onProgress) {
        pulse = setInterval(() => {
          try {
            opts.onProgress({
              bytesReceived: 0,
              totalBytes: 0,
              _elapsed: Date.now() - saveStartedAt,
              _blobSize: blob.size
            });
          } catch {
            /* ignore */
          }
        }, 500);
      }
      try {
        let id;
        try {
          id = await startChromeDownload(objectUrl, await relDownloadPath(name));
        } catch (e1) {
          // Some Chrome builds reject subfolder paths
          try {
            id = await startChromeDownload(objectUrl, name);
          } catch (e2) {
            throw new Error(e2?.message || e1?.message || "다운로드 시작 실패");
          }
        }
        const done = await waitDownloadComplete(id, timeoutMs, {
          onProgress: (p) => {
            opts.onProgress?.({
              bytesReceived: p.bytesReceived || 0,
              totalBytes: p.totalBytes > 0 ? p.totalBytes : blob.size
            });
          }
        });

        // Resolve path from downloads API
        let path = done.path || "";
        try {
          const [item] = await chrome.downloads.search({ id });
          if (item?.filename) path = item.filename;
        } catch {
          /* ignore */
        }

        // Keep URL alive until Chrome finished reading bytes
        const revokeDelay =
          done.state === "complete" ? 30_000 : done.partial ? 15 * 60_000 : 60_000;
        setTimeout(() => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            /* ignore */
          }
        }, revokeDelay);

        if (id == null) throw new Error("다운로드 ID 없음");
        return {
          downloadId: id,
          filename: name,
          path,
          state: done.state || "complete",
          size: blob.size,
          partial: !!done.partial
        };
      } catch (e) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        if (pulse) {
          try {
            clearInterval(pulse);
          } catch {
            /* ignore */
          }
        }
      }
    }

    /**
     * Small-file fallback: data: URL (no offscreen, no IDB).
     */
    async function downloadBlobViaDataUrl(blob, name) {
      if (blob.size > 15 * 1024 * 1024) {
        throw new Error("파일이 커서 data URL 저장 불가");
      }
      const dataUrl = await blobToDataUrl(blob);
      let id;
      try {
        id = await startChromeDownload(dataUrl, await relDownloadPath(name));
      } catch {
        id = await startChromeDownload(dataUrl, name);
      }
      const done = await waitDownloadComplete(
        id,
        Math.min(10 * 60 * 1000, Math.max(90_000, blob.size / 8))
      );
      let path = done.path || "";
      try {
        const [item] = await chrome.downloads.search({ id });
        if (item?.filename) path = item.filename;
      } catch {
        /* ignore */
      }
      return {
        downloadId: id,
        filename: name,
        path,
        state: done.state || "complete",
        size: blob.size
      };
    }

    const IDB_NAME = "uvd-blobs";
    const IDB_STORE = "blobs";

    function openBlobDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB 열기 실패"));
      });
    }

    async function idbPutBlob(key, blob) {
      const db = await openBlobDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(blob, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error("IndexedDB 저장 실패"));
          tx.onabort = () => reject(tx.error || new Error("IndexedDB 중단"));
        });
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    async function idbDeleteBlob(key) {
      try {
        const db = await openBlobDb();
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } finally {
          try {
            db.close();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    // ─── streamed HLS parts (segment → IndexedDB as it arrives) ───

    /** Zero-padded part key so getAll(range) returns parts in playback order */
    function idbPartKey(baseKey, index) {
      return `${baseKey}:p:${String(index).padStart(6, "0")}`;
    }

    /** Store one segment on an already-open db connection (own transaction). */
    function idbPutPart(db, key, data) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(new Blob([data], { type: "video/mp4" }), key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB 조각 저장 실패"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB 중단"));
      });
    }

    /** List stored part indexes and sizes for a resumable transfer. */
    async function idbListParts(baseKey) {
      const db = await openBlobDb();
      try {
        return await new Promise((resolve, reject) => {
          const parts = [];
          const tx = db.transaction(IDB_STORE, "readonly");
          const range = IDBKeyRange.bound(
            `${baseKey}:p:`,
            `${baseKey}:p:\uffff`
          );
          const req = tx.objectStore(IDB_STORE).openCursor(range);
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            const match = String(cursor.key).match(/:p:(\d+)$/);
            if (match) {
              parts.push({
                index: Number(match[1]),
                size: Number(cursor.value?.size || 0)
              });
            }
            cursor.continue();
          };
          tx.oncomplete = () => resolve(parts);
          tx.onerror = () =>
            reject(tx.error || new Error("IndexedDB 조각 조회 실패"));
          tx.onabort = () =>
            reject(tx.error || new Error("IndexedDB 조각 조회 중단"));
        });
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    /** Delete every stored part for a base key (cleanup after save / on error). */
    async function idbDeleteParts(baseKey) {
      try {
        const db = await openBlobDb();
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(
              IDBKeyRange.bound(`${baseKey}:p:`, `${baseKey}:p:\uffff`)
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } finally {
          try {
            db.close();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    /**
     * Save streamed HLS parts via hidden save page: it assembles Blob(parts)
     * lazily from IndexedDB (disk-backed, memory-light) and chrome.downloads it.
     */
    /** Same relative path the service-worker save path would use (settings subfolder). */
    async function savePageUrl(query, name) {
      let relPath = "";
      try {
        relPath = await relDownloadPath(name);
      } catch {
        relPath = "";
      }
      return chrome.runtime.getURL(
        `src/save.html?${query}&name=${encodeURIComponent(name)}` +
          (relPath ? `&path=${encodeURIComponent(relPath)}` : "")
      );
    }

    async function downloadPartsViaTab(baseKey, name, size, opts = {}) {
      const pageUrl = await savePageUrl(`parts=${encodeURIComponent(baseKey)}`, name);
      const tab = await chrome.tabs.create({ url: pageUrl, active: false });
      const startedAt = Date.now();
      let pulse = null;
      if (opts.onProgress) {
        pulse = setInterval(() => {
          try {
            opts.onProgress({
              bytesReceived: 0,
              totalBytes: 0,
              _elapsed: Date.now() - startedAt,
              _blobSize: size
            });
          } catch {
            /* ignore */
          }
        }, 500);
      }

      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("저장 페이지 시간 초과"));
          }, Math.min(20 * 60 * 1000, Math.max(180_000, (size || 0) / 8)));

          function onMsg(msg, sender, sendResponse) {
            if (msg?.key !== baseKey || sender?.tab?.id !== tab?.id) return false;
            if (msg.type === "SAVE_PAGE_STARTED" && msg.downloadId != null) {
              opts.onDownloadStarted?.(msg.downloadId);
              try {
                sendResponse({ ok: true });
              } catch {
                /* ignore */
              }
              return true;
            }
            if (msg.type !== "SAVE_PAGE_DONE") return false;
            cleanup();
            try {
              sendResponse({ ok: true });
            } catch {
              /* ignore */
            }
            if (msg.ok && msg.downloadId != null) resolve(msg);
            else reject(new Error(msg.error || "저장 페이지 실패"));
            return true;
          }
          function cleanup() {
            clearTimeout(timeout);
            try {
              chrome.runtime.onMessage.removeListener(onMsg);
            } catch {
              /* ignore */
            }
          }
          chrome.runtime.onMessage.addListener(onMsg);
        });

        return {
          downloadId: result.downloadId,
          filename: result.filename || name,
          path: result.path || "",
          state: result.state || "complete",
          size: result.size || size || 0
        };
      } finally {
        if (pulse) {
          try {
            clearInterval(pulse);
          } catch {
            /* ignore */
          }
        }
        await idbDeleteParts(baseKey);
        try {
          if (tab?.id != null) await chrome.tabs.remove(tab.id);
        } catch {
          /* ignore */
        }
      }
    }

    /**
     * Fallback: short-lived extension page owns the blob URL (no offscreen API).
     */
    async function downloadBlobViaTab(blob, name) {
      const key = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await idbPutBlob(key, blob);

      const pageUrl = await savePageUrl(`key=${encodeURIComponent(key)}`, name);
      const tab = await chrome.tabs.create({ url: pageUrl, active: false });

      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("저장 페이지 시간 초과"));
          }, Math.min(20 * 60 * 1000, Math.max(180_000, blob.size / 8)));

          function onMsg(msg, sender, sendResponse) {
            if (msg?.type !== "SAVE_PAGE_DONE" || msg.key !== key) return false;
            cleanup();
            try {
              sendResponse({ ok: true });
            } catch {
              /* ignore */
            }
            if (msg.ok && msg.downloadId != null) resolve(msg);
            else reject(new Error(msg.error || "저장 페이지 실패"));
            return true;
          }
          function cleanup() {
            clearTimeout(timeout);
            try {
              chrome.runtime.onMessage.removeListener(onMsg);
            } catch {
              /* ignore */
            }
          }
          chrome.runtime.onMessage.addListener(onMsg);
        });

        return {
          downloadId: result.downloadId,
          filename: result.filename || name,
          path: result.path || "",
          state: result.state || "complete",
          size: blob.size
        };
      } finally {
        await idbDeleteBlob(key);
        try {
          if (tab?.id != null) await chrome.tabs.remove(tab.id);
        } catch {
          /* ignore */
        }
      }
    }

    /**
     * Save blob to Downloads/VideoDownloader/.
     * Prefer SW path (no offscreen). Keep SW alive until Chrome finishes.
     * @param {Blob} blob
     * @param {string} filename
     * @param {{ onProgress?: Function }} [opts]
     */
    async function downloadBlob(blob, filename, opts = {}) {
      if (!blob?.size) throw new Error("빈 파일은 저장할 수 없습니다");
      if (blob.size < 100_000) {
        throw new Error(`파일이 너무 작습니다 (${Math.round(blob.size / 1024)}KB)`);
      }

      const name = safeDownloadName(filename || `영상_${Date.now()}.mp4`, blob.type || "video/mp4");
      const keep = startKeepAlive();
      const errors = [];

      try {
        // 1) Service worker blob URL (main path — no offscreen)
        try {
          const saved = await downloadBlobViaServiceWorker(blob, name, opts);
          if (saved.downloadId != null) return saved;
          errors.push("다운로드 ID 없음");
        } catch (e) {
          errors.push(String(e?.message || e));
          console.warn("[UVD] SW blob save failed", e);
        }

        // 2) data URL for smaller files
        if (blob.size <= 15 * 1024 * 1024) {
          try {
            const saved = await downloadBlobViaDataUrl(blob, name);
            if (saved.downloadId != null) return saved;
          } catch (e) {
            errors.push(String(e?.message || e));
          }
        }

        // 3) Hidden extension tab (owns document + blob URL)
        try {
          const saved = await downloadBlobViaTab(blob, name);
          if (saved.downloadId != null) return saved;
        } catch (e) {
          errors.push(String(e?.message || e));
          console.warn("[UVD] tab save failed", e);
        }

        const detail = errors.filter(Boolean).slice(0, 2).join(" / ");
        throw new Error(
          detail
            ? `파일 저장 실패: ${detail}`
            : "파일 저장 실패. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요"
        );
      } finally {
        stopKeepAlive(keep);
      }
    }

    return {
      startChromeDownload,
      waitDownloadComplete,
      blobToDataUrl,
      downloadBlobViaServiceWorker,
      downloadBlobViaDataUrl,
      IDB_NAME,
      IDB_STORE,
      openBlobDb,
      idbPutBlob,
      idbDeleteBlob,
      idbPartKey,
      idbPutPart,
      idbListParts,
      idbDeleteParts,
      downloadPartsViaTab,
      downloadBlobViaTab,
      downloadBlob
    };
  }

  return { createPipeline };
});
