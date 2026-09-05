/**
 * HLS (.m3u8) playlist parser + segment merger for the service worker.
 * Supports: master playlists, media playlists, AES-128 (EXT-X-KEY), fMP4 init maps.
 * Does NOT support SAMPLE-AES / DRM (Widevine etc.).
 */

const HLS = (() => {
  const MAX_SEGMENTS = 8000;
  /** Default parallel segment fetches — higher for speed (was 6) */
  const CONCURRENCY = 12;
  /** After repeated 403s, drop to this (was 3) */
  const CONCURRENCY_SOFT = 4;
  /** Very large playlists: start a bit lower to avoid opening storms */
  const CONCURRENCY_LARGE = 8;
  /** Adaptive ramp-up ceiling when the CDN accepts parallel fetches cleanly */
  const CONCURRENCY_MAX = 20;
  /** Ramp up by +2 after this many consecutive error-free segments */
  const RAMP_EVERY = 20;

  function resolveUrl(base, ref) {
    try {
      return new URL(ref, base).href;
    } catch {
      return ref;
    }
  }

  /**
   * `#EXT-X-BYTERANGE:<n>[@<o>]` → { offset, length }. When `@o` is omitted the
   * sub-range starts where the previous sub-range of the same resource ended.
   */
  function parseByteRange(value, previousEnd = 0) {
    const m = String(value || "").trim().match(/^(\d+)(?:@(\d+))?$/);
    if (!m) return null;
    const length = parseInt(m[1], 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    const offset = m[2] !== undefined ? parseInt(m[2], 10) : previousEnd;
    return { offset: Number.isFinite(offset) ? offset : 0, length };
  }

  function byteRangeSuffix(byteRange) {
    if (!byteRange) return "";
    return `@${byteRange.offset}+${byteRange.length}`;
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

  /**
   * Guess pixel height from URL / NAME / path tokens.
   * e.g. …/720p/…, …_1080.m3u8, NAME="720", ?quality=720
   */
  function heightFromString(s) {
    const str = String(s || "");
    if (!str) return 0;
    let m = str.match(/(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)/);
    if (m) return parseInt(m[1], 10);
    m = str.match(/(?:^|[^\dA-Za-z])4\s*[kK](?:[^\dA-Za-z]|$)/);
    if (m) return 2160;
    m = str.match(/[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i);
    if (m) return parseInt(m[1], 10);
    m = str.match(
      /[?&](?:quality|res|resolution|h|height|r)=?(2160|1440|1080|720|480|360|240)\b/i
    );
    if (m) return parseInt(m[1], 10);
    // Bare NAME like "720" / "1080"
    m = str.match(/^(2160|1440|1080|720|480|360|240)$/);
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
      const audioRenditions = [];
      for (const line of lines) {
        if (!line.startsWith("#EXT-X-MEDIA:")) continue;
        const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
        if ((attrs.TYPE || "").toUpperCase() !== "AUDIO" || !attrs.URI) continue;
        const url = resolveUrl(baseUrl, attrs.URI);
        const groupId = attrs["GROUP-ID"] || "";
        const name = attrs.NAME || attrs.LANGUAGE || "Audio";
        audioRenditions.push({
          id: `hls-audio:${groupId}:${name}:${url}`,
          url,
          groupId,
          name,
          language: attrs.LANGUAGE || "",
          default: (attrs.DEFAULT || "").toUpperCase() === "YES",
          autoselect: (attrs.AUTOSELECT || "").toUpperCase() === "YES",
          channels: attrs.CHANNELS || ""
        });
      }
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
        const name = attrs.NAME || undefined;
        const resolved = resolveUrl(baseUrl, uri);
        // Many CDNs omit RESOLUTION — recover from NAME or path (/720p/, /1080/)
        if (!height) {
          height =
            heightFromString(name) ||
            heightFromString(uri) ||
            heightFromString(resolved) ||
            0;
        }
        // BANDWIDTH = peak (often ~1.5–2× real). AVERAGE-BANDWIDTH ≈ real bitrate.
        const peakBw = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
        const avgBw = parseInt(attrs["AVERAGE-BANDWIDTH"] || "0", 10) || 0;
        const bandwidth = peakBw || avgBw;
        // Prefer average for size estimates; fall back to ~55% of peak if only peak exists
        const estimateBandwidth = avgBw || (peakBw ? Math.round(peakBw * 0.55) : 0);
        variants.push({
          url: resolved,
          bandwidth,
          estimateBandwidth,
          width,
          height,
          codecs: attrs.CODECS,
          audioGroup: attrs.AUDIO || "",
          name,
          quality: qualityFromHeight(height)
        });
      }
      variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0) || (b.height || 0) - (a.height || 0));
      return { kind: "master", variants, audioRenditions };
    }

    // Media playlist
    const segments = [];
    let duration = 0;
    let encrypted = false;
    let encryptionMethod = null;
    let keyUri = null;
    let keyIv = null;
    let mapUri = null;
    let mapByteRange = null;
    let mediaSequence = 0;
    let isFmp4 = false;
    let segDuration = 0;
    /** Pending #EXT-X-BYTERANGE for the next segment line */
    let pendingByteRange = null;
    /** End offset of the previous sub-range segment (for BYTERANGE without @offset) */
    let lastByteRangeEnd = 0;
    const isLive = !lines.some((line) => line === "#EXT-X-ENDLIST");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingByteRange = parseByteRange(
          line.slice("#EXT-X-BYTERANGE:".length),
          lastByteRangeEnd
        );
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) {
          mapUri = resolveUrl(baseUrl, attrs.URI);
          mapByteRange = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null;
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
        const byteRange = pendingByteRange;
        pendingByteRange = null;
        lastByteRangeEnd = byteRange ? byteRange.offset + byteRange.length : 0;
        segments.push({
          url: resolveUrl(baseUrl, line),
          duration: segDuration,
          sequence: seq,
          byteRange,
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
      mapByteRange,
      isFmp4,
      isLive,
      mediaSequence,
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
    // Merge caller AbortSignal (pause/cancel) with per-request timeout
    const outer = init.signal;
    const onOuterAbort = () => {
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
      outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const { signal: _ignore, ...rest } = init;
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      return res;
    } catch (e) {
      if (e?.name === "AbortError" || /abort/i.test(String(e?.message || ""))) {
        if (outer?.aborted) throw new Error("CANCELLED");
        throw new Error("요청 시간 초과");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) {
        try {
          outer.removeEventListener("abort", onOuterAbort);
        } catch {
          /* ignore */
        }
      }
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

  function headerBag(h) {
    if (!h) return {};
    if (h instanceof Headers) {
      const o = {};
      h.forEach((v, k) => {
        o[k] = v;
      });
      return o;
    }
    return { ...h };
  }

  function refererVariants(pageUrl, segmentUrl) {
    const out = [];
    const push = (r) => {
      if (r && !out.includes(r)) out.push(r);
    };
    push(pageUrl);
    try {
      if (pageUrl) {
        const u = new URL(pageUrl);
        push(u.origin + "/");
        push(u.origin);
      }
    } catch {
      /* ignore */
    }
    try {
      if (segmentUrl) {
        const s = new URL(segmentUrl);
        push(s.origin + "/");
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Build several fetch inits — CDNs often 403 without the right Referer,
   * or reject Origin, or reject concurrent cookie sessions.
   */
  function buildFetchAttempts(url, requestInit = {}, extraHeaders = {}) {
    const base = normalizeInit(requestInit);
    const baseHeaders = { ...headerBag(base.headers), ...headerBag(extraHeaders) };
    const pageUrl =
      baseHeaders.Referer ||
      baseHeaders.referer ||
      base.pageUrl ||
      requestInit.pageUrl ||
      "";
    const refs = refererVariants(pageUrl, url);
    const attempts = [];

    const add = (credentials, headers) => {
      attempts.push({
        ...base,
        credentials,
        cache: "no-store",
        headers: headers || {}
      });
    };

    // 1) credentials + page referer (best for same-site cookies)
    if (refs[0]) {
      add("include", { ...baseHeaders, Referer: refs[0] });
    }
    // 2) credentials + origin-only referer
    if (refs[1]) {
      add("include", { ...baseHeaders, Referer: refs[1] });
    }
    // 3) omit cookies + page referer (some CDNs reject cookie mismatch)
    if (refs[0]) {
      add("omit", { Referer: refs[0] });
    }
    // 4) omit + segment origin as referer
    if (refs.length > 2) {
      add("omit", { Referer: refs[refs.length - 1] });
    }
    // 5) bare include / omit as last resort
    add("include", { ...baseHeaders });
    add("omit", {});
    add("same-origin", refs[0] ? { Referer: refs[0] } : {});

    return attempts;
  }

  async function fetchText(url, headers = {}, requestInit = {}) {
    const attempts = buildFetchAttempts(url, requestInit, headers);
    let lastErr;
    for (const init of attempts) {
      try {
        const res = await fetchOnce(url, init, 30000);
        if (!res.ok) {
          lastErr = new Error(`Playlist HTTP ${res.status}`);
          if (res.status === 403 || res.status === 401) {
            lastErr = new Error(
              `접근 거부 HTTP ${res.status} — 영상을 재생한 직후 다시 시도해 주세요`
            );
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

  /**
   * @param {string} url
   * @param {object} [requestInit]
   * @param {{offset:number,length:number}|null} [byteRange] EXT-X-BYTERANGE sub-range
   */
  async function fetchBuffer(url, requestInit = {}, byteRange = null) {
    const attempts = buildFetchAttempts(url, requestInit);
    let lastErr;
    let saw403 = false;
    for (let i = 0; i < attempts.length; i++) {
      let init = attempts[i];
      if (byteRange) {
        init = {
          ...init,
          headers: {
            ...headerBag(init.headers),
            Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`
          }
        };
      }
      try {
        // Small stagger reduces burst 403s on hotlink-protected CDNs
        if (i > 0 && saw403) {
          await new Promise((r) => setTimeout(r, 250 * i));
        }
        const res = await fetchOnce(url, init, 45000);
        if (!res.ok) {
          if (res.status === 403 || res.status === 401) {
            saw403 = true;
            lastErr = new Error(`Segment HTTP ${res.status}`);
            continue;
          }
          lastErr = new Error(`Segment HTTP ${res.status}`);
          if (res.status === 404) break;
          continue;
        }
        let buf = new Uint8Array(await res.arrayBuffer());
        if (byteRange) {
          if (res.status === 206) {
            if (buf.byteLength !== byteRange.length) {
              lastErr = new Error(
                `세그먼트 범위 응답 크기 불일치 (${buf.byteLength}/${byteRange.length})`
              );
              continue;
            }
          } else {
            // Server ignored Range and returned the whole resource — cut it here
            // rather than concatenating the entire file once per segment.
            if (buf.byteLength < byteRange.offset + byteRange.length) {
              lastErr = new Error("서버가 세그먼트 바이트 범위를 지원하지 않습니다");
              continue;
            }
            buf = buf.slice(byteRange.offset, byteRange.offset + byteRange.length);
          }
        }
        if (buf.byteLength < 16) {
          lastErr = new Error("세그먼트 데이터 없음");
          continue;
        }
        return buf;
      } catch (e) {
        lastErr = new Error(errMsg(e));
      }
    }
    if (saw403) {
      throw new Error(
        "Segment HTTP 403 — CDN이 접근을 막았습니다. 페이지에서 영상을 재생한 뒤 바로 다시 받아 주세요"
      );
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
        audioRenditions: parsed.audioRenditions || [],
        url: finalUrl
      };
    }
    // Infer height from playlist URL + first few segment paths (…/720/seg.ts)
    const sampleUrls = (parsed.segments || [])
      .slice(0, 8)
      .map((s) => s.url)
      .filter(Boolean);
    if (parsed.mapUri) sampleUrls.unshift(parsed.mapUri);
    let inferredHeight =
      heightFromString(finalUrl) || heightFromString(url) || 0;
    if (!inferredHeight) {
      for (const u of sampleUrls) {
        inferredHeight = heightFromString(u);
        if (inferredHeight) break;
      }
    }
    return {
      kind: "media",
      segmentCount: parsed.segmentCount,
      duration: parsed.duration,
      encrypted: parsed.encrypted,
      encryptionMethod: parsed.encryptionMethod,
      isFmp4: parsed.isFmp4,
      isLive: parsed.isLive,
      mediaSequence: parsed.mediaSequence,
      url: finalUrl,
      sampleUrls,
      inferredHeight: inferredHeight || 0
    };
  }

  /** Typical HLS media-segment payload when EXT-X-BITRATE is absent. */
  const SEGMENT_BYTE_ESTIMATE = 220_000;

  /**
   * Approximate media-playlist capacity from duration × bitrate, or segment count.
   * Used by LIST_QUALITIES / maybeProbeHls so the popup does not keep a 30s
   * preview estimate after a longer feature playlist wins ranking.
   */
  function estimateMediaBytes(info = {}) {
    const duration = Number(info.duration) || 0;
    const segmentCount = Number(info.segmentCount) || 0;
    const bandwidth =
      Number(info.estimateBandwidth || info.bandwidth) || 0;
    const height = Number(info.height || info.inferredHeight) || 0;
    if (bandwidth > 0 && duration >= 1) {
      return Math.round((bandwidth / 8) * duration);
    }
    if (segmentCount > 5) {
      return segmentCount * SEGMENT_BYTE_ESTIMATE;
    }
    if (duration >= 1) {
      const rate =
        height >= 1080
          ? 5_000_000
          : height >= 720
            ? 2_500_000
            : height >= 480
              ? 1_000_000
              : 700_000;
      return Math.round((rate / 8) * duration);
    }
    return 0;
  }

  /** Rough height when the master omits RESOLUTION (same thresholds as the popup) */
  function heightFromBandwidth(value) {
    const bandwidth = Number(value) || 0;
    if (bandwidth >= 8_000_000) return 2160;
    if (bandwidth >= 4_000_000) return 1440;
    if (bandwidth >= 2_000_000) return 1080;
    if (bandwidth >= 1_000_000) return 720;
    if (bandwidth >= 500_000) return 480;
    if (bandwidth >= 250_000) return 360;
    return bandwidth > 0 ? 240 : 0;
  }

  /** Height/label the popup advertises for a variant — must be what we match on. */
  function variantHeight(v) {
    return (
      (v.height || 0) ||
      heightFromBandwidth(v.estimateBandwidth || v.bandwidth || 0)
    );
  }

  function variantLabel(v) {
    if (v.quality && v.quality !== "unknown") return v.quality;
    return qualityFromHeight(variantHeight(v));
  }

  function pickVariant(variants, preferQuality) {
    if (!variants?.length) return null;
    const mp4 = (v) =>
      /avc1|hvc1|hev1|av01|mp4a|fmp4|m4s/i.test(v.codecs || "") ||
      /mp4|fmp4|avc/i.test(v.url || "")
        ? 1
        : 0;
    // Resolution first; MP4-looking variants only break ties within the same
    // height (codec taste must never pick 720p over 4K for "best").
    const scored = [...variants].sort(
      (a, b) =>
        variantHeight(b) - variantHeight(a) ||
        mp4(b) - mp4(a) ||
        (b.bandwidth || 0) - (a.bandwidth || 0)
    );

    if (!preferQuality || preferQuality === "best" || preferQuality === "all") {
      return scored[0];
    }

    const exact = scored.find((v) => variantLabel(v) === preferQuality);
    if (exact) return exact;

    const order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"];
    const targetIdx = order.indexOf(preferQuality);
    if (targetIdx === -1) return scored[0];

    for (let i = targetIdx; i < order.length; i++) {
      const v = scored.find((x) => variantLabel(x) === order[i]);
      if (v) return v;
    }
    for (let i = targetIdx; i >= 0; i--) {
      const v = scored.find((x) => variantLabel(x) === order[i]);
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

  function segmentIdentity(segment) {
    if (!segment) return "";
    return `${Number(segment.sequence)}:${segment.url || ""}${byteRangeSuffix(segment.byteRange)}`;
  }

  function tsPid(packet) {
    return ((packet[1] & 0x1f) << 8) | packet[2];
  }

  function tsSection(packet, expectedTableId) {
    if (
      packet?.byteLength !== 188 ||
      packet[0] !== 0x47 ||
      !(packet[1] & 0x40)
    ) {
      return null;
    }
    const adaptation = (packet[3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) return null;
    let offset = 4;
    if (adaptation === 3) offset += 1 + packet[offset];
    if (offset >= 188) return null;
    offset += 1 + packet[offset];
    if (offset + 3 > 188 || packet[offset] !== expectedTableId) return null;
    const length = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2];
    const end = offset + 3 + length;
    if (end > 188) return null;
    return { offset, bytes: packet.slice(offset, end) };
  }

  function pmtPidFromPat(packet) {
    const section = tsSection(packet, 0x00)?.bytes;
    if (!section) return -1;
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
      const program = (section[offset] << 8) | section[offset + 1];
      if (program !== 0) {
        return ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
      }
    }
    return -1;
  }

  function pmtStreams(section) {
    if (!section || section[0] !== 0x02 || section.length < 16) return [];
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    const end = section.length - 4;
    const streams = [];
    for (let offset = 12 + programInfoLength; offset + 5 <= end; ) {
      const infoLength =
        ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
      const length = 5 + infoLength;
      if (offset + length > end) return [];
      streams.push({
        pid: ((section[offset + 1] & 0x1f) << 8) | section[offset + 2],
        bytes: section.slice(offset, offset + length)
      });
      offset += length;
    }
    return streams;
  }

  function mpegCrc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) {
        crc =
          crc & 0x80000000
            ? ((crc << 1) ^ 0x04c11db7) >>> 0
            : (crc << 1) >>> 0;
      }
    }
    return crc >>> 0;
  }

  function mergedPmt(videoSection, audioStreams, pidMap) {
    const body = videoSection.slice(0, -4);
    const appended = audioStreams.map((stream) => {
      const bytes = stream.bytes.slice();
      const pid = pidMap.get(stream.pid);
      bytes[1] = (bytes[1] & 0xe0) | ((pid >> 8) & 0x1f);
      bytes[2] = pid & 0xff;
      return bytes;
    });
    const size =
      body.length + appended.reduce((total, bytes) => total + bytes.length, 0) + 4;
    const output = new Uint8Array(size);
    output.set(body);
    let offset = body.length;
    for (const bytes of appended) {
      output.set(bytes, offset);
      offset += bytes.length;
    }
    const sectionLength = size - 3;
    output[1] = (output[1] & 0xf0) | ((sectionLength >> 8) & 0x0f);
    output[2] = sectionLength & 0xff;
    const crc = mpegCrc32(output.subarray(0, size - 4));
    output[size - 4] = (crc >>> 24) & 0xff;
    output[size - 3] = (crc >>> 16) & 0xff;
    output[size - 2] = (crc >>> 8) & 0xff;
    output[size - 1] = crc & 0xff;
    return output;
  }

  /**
   * Mux aligned MPEG-TS renditions without transcoding. Audio elementary PIDs
   * are remapped and appended to the video's PMT; merely concatenating the two
   * transport streams would advertise conflicting programs and is not valid.
   */
  function interleaveTs(video, audio) {
    const packetSize = 188;
    const packets = (data) => {
      if (
        !data?.byteLength ||
        data.byteLength % packetSize !== 0 ||
        data[0] !== 0x47
      ) {
        throw new Error(
          "선택한 HLS 오디오는 MPEG-TS 형식이 아니어서 브라우저에서 병합할 수 없습니다"
        );
      }
      return Array.from(
        { length: data.byteLength / packetSize },
        (_, index) => data.slice(index * packetSize, (index + 1) * packetSize)
      );
    };
    const videoPackets = packets(video);
    const audioPackets = packets(audio);
    const videoPmtPid = videoPackets
      .map(pmtPidFromPat)
      .find((pid) => pid >= 0);
    const audioPmtPid = audioPackets
      .map(pmtPidFromPat)
      .find((pid) => pid >= 0);
    const videoPmtPacket = videoPackets.find(
      (packet) => tsPid(packet) === videoPmtPid && tsSection(packet, 0x02)
    );
    const audioPmtPacket = audioPackets.find(
      (packet) => tsPid(packet) === audioPmtPid && tsSection(packet, 0x02)
    );
    const videoPmt = tsSection(videoPmtPacket, 0x02);
    const audioPmt = tsSection(audioPmtPacket, 0x02);
    const audioStreams = pmtStreams(audioPmt?.bytes);
    if (!videoPmt || !audioPmt || !audioStreams.length) {
      throw new Error("HLS MPEG-TS 프로그램 정보를 읽을 수 없어 대체 오디오를 병합할 수 없습니다");
    }
    const occupied = new Set([
      0,
      videoPmtPid,
      ...pmtStreams(videoPmt.bytes).map((stream) => stream.pid)
    ]);
    const pidMap = new Map();
    let nextPid = 0x1e00;
    for (const stream of audioStreams) {
      while (occupied.has(nextPid) && nextPid < 0x1fff) nextPid += 1;
      if (nextPid >= 0x1fff) throw new Error("HLS 오디오 PID를 할당할 수 없습니다");
      pidMap.set(stream.pid, nextPid);
      occupied.add(nextPid);
      nextPid += 1;
    }
    const pmt = mergedPmt(videoPmt.bytes, audioStreams, pidMap);
    const rewrittenVideo = videoPackets.map((packet) => {
      if (tsPid(packet) !== videoPmtPid) return packet;
      const section = tsSection(packet, 0x02);
      if (!section) return packet;
      if (section.offset + pmt.length > packetSize) {
        throw new Error("HLS PMT가 커서 브라우저에서 대체 오디오를 병합할 수 없습니다");
      }
      const next = packet.slice();
      next.fill(0xff, section.offset);
      next.set(pmt, section.offset);
      return next;
    });
    const rewrittenAudio = audioPackets
      .filter((packet) => pidMap.has(tsPid(packet)))
      .map((packet) => {
        const next = packet.slice();
        const pid = pidMap.get(tsPid(packet));
        next[1] = (next[1] & 0xe0) | ((pid >> 8) & 0x1f);
        next[2] = pid & 0xff;
        return next;
      });
    if (!rewrittenAudio.length) {
      throw new Error("선택한 HLS 오디오 조각에 미디어 패킷이 없습니다");
    }
    const output = new Uint8Array(
      (rewrittenVideo.length + rewrittenAudio.length) * packetSize
    );
    let outputOffset = 0;
    let videoOffset = 0;
    let audioOffset = 0;
    while (
      videoOffset < rewrittenVideo.length ||
      audioOffset < rewrittenAudio.length
    ) {
      if (videoOffset < rewrittenVideo.length) {
        output.set(rewrittenVideo[videoOffset++], outputOffset);
        outputOffset += packetSize;
      }
      if (audioOffset < rewrittenAudio.length) {
        output.set(rewrittenAudio[audioOffset++], outputOffset);
        outputOffset += packetSize;
      }
    }
    return output;
  }

  /**
   * Parallel pool with mutable concurrency (for 403 backoff mid-download).
   * @param {object} [ctl] optional { getLimit: () => number }
   */
  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${Math.max(0, Math.round(b))}B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
    if (b < 1024 * 1024 * 1024) {
      const mb = b / (1024 * 1024);
      return mb < 10 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
    }
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }

  /** Human size progress: "125MB / 약 800MB" */
  function formatSizeProgress(received, total) {
    const r = Math.max(0, Number(received) || 0);
    const t = Math.max(0, Number(total) || 0);
    if (r <= 0 && t <= 0) return "받는 중…";
    if (t > 0 && t >= r) return `받는 중… ${formatBytes(r)} / 약 ${formatBytes(t)}`;
    if (r > 0) return `받는 중… ${formatBytes(r)}`;
    return `받는 중… 약 ${formatBytes(t)}`;
  }

  async function mapPool(items, limit, worker, onProgress, ctl = null) {
    const results = new Array(items.length);
    let next = 0;
    let completed = 0;
    let active = 0;
    let stopped = false;
    /** @type {Array<() => void>} */
    const waiters = [];
    const shouldStop = ctl?.shouldStop || null;

    const getLimit = () => {
      const n = ctl?.getLimit ? ctl.getLimit() : limit;
      return Math.max(1, Math.min(items.length, n | 0));
    };

    const notify = () => {
      while (waiters.length && active < getLimit()) {
        const w = waiters.shift();
        if (w) w();
      }
    };

    async function acquire() {
      while (active >= getLimit()) {
        await new Promise((r) => waiters.push(r));
      }
      active += 1;
    }

    function release() {
      active -= 1;
      notify();
    }

    function checkStop() {
      if (stopped) {
        const e = new Error("CANCELLED");
        e.code = "CANCELLED";
        throw e;
      }
      if (shouldStop) {
        try {
          shouldStop();
        } catch (e) {
          stopped = true;
          // Wake waiters so workers can exit
          while (waiters.length) {
            const w = waiters.shift();
            if (w) w();
          }
          throw e;
        }
      }
    }

    async function runWorker() {
      for (;;) {
        checkStop();
        const i = next++;
        if (i >= items.length) return;
        await acquire();
        try {
          checkStop();
          results[i] = await worker(items[i], i);
        } finally {
          release();
          completed += 1;
          // Pass last result so callers can accumulate bytes
          if (onProgress && !stopped) {
            try {
              onProgress(completed, items.length, results[i]);
            } catch (e) {
              // Progress callback may throw PAUSED/CANCELLED
              stopped = true;
              throw e;
            }
          }
        }
      }
    }

    // Launch workers up to the maximum possible limit so the pool can ramp UP
    // mid-download; acquire() gates them to the current dynamic limit.
    const maxLimit = Math.max(
      getLimit(),
      ctl?.getMaxLimit ? ctl.getMaxLimit() | 0 : 0
    );
    const starters = Math.min(Math.max(maxLimit, 1), items.length);
    try {
      await Promise.all(Array.from({ length: starters }, () => runWorker()));
    } catch (e) {
      stopped = true;
      throw e;
    }
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
    const pageUrl = options.pageUrl || options.referer || "";
    const signal = options.signal || null;
    const shouldStop =
      options.shouldStop ||
      (() => {
        if (signal?.aborted) {
          const e = new Error("CANCELLED");
          e.code = "CANCELLED";
          throw e;
        }
      });
    // Always attach Referer so segment CDNs accept hotlink-protected streams
    const requestInit = {
      ...(options.requestInit || {}),
      pageUrl,
      signal: signal || options.requestInit?.signal,
      headers: {
        ...headerBag(options.requestInit?.headers),
        ...(pageUrl ? { Referer: pageUrl } : {})
      }
    };
    // Fail fast if already cancelled
    shouldStop();
    onProgress({ phase: "playlist", current: 0, total: 1, message: "플레이리스트 분석 중…" });

    let { text, finalUrl } = await fetchText(url, {}, requestInit);
    let parsed = parsePlaylist(text, finalUrl);
    let quality = "unknown";
    let mediaUrl = finalUrl;
    let audioParsed = null;
    let selectedAudio = null;

    /** Bandwidth of selected variant — used to estimate total size */
    let variantBandwidth = 0;
    if (parsed.kind === "master") {
      const master = parsed;
      const variant = pickVariant(parsed.variants, options.preferQuality);
      if (!variant) throw new Error("마스터 플레이리스트에 변형이 없습니다");
      quality = variant.quality || qualityFromHeight(variant.height);
      variantBandwidth =
        Number(variant.estimateBandwidth || variant.bandwidth || 0) || 0;
      onProgress({
        phase: "playlist",
        current: 0,
        total: 1,
        message: `품질 선택: ${quality}`
      });
      const media = await fetchText(variant.url, {}, requestInit);
      text = media.text;
      mediaUrl = media.finalUrl;
      parsed = parsePlaylist(text, mediaUrl);
      if (parsed.kind === "master") {
        throw new Error("중첩 마스터 플레이리스트는 지원하지 않습니다");
      }
      if (options.audioTrackId) {
        const requestedAudio = (master.audioRenditions || []).find(
          (track) => track.id === options.audioTrackId
        );
        selectedAudio = (master.audioRenditions || []).find(
          (track) =>
            track.groupId === variant.audioGroup &&
            (track.id === options.audioTrackId ||
              (requestedAudio &&
                track.name === requestedAudio.name &&
                track.language === requestedAudio.language))
        );
        if (!selectedAudio) {
          throw new Error("선택한 HLS 오디오 트랙을 이 화질에서 찾을 수 없습니다");
        }
        const audioMedia = await fetchText(selectedAudio.url, {}, requestInit);
        audioParsed = parsePlaylist(audioMedia.text, audioMedia.finalUrl);
        if (audioParsed.kind !== "media" || !audioParsed.segments?.length) {
          throw new Error("선택한 HLS 오디오 재생목록에 조각이 없습니다");
        }
        if (parsed.isFmp4 || audioParsed.isFmp4) {
          throw new Error(
            "fMP4 HLS 대체 오디오는 브라우저에서 안전하게 병합할 수 없어 로컬 도우미가 필요합니다"
          );
        }
        if (audioParsed.segments.length !== parsed.segments.length) {
          throw new Error("HLS 영상과 오디오 조각이 정렬되지 않아 안전하게 병합할 수 없습니다");
        }
        if (
          Math.abs((audioParsed.duration || 0) - (parsed.duration || 0)) > 1 ||
          ((parsed.isLive || audioParsed.isLive) &&
            (parsed.isLive !== audioParsed.isLive ||
              parsed.mediaSequence !== audioParsed.mediaSequence))
        ) {
          throw new Error("HLS 영상과 오디오 타임라인이 달라 안전하게 병합할 수 없습니다");
        }
      }
    }

    if (parsed.encryptionMethod && !["NONE", "AES-128", null].includes(parsed.encryptionMethod)) {
      if (parsed.encryptionMethod !== "AES-128") {
        // check per-segment later
      }
    }

    // Fail fast on SAMPLE-AES / DRM-like methods
    const methods = new Set(
      [...(parsed.segments || []), ...(audioParsed?.segments || [])]
        .map((s) => s.encryptionMethod)
        .filter(Boolean)
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

    // Streaming sink: when provided, each finished segment is handed off
    // immediately (ordered by part index) and NOT retained in memory here.
    // Cuts peak RAM from ~file size to ~concurrency × segment size and
    // overlaps disk writes with network instead of one giant write at the end.
    const streamOut =
      typeof options.onSegmentData === "function" ? options.onSegmentData : null;
    const resumeParts =
      options.resumeParts instanceof Map ? options.resumeParts : new Map();
    let streamedCount = 0;
    let streamedBytes = 0;

    const parts = [];
    let bytesReceived = 0;
    // Meta estimate: bandwidth(bits/s) * duration → bytes
    const metaEst =
      parsed.duration > 0 && variantBandwidth > 0
        ? Math.round((variantBandwidth / 8) * parsed.duration)
        : 0;
    // Sample-based estimate refined as segments arrive
    let sampleBytes = 0;
    let sampleCount = 0;

    if (parsed.mapUri) {
      onProgress({ phase: "init", current: 0, total: 1, message: "초기화 중…" });
      try {
        const cachedInit = resumeParts.get(0);
        const initIdentity = `init:${parsed.mapUri}${byteRangeSuffix(parsed.mapByteRange)}`;
        const reuseInit =
          streamOut &&
          cachedInit?.size > 0 &&
          (cachedInit.sourceId === initIdentity ||
            (!parsed.isLive &&
              !parsed.mapByteRange &&
              cachedInit.sourceUrl === parsed.mapUri));
        if (reuseInit) {
          streamedCount += 1;
          streamedBytes += cachedInit.size;
          bytesReceived += cachedInit.size;
          sampleBytes += cachedInit.size;
          sampleCount += 1;
        } else {
          const initBuf = await fetchBuffer(
            parsed.mapUri,
            requestInit,
            parsed.mapByteRange
          );
          if (streamOut) {
            await streamOut(0, initBuf, {
              sourceUrl: parsed.mapUri,
              sourceId: initIdentity
            });
            if (initBuf?.byteLength) {
              streamedCount += 1;
              streamedBytes += initBuf.byteLength;
            }
          } else {
            parts.push(initBuf);
          }
          if (initBuf?.byteLength) {
            bytesReceived += initBuf.byteLength;
            sampleBytes += initBuf.byteLength;
            sampleCount += 1;
          }
        }
      } catch (e) {
        throw new Error(
          /403|401|접근 거부/i.test(String(e?.message || e))
            ? "초기 세그먼트 접근 거부(403). 페이지에서 재생 후 바로 다시 받아 주세요"
            : String(e?.message || e)
        );
      }
    }

    const estTotal = () => {
      const fromSample =
        sampleCount > 0
          ? Math.round((sampleBytes / sampleCount) * segments.length)
          : 0;
      // Prefer the larger of meta vs sample once we have a few samples
      if (sampleCount >= 3 && fromSample > 0) {
        if (metaEst > 0) {
          // Blend: sample is more accurate mid-download
          return Math.round(fromSample * 0.7 + metaEst * 0.3);
        }
        return fromSample;
      }
      return metaEst || fromSample || 0;
    };

    // Displayed total is sticky: the raw estimate is recomputed per segment and
    // wobbles a few % each tick, which made "약 800MB" bounce in the UI.
    let shownTotal = 0;
    const estTotalDisplay = () => {
      const t = estTotal();
      // Asymmetric hysteresis: growing is fine (honest correction upward),
      // but only shrink on big drops — small downward re-estimates read as
      // the total "bouncing" in the UI.
      if (
        !shownTotal ||
        t > shownTotal * 1.08 ||
        t < shownTotal * 0.8 ||
        bytesReceived > shownTotal
      ) {
        shownTotal = Math.max(t, bytesReceived);
      }
      return shownTotal;
    };

    onProgress({
      phase: "segments",
      current: 0,
      total: segments.length,
      bytesReceived,
      bytesTotal: estTotalDisplay(),
      message: formatSizeProgress(bytesReceived, estTotalDisplay())
    });

    // Adaptive concurrency: start fast, drop when CDN 403s pile up
    const wantFast = options.speedProfile !== "safe" && options.speedProfile !== "slow";
    let concurrency = !wantFast
      ? CONCURRENCY_SOFT
      : segments.length > 400
        ? CONCURRENCY_LARGE
        : segments.length > 200
          ? Math.max(CONCURRENCY_LARGE, 10)
          : CONCURRENCY;
    let hard403 = 0;
    /** Error-free completions since the last concurrency change (ramp-up) */
    let cleanStreak = 0;
    const softFail = options.allowPartial !== false;
    const poolCtl = {
      getLimit: () => concurrency,
      getMaxLimit: () => (wantFast ? CONCURRENCY_MAX : CONCURRENCY_SOFT),
      shouldStop
    };

    const buffers = await mapPool(
      segments,
      concurrency,
      async (seg, index) => {
        shouldStop();
        const partIndex = index + 1;
        const audioSegment = audioParsed?.segments?.[index] || null;
        const sourceId = audioSegment
          ? `${segmentIdentity(seg)}|${segmentIdentity(audioSegment)}`
          : segmentIdentity(seg);
        const cached = resumeParts.get(partIndex);
        if (
          streamOut &&
          cached?.size > 0 &&
          (cached.sourceId === sourceId ||
            (!parsed.isLive &&
              !audioParsed?.isLive &&
              !audioSegment &&
              // URL-only legacy checkpoints are ambiguous for byte-range
              // segments (every segment shares one URL).
              !seg.byteRange &&
              cached.sourceUrl === seg.url))
        ) {
          return { byteLength: cached.size, resumed: true };
        }
        let lastErr;
        // Up to 4 attempts with backoff; first 403s trigger slower mode
        for (let attempt = 0; attempt < 4; attempt++) {
          shouldStop();
          try {
            if (hard403 > 3 && attempt === 0) {
              // Space out after many 403s
              await new Promise((r) => setTimeout(r, 60 + (index % 5) * 30));
            }
            let data = await fetchBuffer(seg.url, requestInit, seg.byteRange);
            if (!data || data.byteLength < 32) {
              throw new Error("세그먼트 데이터 없음");
            }
            if (seg.encryptionMethod === "AES-128" && seg.keyUri) {
              const key = await getKey(seg.keyUri);
              const iv = parseIv(seg.keyIv, seg.sequence);
              data = await decryptAes128(data, key, iv);
            }
            if (audioSegment) {
              let audioData = await fetchBuffer(
                audioSegment.url,
                requestInit,
                audioSegment.byteRange
              );
              if (audioSegment.encryptionMethod === "AES-128" && audioSegment.keyUri) {
                const audioKey = await getKey(audioSegment.keyUri);
                const audioIv = parseIv(
                  audioSegment.keyIv,
                  audioSegment.sequence
                );
                audioData = await decryptAes128(audioData, audioKey, audioIv);
              }
              data = interleaveTs(data, audioData);
            }
            if (streamOut) {
              // Part 0 is reserved for the init segment (mapUri)
              await streamOut(partIndex, data, {
                sourceUrl: seg.url,
                sourceId
              });
              return { byteLength: data.byteLength };
            }
            return data;
          } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e);
            if (/403|401|접근 거부/i.test(msg)) {
              hard403 += 1;
              // Dynamically reduce parallel fetches when CDN pushes back
              if (hard403 >= 2 && concurrency > CONCURRENCY_SOFT) {
                concurrency = CONCURRENCY_SOFT;
              } else if (hard403 >= 8 && concurrency > 2) {
                concurrency = 2;
              }
              await new Promise((r) =>
                setTimeout(r, 400 * (attempt + 1) + Math.random() * 250)
              );
            } else {
              await new Promise((r) => setTimeout(r, 280 * (attempt + 1)));
            }
          }
        }
        // Soft-fail individual segment if enough others succeed (caller checks ratio)
        if (softFail && hard403 > 0) {
          console.warn("[HLS] segment skip after 403:", (seg.url || "").slice(0, 80));
          return null;
        }
        throw lastErr || new Error("세그먼트 실패: " + (seg.url || "").slice(0, 60));
      },
      (current, total, lastResult) => {
        if (lastResult && lastResult.byteLength > 0) {
          bytesReceived += lastResult.byteLength;
          sampleBytes += lastResult.byteLength;
          sampleCount += 1;
        }
        // Adaptive ramp-UP: CDNs that never 403 usually tolerate more parallel
        // fetches. Increase gently; any 403 resets the streak (and the existing
        // back-off above lowers the limit again).
        if (wantFast && hard403 === 0 && concurrency < CONCURRENCY_MAX) {
          cleanStreak += 1;
          if (cleanStreak >= RAMP_EVERY) {
            cleanStreak = 0;
            concurrency = Math.min(CONCURRENCY_MAX, concurrency + 2);
          }
        } else if (hard403 > 0) {
          cleanStreak = 0;
        }
        const totalEst = estTotalDisplay();
        let message = formatSizeProgress(bytesReceived, totalEst);
        if (hard403 > 5) {
          message += " · 제한 대응";
        }
        onProgress({
          phase: "segments",
          current,
          total,
          bytesReceived,
          bytesTotal: totalEst,
          message
        });
      },
      poolCtl
    );

    // Drop empty / failed
    let okCount = 0;
    let totalSize = 0;
    if (streamOut) {
      for (const b of buffers) {
        if (b && b.byteLength > 0) {
          streamedCount += 1;
          streamedBytes += b.byteLength;
        }
      }
      okCount = streamedCount;
      totalSize = streamedBytes;
    } else {
      for (const b of buffers) {
        if (b && b.byteLength > 0) parts.push(b);
      }
      okCount = parts.length;
      for (const p of parts) totalSize += p.byteLength;
    }

    const expected = segments.length + (parsed.mapUri ? 1 : 0);

    if (okCount < 2) {
      throw new Error(
        hard403 > 0
          ? "Segment HTTP 403 — 거의 모든 조각이 차단되었습니다. 영상을 재생한 직후 다시 받아 주세요"
          : "유효한 세그먼트가 거의 없습니다"
      );
    }
    // Require at least 70% (was 80%) — short gaps are often tolerable
    const minRatio = hard403 > 0 ? 0.7 : 0.8;
    if (okCount < expected * minRatio) {
      throw new Error(
        hard403 > 0
          ? `Segment HTTP 403 — 조각 ${okCount}/${expected}개만 성공. 재생 후 바로 다시 시도해 주세요`
          : `세그먼트 부족: ${okCount}/${expected}개만 성공`
      );
    }

    // Real videos are almost never under ~200KB after merge
    if (totalSize < 200_000) {
      throw new Error(
        `병합 결과가 너무 작습니다 (${Math.round(totalSize / 1024)}KB). 재생목록만 받았을 수 있습니다`
      );
    }

    onProgress({
      phase: "merge",
      current: 0,
      total: okCount,
      message: "파일 만드는 중…"
    });

    // Always present as MP4 to the user. fMP4 init+m4s is real MP4;
    // MPEG-TS is still saved as .mp4 so players that sniff content can open it
    // (and filenames match user expectation — never .ts).
    const mime = "video/mp4";
    const ext = "mp4";
    // Blob from the part list directly — no full-size Uint8Array concat.
    // (Blob references parts lazily; saves one whole-file RAM copy.)
    const blob = streamOut ? null : new Blob(parts, { type: mime });
    const qLabel = quality !== "unknown" ? `_${quality}` : "";
    const filename = `video${qLabel}_${Date.now()}.${ext}`;

    onProgress({
      phase: "merge",
      current: okCount,
      total: okCount,
      message: "파일 만들기 완료"
    });

    return {
      blob,
      streamed: !!streamOut,
      filename,
      quality,
      segmentCount: okCount,
      expectedSegments: expected,
      skippedSegments: Math.max(0, expected - okCount),
      // Soft-failed segments were dropped; callers must surface this instead
      // of reporting an ordinary "저장 완료".
      partial: okCount < expected,
      duration: parsed.duration || 0,
      size: totalSize,
      audioTrackId: selectedAudio?.id || "",
      isFmp4: true // user-facing: always treat as mp4 container name
    };
  }

  return {
    probe,
    downloadAndMerge,
    parsePlaylist,
    qualityFromHeight,
    heightFromString,
    heightFromBandwidth,
    estimateMediaBytes,
    pickVariant,
    parseByteRange,
    segmentIdentity,
    interleaveTs
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.HLS = HLS;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = HLS;
}
