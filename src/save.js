/**
 * Temporary extension page: load blob from IndexedDB and chrome.downloads it.
 * Used when service-worker blob URLs fail (no offscreen dependency).
 */
(async () => {
  const params = new URLSearchParams(location.search);
  const partsKey = params.get("parts");
  const key = params.get("key") || partsKey;
  const nameParam = params.get("name") || `영상_${Date.now()}.mp4`;
  // Relative path (settings subfolder + locked name) chosen by the background;
  // this page must not re-sanitize or truncate it, or the saved name and the
  // history entry drift apart.
  const pathParam = params.get("path") || "";

  function leafName(filename) {
    let name = String(filename || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() || "";
    name = name.replace(/[<>:"|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
    if (!name || name.length < 2 || !/\.[a-z0-9]{2,5}$/i.test(name)) {
      name = `영상_${Date.now()}.mp4`;
    }
    return name;
  }

  function relativePath(path, leaf) {
    const segments = String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "").trim())
      .filter((s) => s && s !== "." && s !== "..");
    if (!segments.length) return leaf;
    segments[segments.length - 1] = leaf;
    return segments.join("/");
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("uvd-blobs", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("DB 실패"));
    });
  }

  async function getBlob(id) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("blobs", "readonly");
        const r = tx.objectStore("blobs").get(id);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Streamed HLS mode: parts were written during download under
   * "<base>:p:<000idx>". Keys are zero-padded so getAll returns playback
   * order. Blob(parts) references them lazily — memory stays flat.
   */
  async function getPartsBlob(baseKey) {
    const db = await openDb();
    try {
      const parts = await new Promise((resolve, reject) => {
        const tx = db.transaction("blobs", "readonly");
        const r = tx
          .objectStore("blobs")
          .getAll(IDBKeyRange.bound(`${baseKey}:p:`, `${baseKey}:p:\uffff`));
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      if (!parts.length) return null;
      return new Blob(parts, { type: "video/mp4" });
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  function waitComplete(downloadId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
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
      const onChanged = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") finish(resolve, { state: "complete" });
        else if (delta.state?.current === "interrupted") {
          finish(reject, new Error("다운로드가 중단되었습니다"));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
      const poll = setInterval(async () => {
        try {
          const [item] = await chrome.downloads.search({ id: downloadId });
          if (item?.state === "complete") {
            finish(resolve, { state: "complete", path: item.filename });
          } else if (item?.state === "interrupted") {
            finish(reject, new Error("다운로드가 중단되었습니다"));
          } else if (item?.state === "in_progress" && item.paused) {
            // User paused the final save: this page owns the blob URL, so it
            // must stay alive until the download resumes and finishes.
            armTimer();
          }
        } catch {
          /* ignore */
        }
      }, 400);
      const onTimeout = async () => {
        try {
          const [item] = await chrome.downloads.search({ id: downloadId });
          if (item?.state === "complete") {
            finish(resolve, { state: "complete", path: item.filename });
          } else if (item?.state === "in_progress" && item.paused) {
            armTimer();
          } else if (item?.state === "in_progress" && (item.bytesReceived || 0) > 0) {
            finish(resolve, { state: "in_progress", path: item.filename, partial: true });
          } else {
            finish(reject, new Error("다운로드 완료 대기 시간 초과"));
          }
        } catch {
          finish(reject, new Error("다운로드 상태 확인 실패"));
        }
      };
      function armTimer() {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(onTimeout, timeoutMs);
      }
      armTimer();
    });
  }

  function startDownload(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        },
        (id) => {
          if (chrome.runtime.lastError || id == null) {
            reject(new Error(chrome.runtime.lastError?.message || "다운로드 시작 실패"));
          } else resolve(id);
        }
      );
    });
  }

  async function report(payload) {
    try {
      await chrome.runtime.sendMessage({ type: "SAVE_PAGE_DONE", key, ...payload });
    } catch {
      /* SW may already have timed out */
    }
  }

  try {
    if (!key) throw new Error("저장 키 없음");
    let blob;
    if (partsKey) {
      blob = await getPartsBlob(partsKey);
      if (!blob) throw new Error("저장 조각을 찾을 수 없습니다");
    } else {
      const stored = await getBlob(key);
      if (!stored) throw new Error("저장 데이터를 찾을 수 없습니다");
      blob =
        stored instanceof Blob
          ? stored
          : new Blob([stored], { type: "video/mp4" });
    }
    if (!blob.size || blob.size < 100000) {
      throw new Error(`파일이 너무 작습니다 (${Math.round((blob.size || 0) / 1024)}KB)`);
    }

    const name = leafName(nameParam);
    const target = pathParam ? relativePath(pathParam, name) : `VideoDownloader/${name}`;
    const objectUrl = URL.createObjectURL(blob);
    let downloadId;
    try {
      try {
        downloadId = await startDownload(objectUrl, target);
      } catch {
        downloadId = await startDownload(objectUrl, name);
      }
      await report({ type: "SAVE_PAGE_STARTED", downloadId, filename: name });
      const timeoutMs = Math.min(20 * 60 * 1000, Math.max(120_000, blob.size / 8));
      const done = await waitComplete(downloadId, timeoutMs);
      let path = done.path || "";
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.filename) path = item.filename;
      } catch {
        /* ignore */
      }
      // Keep URL briefly so Chrome can finish reading
      setTimeout(() => {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      }, done.partial ? 300000 : 20000);

      await report({
        ok: true,
        downloadId,
        filename: name,
        path,
        state: done.state || "complete",
        size: blob.size
      });
    } catch (e) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    await report({ ok: false, error: String(e?.message || e) });
  }
})();
