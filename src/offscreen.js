/**
 * Offscreen document — owns blob URLs until chrome.downloads finishes reading them.
 * Blobs arrive via IndexedDB (same extension origin) — never via binary message chunks.
 */

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

async function idbGetBlob(key) {
  const db = await openBlobDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("IndexedDB 읽기 실패"));
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

function waitComplete(downloadId, timeoutMs) {
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

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        finish(resolve, { state: "complete" });
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
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const poll = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
        if (item.state === "complete") {
          finish(resolve, { state: "complete", path: item.filename });
        } else if (item.state === "interrupted") {
          finish(
            reject,
            new Error(item.error ? `다운로드 중단 (${item.error})` : "다운로드가 중단되었습니다")
          );
        }
      } catch {
        /* ignore */
      }
    }, 400);

    const timer = setTimeout(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.state === "complete") {
          finish(resolve, { state: "complete", path: item.filename });
        } else if (item?.state === "in_progress" && (item.bytesReceived || 0) > 0) {
          finish(resolve, {
            state: "in_progress",
            path: item.filename,
            partial: true
          });
        } else {
          finish(reject, new Error("다운로드가 완료되지 않았습니다"));
        }
      } catch {
        finish(reject, new Error("다운로드 상태 확인 실패"));
      }
    }, timeoutMs);
  });
}

function sanitizeName(filename) {
  let name = String(filename || `영상_${Date.now()}.mp4`)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.ts$/i, ".mp4")
    .trim();
  if (!name || name.length < 2) name = `영상_${Date.now()}.mp4`;
  if (!/\.mp4$/i.test(name)) {
    name = name.replace(/\.[a-z0-9]{2,5}$/i, "") + ".mp4";
  }
  if (name.length > 100) {
    name = name.slice(0, 96).trim() + ".mp4";
  }
  return name;
}

function tryDownload(objectUrl, name) {
  const tryDl = (path) =>
    new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: objectUrl,
          filename: path,
          saveAs: false,
          conflictAction: "uniquify"
        },
        (id) => {
          if (chrome.runtime.lastError || id == null) {
            reject(new Error(chrome.runtime.lastError?.message || "다운로드 실패"));
          } else {
            resolve(id);
          }
        }
      );
    });

  return tryDl(`VideoDownloader/${name}`).catch(() => tryDl(name));
}

async function saveBlob(blob, filename) {
  if (!blob?.size) throw new Error("저장 데이터가 없습니다");
  if (blob.size < 100_000) {
    throw new Error(`파일이 너무 작습니다 (${Math.round(blob.size / 1024)}KB)`);
  }

  const name = sanitizeName(filename);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await tryDownload(objectUrl, name);
    const timeoutMs = Math.min(40 * 60 * 1000, Math.max(90_000, blob.size / 15));
    const done = await waitComplete(downloadId, timeoutMs);

    let path = done.path || "";
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.filename) path = item.filename;
    } catch {
      /* ignore */
    }

    setTimeout(
      () => {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* ignore */
        }
      },
      done.partial ? 15 * 60_000 : 20_000
    );

    return {
      ok: true,
      downloadId,
      filename: name,
      path,
      size: blob.size,
      state: done.state || "complete"
    };
  } catch (e) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Coerce various wire formats into a Blob (legacy message path). */
function coerceToBlob(data, mime) {
  const type = mime || "video/mp4";
  if (!data) return null;
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer && data.byteLength) {
    return new Blob([data], { type });
  }
  if (ArrayBuffer.isView(data) && data.byteLength) {
    return new Blob([data], { type });
  }
  // Structured-clone sometimes yields a plain object with numeric keys
  if (typeof data === "object" && data.byteLength > 0 && data.buffer) {
    try {
      const u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      if (u8.byteLength) return new Blob([u8], { type });
    } catch {
      /* fall through */
    }
  }
  if (typeof data === "string" && data.length > 100) {
    try {
      const bin = atob(data);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type });
    } catch {
      /* fall through */
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  // Primary: blob already in IndexedDB — only pass the key
  if (msg.type === "OFFSCREEN_SAVE_IDB") {
    (async () => {
      const { id, filename, mime } = msg;
      try {
        if (!id) throw new Error("저장 키 없음");
        const stored = await idbGetBlob(id);
        if (!stored) throw new Error("IndexedDB에 영상 데이터가 없습니다");

        let blob;
        if (stored instanceof Blob) {
          blob = stored.type ? stored : new Blob([stored], { type: mime || "video/mp4" });
        } else {
          blob = coerceToBlob(stored, mime);
        }
        if (!blob?.size) throw new Error("저장된 데이터가 비어 있습니다");

        const result = await saveBlob(blob, filename);
        await idbDeleteBlob(id);
        sendResponse(result);
      } catch (e) {
        try {
          await idbDeleteBlob(id);
        } catch {
          /* ignore */
        }
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  // Legacy single-shot (small files only)
  if (msg.type === "OFFSCREEN_SAVE") {
    (async () => {
      try {
        const blob = coerceToBlob(msg.buffer, msg.mime);
        if (!blob?.size) throw new Error("저장 데이터가 비어 있습니다");
        const result = await saveBlob(blob, msg.filename);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  // Ignore old chunk protocol — respond clearly so SW can fall back
  if (msg.type === "OFFSCREEN_CHUNK" || msg.type === "OFFSCREEN_FINISH") {
    sendResponse({
      ok: false,
      error: "구버전 전송 방식입니다. 확장 프로그램을 새로고침 해 주세요"
    });
    return false;
  }

  return false;
});

console.log("[UVD offscreen] ready (idb)");
