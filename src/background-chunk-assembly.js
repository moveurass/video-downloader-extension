(function initBackgroundChunkAssembly(root, factory) {
  const api = factory();
  root.UVDBackgroundChunkAssembly = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeChunkAssembly() {
  "use strict";

  function createHandler(deps) {
    const videoAssemblies = new Map();
    const BlobCtor = deps.Blob || Blob;
    const Uint8ArrayCtor = deps.Uint8Array || Uint8Array;
    const ArrayBufferCtor = deps.ArrayBuffer || ArrayBuffer;

    return function handleChunkAssembly(msg, sendResponse) {
      switch (msg?.type) {
        case "VIDEO_CHUNK": {
          try {
            const { id, index, totalChunks, totalBytes, chunk, filename, mime } =
              msg;
            if (!id || chunk == null) {
              sendResponse({ ok: false, error: "저장 데이터 오류" });
              return { handled: true, keepChannel: false };
            }
            let ass = videoAssemblies.get(id);
            if (!ass) {
              ass = {
                chunks: new Map(),
                totalChunks: totalChunks || 1,
                totalBytes: totalBytes || 0,
                filename: filename || `영상_${Date.now()}.mp4`,
                mime: mime || "video/mp4"
              };
              videoAssemblies.set(id, ass);
            }
            const u8 =
              chunk instanceof ArrayBufferCtor
                ? new Uint8ArrayCtor(chunk)
                : chunk instanceof Uint8ArrayCtor
                  ? chunk
                  : new Uint8ArrayCtor(chunk);
            ass.chunks.set(index, u8);
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
              if (total < 100_000) throw new Error("파일이 너무 작습니다");
              const merged = new Uint8ArrayCtor(total);
              let off = 0;
              for (const c of ordered) {
                merged.set(c, off);
                off += c.byteLength;
              }
              const blob = new BlobCtor([merged], {
                type: mime || "video/mp4"
              });
              const saved = await deps.downloadBlob(
                blob,
                filename || ass.filename
              );
              videoAssemblies.delete(id);
              sendResponse({
                ok: true,
                downloadId: saved.downloadId,
                filename: saved.filename,
                path: saved.path,
                size: total
              });
            } catch (e) {
              videoAssemblies.delete(id);
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
