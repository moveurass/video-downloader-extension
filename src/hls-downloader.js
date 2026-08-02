/**
 * HLS (.m3u8) playlist parser + segment merger for the service worker.
 * Supports: master playlists, media playlists, AES-128 (EXT-X-KEY), fMP4 init maps.
 * Does NOT support SAMPLE-AES / DRM (Widevine etc.).
 */

const HLS = (() => {
  const MAX_SEGMENTS = 8000;
  const CONCURRENCY = 8;

  function resolveUrl(base, ref) {
    try {
      return new URL(ref, base).href;
    } catch {
      return ref;
    }
  }

  function parseAttributes(line) {
    const attrs = {};
    // KEY=VALUE or KEY="VALUE"
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
    let m;
    while ((m = re.exec(line)) !== null) {
      attrs[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[2];
    }
    return attrs;
  }

  /**
   * @typedef {Object} HlsVariant
   * @property {string} url
   * @property {number} [bandwidth]
   * @property {number} [width]
   * @property {number} [height]
   * @property {string} [codecs]
   * @property {string} [name]
   * @property {string} quality
   */

  /**
   * @typedef {Object} HlsProbe
   * @property {'master'|'media'} kind
   * @property {HlsVariant[]} [variants]
   * @property {number} [segmentCount]
   * @property {number} [duration]
   * @property {boolean} [encrypted]
   * @property {string} [encryptionMethod]
   * @property {boolean} [isFmp4]
   */

  function qualityFromHeight(h) {
    if (!h) return "unknown";
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    if (h >= 240) return "240p";
    return `${h}p`;
  }

  function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
      /** @type {HlsVariant[]} */
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
        const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
        let uri = null;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j] || lines[j].startsWith("#")) continue;
          uri = lines[j];
          break;
        }
        if (!uri) continue;
        let width = 0;
        let height = 0;
        if (attrs.RESOLUTION) {
          const [w, h] = attrs.RESOLUTION.split("x").map(Number);
          width = w || 0;
          height = h || 0;
        }
        // BANDWIDTH = peak (often ~1.5–2× real). AVERAGE-BANDWIDTH ≈ real bitrate.
        const peakBw = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
        const avgBw = parseInt(attrs["AVERAGE-BANDWIDTH"] || "0", 10) || 0;
        const bandwidth = peakBw || avgBw;
        // Prefer average for size estimates; fall back to ~55% of peak if only peak exists
        const estimateBandwidth = avgBw || (peakBw ? Math.round(peakBw * 0.55) : 0);
        variants.push({
          url: resolveUrl(baseUrl, uri),
          bandwidth,
          estimateBandwidth,
          width,
          height,
          codecs: attrs.CODECS,
          name: attrs.NAME || attrs.AUDIO || undefined,
          quality: qualityFromHeight(height)
        });
      }
      variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0) || (b.height || 0) - (a.height || 0));
      return { kind: "master", variants };
    }

    // Media playlist
    const segments = [];
    let duration = 0;
    let encrypted = false;
    let encryptionMethod = null;
    let keyUri = null;
    let keyIv = null;
    let mapUri = null;
    let mediaSequence = 0;
    let isFmp4 = false;
    let segDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) {
          mapUri = resolveUrl(baseUrl, attrs.URI);
          isFmp4 = true;
        }
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
        encryptionMethod = (attrs.METHOD || "NONE").toUpperCase();
        if (encryptionMethod === "NONE") {
          encrypted = false;
          keyUri = null;
          keyIv = null;
        } else {
          encrypted = true;
          keyUri = attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null;
          keyIv = attrs.IV || null;
        }
      } else if (line.startsWith("#EXTINF:")) {
        const d = parseFloat(line.slice(8));
        if (Number.isFinite(d)) {
          segDuration = d;
          duration += d;
        }
      } else if (!line.startsWith("#")) {
        const seq = mediaSequence + segments.length;
        segments.push({
          url: resolveUrl(baseUrl, line),
          duration: segDuration,
          sequence: seq,
          keyUri,
          keyIv,
          encryptionMethod
        });
        segDuration = 0;
      }
    }

    return {
      kind: "media",
      segments,
      duration,
      encrypted,
      encryptionMethod,
      mapUri,
      isFmp4,
      segmentCount: segments.length
    };
  }

  /**
   * Fetch helpers — try credentials modes. Optional requestInit from caller
   * (e.g. page-context vs extension SW).
   */
  async function fetchOnce(url, init = {}, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      return res;
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("요청 시간 초과");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeInit(requestInit = {}) {
    // Extension SW: avoid mode:"cors" (can fail on CDNs). Host permissions bypass CORS.
    const init = { ...requestInit };
    if (init.mode === "cors") delete init.mode;
    return init;
  }

  function errMsg(e) {
    const s = String(e?.message || e || "");
    if (/Failed to fetch|NetworkError|Load failed/i.test(s)) {
      return "네트워크 접근 실패 (CORS/차단)";
    }
    return s;
  }

  async function fetchText(url, headers = {}, requestInit = {}) {
    const base = normalizeInit(requestInit);
    const attempts = [
      { credentials: "include", ...base, headers: { ...headers, ...(base.headers || {}) } },
      { credentials: "omit", ...base, headers: { ...headers, ...(base.headers || {}) } },
      // bare — extension default
      { ...base, headers: { ...headers, ...(base.headers || {}) } }
    ];
    let lastErr;
    for (const init of attempts) {
      try {
        const res = await fetchOnce(url, init, 30000);
        if (!res.ok) {
          lastErr = new Error(`Playlist HTTP ${res.status}`);
          if (res.status === 403 || res.status === 401) {
            lastErr = new Error(`접근 거부 HTTP ${res.status}`);
          }
          if (res.status === 404) break;
          continue;
        }
        const text = await res.text();
        if (text && /<!DOCTYPE|<html/i.test(text.slice(0, 200))) {
          lastErr = new Error("플레이리스트 대신 웹페이지가 반환됨");
          continue;
        }
        if (!text.includes("#EXT")) {
          lastErr = new Error("유효한 m3u8이 아님");
          continue;
        }
        return { text, finalUrl: res.url || url };
      } catch (e) {
        lastErr = new Error(errMsg(e));
      }
    }
    throw lastErr || new Error(`Playlist fetch failed: ${url.slice(0, 80)}`);
  }

  async function fetchBuffer(url, requestInit = {}) {
    const base = normalizeInit(requestInit);
    const attempts = [
      { credentials: "include", ...base },
      { credentials: "omit", ...base },
      { ...base }
    ];
    let lastErr;
    for (const init of attempts) {
      try {
        const res = await fetchOnce(url, init, 45000);
        if (!res.ok) {
          lastErr = new Error(`Segment HTTP ${res.status}`);
          continue;
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        lastErr = new Error(errMsg(e));
      }
    }
    throw lastErr || new Error("Segment fetch failed");
  }

  /**
   * Probe an m3u8 URL — returns variants or segment info.
   */
  async function probe(url) {
    const { text, finalUrl } = await fetchText(url);
    const parsed = parsePlaylist(text, finalUrl);
    if (parsed.kind === "master") {
      return {
        kind: "master",
        variants: parsed.variants,
        url: finalUrl
      };
    }
    return {
      kind: "media",
      segmentCount: parsed.segmentCount,
      duration: parsed.duration,
      encrypted: parsed.encrypted,
      encryptionMethod: parsed.encryptionMethod,
      isFmp4: parsed.isFmp4,
      url: finalUrl
    };
  }

  function pickVariant(variants, preferQuality) {
    if (!variants?.length) return null;
    // Prefer MP4-looking variants (fMP4 / avc1) when quality equal
    const scored = [...variants].sort((a, b) => {
      const mp4 = (v) =>
        /avc1|hvc1|mp4a|fmp4|m4s/i.test(v.codecs || "") ||
        /mp4|fmp4|avc/i.test(v.url || "")
          ? 1
          : 0;
      return (
        mp4(b) - mp4(a) ||
        (b.bandwidth || 0) - (a.bandwidth || 0) ||
        (b.height || 0) - (a.height || 0)
      );
    });

    if (!preferQuality || preferQuality === "best" || preferQuality === "all") {
      return scored[0];
    }
    const order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"];
    const targetIdx = order.indexOf(preferQuality);
    if (targetIdx === -1) return scored[0];

    const exact = scored.find((v) => v.quality === preferQuality);
    if (exact) return exact;

    for (let i = targetIdx; i < order.length; i++) {
      const v = scored.find((x) => x.quality === order[i]);
      if (v) return v;
    }
    for (let i = targetIdx; i >= 0; i--) {
      const v = scored.find((x) => x.quality === order[i]);
      if (v) return v;
    }
    return scored[0];
  }

  function ivFromSequence(seq) {
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    // 64-bit big-endian sequence in last 8 bytes
    view.setUint32(8, Math.floor(seq / 0x100000000), false);
    view.setUint32(12, seq >>> 0, false);
    return iv;
  }

  function parseIv(ivStr, sequence) {
    if (!ivStr) return ivFromSequence(sequence);
    let hex = ivStr.replace(/^0x/i, "");
    if (hex.length < 32) hex = hex.padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  async function decryptAes128(data, keyBytes, iv) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      data
    );
    return new Uint8Array(plain);
  }

  async function mapPool(items, limit, worker, onProgress) {
    const results = new Array(items.length);
    let idx = 0;
    let done = 0;
    async function run() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await worker(items[i], i);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
    await Promise.all(runners);
    return results;
  }

  /**
   * Download HLS stream and merge segments.
   * @param {string} url
   * @param {object} options
   * @param {string} [options.preferQuality]
   * @param {function} [options.onProgress] - ({phase, current, total, message})
   * @returns {Promise<{blob: Blob, filename: string, quality: string, segmentCount: number, duration: number}>}
   */
  async function downloadAndMerge(url, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const requestInit = options.requestInit || {};
    onProgress({ phase: "playlist", current: 0, total: 1, message: "플레이리스트 분석 중…" });

    let { text, finalUrl } = await fetchText(url, {}, requestInit);
    let parsed = parsePlaylist(text, finalUrl);
    let quality = "unknown";
    let mediaUrl = finalUrl;

    if (parsed.kind === "master") {
      const variant = pickVariant(parsed.variants, options.preferQuality);
      if (!variant) throw new Error("마스터 플레이리스트에 변형이 없습니다");
      quality = variant.quality || qualityFromHeight(variant.height);
      onProgress({
        phase: "playlist",
        current: 0,
        total: 1,
        message: `품질 선택: ${quality} (${variant.bandwidth || "?"} bps)`
      });
      const media = await fetchText(variant.url, {}, requestInit);
      text = media.text;
      mediaUrl = media.finalUrl;
      parsed = parsePlaylist(text, mediaUrl);
      if (parsed.kind === "master") {
        throw new Error("중첩 마스터 플레이리스트는 지원하지 않습니다");
      }
    }

    if (parsed.encryptionMethod && !["NONE", "AES-128", null].includes(parsed.encryptionMethod)) {
      if (parsed.encryptionMethod !== "AES-128") {
        // check per-segment later
      }
    }

    // Fail fast on SAMPLE-AES / DRM-like methods
    const methods = new Set(
      (parsed.segments || []).map((s) => s.encryptionMethod).filter(Boolean)
    );
    for (const m of methods) {
      if (m !== "NONE" && m !== "AES-128") {
        throw new Error(`암호화 방식 ${m}은 지원하지 않습니다 (DRM/SAMPLE-AES)`);
      }
    }

    const segments = parsed.segments || [];
    if (!segments.length) throw new Error("세그먼트가 없습니다");
    if (segments.length > MAX_SEGMENTS) {
      throw new Error(`세그먼트가 너무 많습니다 (${segments.length}). 최대 ${MAX_SEGMENTS}`);
    }

    // Prefetch AES keys
    const keyCache = new Map();
    async function getKey(keyUri) {
      if (!keyUri) return null;
      if (keyCache.has(keyUri)) return keyCache.get(keyUri);
      const buf = await fetchBuffer(keyUri, requestInit);
      keyCache.set(keyUri, buf);
      return buf;
    }

    const parts = [];
    if (parsed.mapUri) {
      onProgress({ phase: "init", current: 0, total: 1, message: "초기화 세그먼트…" });
      parts.push(await fetchBuffer(parsed.mapUri, requestInit));
    }

    onProgress({
      phase: "segments",
      current: 0,
      total: segments.length,
      message: `세그먼트 0/${segments.length}`
    });

    const buffers = await mapPool(
      segments,
      CONCURRENCY,
      async (seg) => {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            let data = await fetchBuffer(seg.url, requestInit);
            if (!data || data.byteLength < 32) {
              throw new Error("세그먼트 데이터 없음");
            }
            if (seg.encryptionMethod === "AES-128" && seg.keyUri) {
              const key = await getKey(seg.keyUri);
              const iv = parseIv(seg.keyIv, seg.sequence);
              data = await decryptAes128(data, key, iv);
            }
            return data;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        throw lastErr || new Error("세그먼트 실패: " + (seg.url || "").slice(0, 60));
      },
      (current, total) => {
        onProgress({
          phase: "segments",
          current,
          total,
          message: `세그먼트 ${current}/${total}`
        });
      }
    );

    // Drop any empty results
    for (const b of buffers) {
      if (b && b.byteLength > 0) parts.push(b);
    }

    if (parts.length < 2) {
      throw new Error("유효한 세그먼트가 거의 없습니다");
    }
    // Require at least 80% of segments
    const expected = segments.length + (parsed.mapUri ? 1 : 0);
    if (parts.length < expected * 0.8) {
      throw new Error(
        `세그먼트 부족: ${parts.length}/${expected}개만 성공`
      );
    }

    onProgress({ phase: "merge", current: 1, total: 1, message: "병합 중…" });

    let totalSize = 0;
    for (const p of parts) totalSize += p.byteLength;

    // Real videos are almost never under ~200KB after merge
    if (totalSize < 200_000) {
      throw new Error(
        `병합 결과가 너무 작습니다 (${Math.round(totalSize / 1024)}KB). 재생목록만 받았을 수 있습니다`
      );
    }

    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }

    const isFmp4 = parsed.isFmp4;
    // Always present as MP4 to the user. fMP4 init+m4s is real MP4;
    // MPEG-TS is still saved as .mp4 so players that sniff content can open it
    // (and filenames match user expectation — never .ts).
    const mime = "video/mp4";
    const ext = "mp4";
    const blob = new Blob([merged], { type: mime });
    const qLabel = quality !== "unknown" ? `_${quality}` : "";
    const filename = `video${qLabel}_${Date.now()}.${ext}`;

    onProgress({
      phase: "done",
      current: segments.length,
      total: segments.length,
      message: "병합 완료"
    });

    return {
      blob,
      filename,
      quality,
      segmentCount: parts.length,
      duration: parsed.duration || 0,
      size: totalSize,
      isFmp4: true // user-facing: always treat as mp4 container name
    };
  }

  return {
    probe,
    downloadAndMerge,
    parsePlaylist,
    qualityFromHeight,
    pickVariant
  };
})();
