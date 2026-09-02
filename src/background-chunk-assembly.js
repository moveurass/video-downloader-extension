(function initBackgroundChunkAssembly(root, factory) {
  const api = factory();
  root.UVDBackgroundChunkAssembly = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeChunkAssembly() {
  "use strict";

  /** Drop half-finished assemblies whose page never sent FINISH. */
  const STALE_ASSEMBLY_MS = 30 * 60 * 1000;

  function createHandler(deps) {
    const videoAssemblies = new Map();
    /** jobId → assembly id that owns the save for that job */
    const jobClaims = new Map();
    const BlobCtor = deps.Blob || Blob;
    const Uint8ArrayCtor = deps.Uint8Array || Uint8Array;
    const ArrayBufferCtor = deps.ArrayBuffer || ArrayBuffer;
    const atobImpl = deps.atob || (typeof atob === "function" ? atob : null);
    const now = deps.now || Date.now;

    function decodeBase64(text) {
      if (!atobImpl) throw new Error("base64 디코더 없음");
      const binary = atobImpl(String(text || ""));
      const out = new Uint8ArrayCtor(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }

    function toBytes(chunk, encoding) {
      if (encoding === "base64" || typeof chunk === "string") {
        return decodeBase64(chunk);
      }
      if (chunk instanceof ArrayBufferCtor) return new Uint8ArrayCtor(chunk);
      if (chunk instanceof Uint8ArrayCtor) return chunk;
      if (Array.isArray(chunk)) return new Uint8ArrayCtor(chunk);
      // JSON serialization turns ArrayBuffer/typed arrays into {} or an
      // index→byte object. Reject rather than silently assembling 0 bytes.
      if (chunk && typeof chunk === "object") {
        const keys = Object.keys(chunk);
        if (!keys.length) {
          throw new Error(
            "청크가 비어 있습니다 (바이너리가 메시지에서 손실됨 — base64로 보내야 합니다)"
          );
        }
        const out = new Uint8ArrayCtor(keys.length);
        for (let i = 0; i < keys.length; i++) out[i] = chunk[i] & 0xff;
        return out;
      }
      throw new Error("지원하지 않는 청크 형식");
    }

    function dropAssembly(id) {
      const ass = videoAssemblies.get(id);
      videoAssemblies.delete(id);
      if (ass?.jobId && jobClaims.get(ass.jobId) === id) {
        jobClaims.delete(ass.jobId);
      }
    }

    function sweepStale() {
      const cutoff = now() - STALE_ASSEMBLY_MS;
      for (const [id, ass] of videoAssemblies) {
        if ((ass.updatedAt || 0) < cutoff) dropAssembly(id);
      }
    }

    return function handleChunkAssembly(msg, sendResponse) {
      switch (msg?.type) {
        case "VIDEO_CHUNK": {
          try {
            const {
              id,
              jobId,
              index,
              totalChunks,
              totalBytes,
              chunk,
              encoding,
              filename,
              mime
            } = msg;
            if (!id || chunk == null) {
              sendResponse({ ok: false, error: "저장 데이터 오류" });
              return { handled: true, keepChannel: false };
            }
            sweepStale();
            let ass = videoAssemblies.get(id);
            if (!ass) {
              // SMART_DOWNLOAD fans out to every frame in the tab; only the
              // first frame to start saving for a job may finish it.
              if (jobId) {
                const owner = jobClaims.get(jobId);
                if (owner && owner !== id && videoAssemblies.has(owner)) {
                  sendResponse({
                    ok: false,
                    error: "다른 프레임이 이미 이 작업을 저장하고 있습니다",
                    duplicate: true
                  });
                  return { handled: true, keepChannel: false };
                }
                jobClaims.set(jobId, id);
              }
              ass = {
                jobId: jobId || null,
                chunks: new Map(),
                totalChunks: totalChunks || 1,
                totalBytes: totalBytes || 0,
                filename: filename || `영상_${Date.now()}.mp4`,
                mime: mime || "video/mp4",
                updatedAt: now()
              };
              videoAssemblies.set(id, ass);
            }
            ass.chunks.set(index, toBytes(chunk, encoding));
            ass.updatedAt = now();
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          return { handled: true, keepChannel: false };
        }
        case "VIDEO_CHUNK_FINISH": {
          const { id, filename, mime } = msg;
          const ass = videoAssemblies.get(id);
          if (!ass) {
            sendResponse({ ok: false, error: "조립 데이터 없음" });
            return { handled: true, keepChannel: false };
          }
          (async () => {
            try {
              const ordered = [];
              for (let i = 0; i < ass.totalChunks; i++) {
                const c = ass.chunks.get(i);
                if (!c) throw new Error(`청크 누락 ${i}`);
                ordered.push(c);
              }
              let total = 0;
              for (const c of ordered) total += c.byteLength;
              if (ass.totalBytes > 0 && total !== ass.totalBytes) {
                throw new Error(
                  `청크 크기 불일치: ${total}B 수신 / ${ass.totalBytes}B 예상`
                );
              }
              if (total < 100_000) throw new Error("파일이 너무 작습니다");
              const blob = new BlobCtor(ordered, {
                type: mime || ass.mime || "video/mp4"
              });
              const saved = await deps.downloadBlob(
                blob,
                filename || ass.filename
              );
              dropAssembly(id);
              sendResponse({
                ok: true,
                downloadId: saved.downloadId,
                filename: saved.filename,
                path: saved.path,
                size: total
              });
            } catch (e) {
              dropAssembly(id);
              sendResponse({ ok: false, error: String(e.message || e) });
            }
          })();
          return { handled: true, keepChannel: true };
        }
        default:
          return { handled: false, keepChannel: false };
      }
    };
  }

  return { createHandler };
});
