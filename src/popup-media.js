(function initPopupMedia(root, factory) {
  const api = factory();
  root.UVDPopupMedia = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makePopupMedia() {
  "use strict";

  function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 1) return null;
    const s = Math.floor(value % 60);
    const m = Math.floor(value / 60) % 60;
    const h = Math.floor(value / 3600);
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatKind(item = {}) {
    return item.type === "audio" || String(item.mime || "").startsWith("audio/")
      ? { label: "오디오", ext: ".mp3" }
      : { label: "MP4 동영상", ext: ".mp4" };
  }

  function estimateSize(item = {}) {
    if (item.size > 0) return { bytes: item.size, approx: false };
    if (item.estimatedSize > 0) return { bytes: item.estimatedSize, approx: true };
    const duration = Number(item.duration) || 0;
    const average = Number(item.estimateBandwidth) || 0;
    const peak = Number(item.bandwidth) || 0;
    const bandwidth = average || (peak ? Math.round(peak * 0.55) : 0);
    if (bandwidth > 0 && duration >= 1) {
      return { bytes: Math.round((bandwidth / 8) * duration), approx: true };
    }
    if (item.segmentCount > 5) {
      return { bytes: item.segmentCount * 220_000, approx: true };
    }
    return null;
  }

  function estimateForQuality(item, qualities, selectedQuality) {
    const quality = (qualities || []).find((entry) => entry.id === selectedQuality);
    if (quality?.estimatedSize > 0) {
      return { bytes: quality.estimatedSize, approx: quality.approx !== false };
    }
    if (item?.estimatedSize > 0 && quality?.height && item._bestHeight) {
      const ratio = Math.min(
        1.2,
        Math.max(0.25, (quality.height / item._bestHeight) ** 1.4)
      );
      return { bytes: Math.round(item.estimatedSize * ratio), approx: true };
    }
    return estimateSize(item);
  }

  function estimateBarHtml(item, options = {}) {
    if (options.loading) {
      return `<div class="estimate-bar loading">
      <span class="est-item"><span class="est-k">미리보기</span><span class="est-v">용량·길이 확인 중…</span></span>
    </div>`;
    }
    const escape = options.escapeHtml || String;
    const duration = formatDuration(item?.duration);
    const estimate = estimateForQuality(item, options.qualities, options.selectedQuality);
    const sizeText = estimate
      ? estimate.approx ? `약 ${formatSize(estimate.bytes)}` : formatSize(estimate.bytes)
      : null;
    const quality = options.selectedQuality === "best"
      ? "최고"
      : options.selectedQuality || item?.quality || "";
    const parts = [];
    if (sizeText) {
      parts.push(`<span class="est-item"><span class="est-k">용량</span><span class="est-v">${escape(sizeText)}</span></span>`);
    }
    if (duration) {
      parts.push(`<span class="est-item"><span class="est-k">길이</span><span class="est-v">${escape(duration)}</span></span>`);
    }
    if (quality) {
      parts.push(`<span class="est-item"><span class="est-k">화질</span><span class="est-v">${escape(quality)}</span></span>`);
    }
    return parts.length
      ? `<div class="estimate-bar">${parts.join("")}</div>`
      : `<div class="estimate-bar loading">
      <span class="est-item"><span class="est-k">미리보기</span><span class="est-v">받기 후 용량 확정</span></span>
    </div>`;
  }

  function metaRowsHtml(item, options = {}) {
    const escape = options.escapeHtml || String;
    const site = options.siteLabel?.(options.currentTabUrl, item) || "";
    const duration = formatDuration(item?.duration);
    const estimate = estimateForQuality(item, options.qualities, options.selectedQuality);
    const sizeText = estimate
      ? estimate.approx ? `약 ${formatSize(estimate.bytes)}` : formatSize(estimate.bytes)
      : site ? "받기 후 확정" : "다운로드 후 확정";
    const resolution = item?.width && item?.height ? `${item.width}×${item.height}` : null;
    const pick = options.selectedQuality === "best"
      ? "최고 (가능한 최대)"
      : options.selectedQuality;
    const qualityText = site
      ? pick
      : [pick, item?.quality || null, resolution].filter(Boolean).join(" · ") || pick;
    return [
      ["사이트", site || "일반"],
      ["형식", site ? "MKV/MP4" : "MP4"],
      ["선택 화질", qualityText],
      ["길이", duration || "—"],
      ["용량", sizeText]
    ].map(([key, value]) =>
      `<div class="meta-row"><span class="meta-k">${escape(key)}</span><span class="meta-v">${escape(value)}</span></div>`
    ).join("");
  }

  function isHlsItem(item) {
    const url = item?.url || "";
    return /\.m3u8(\?|$|#)/i.test(url) ||
      /\.mpd(\?|$|#)/i.test(url) ||
      (/(?:m3u8|mpd|dash)/i.test(url) && (item?.isHls || item?.type === "stream"));
  }

  function isUglyName(name) {
    const value = String(name || "")
      .replace(/\.(mp4|webm|ts|m3u8|mp3)$/i, "")
      .replace(/\s*\(\d+p|4K\)\s*/gi, "")
      .trim();
    return !value || value.length < 2 ||
      /javplayer|surrit|cloudfront|player/i.test(value) ||
      /^(www\.)?[a-z0-9-]+\.(com|cc|net|tv|io|me)$/i.test(value) ||
      (/\.(com|cc|net|tv)\b/i.test(value) && value.length < 28 && !/[가-힣]/.test(value)) ||
      /\d+x\d+/i.test(value) ||
      /^\d+[_-]\d+/i.test(value) ||
      /^(영상|동영상|video|media|audio|다운로드|가능)$/i.test(value) ||
      /^[a-f0-9]{12,}$/i.test(value);
  }

  function cleanTitleText(raw, Naming) {
    if (!raw) return "";
    if (Naming?.cleanPageTitle) return Naming.cleanPageTitle(raw) || "";
    return String(raw)
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/^\(\d{1,4}\)\s*/, "").replace(/^\[\d{1,4}\]\s*/, "")
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[\u{2600}-\u{27BF}]/gu, "")
      .replace(/[♥❤💕💗💖💘⭐✨♡]/g, "")
      .replace(/[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?/gi, " ")
      .replace(/[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)/gi, " ")
      .replace(/\s*[\-|–—|·•:]\s*(YouTube|123AV|123av|MissAV|Jable|Netflix|Twitch|Bilibili).*$/i, "")
      .replace(/[\u2010-\u2015\u2212|·•]+/g, " ")
      .replace(/\s+-\s+/g, " ")
      .replace(/\.(m3u8|mp4|webm|ts|mp3|mkv)$/i, "")
      .replace(/다운로드\s*가능/g, "")
      .replace(/\s*[\(\[]\s*\d{3,4}\s*p\s*[\)\]]/gi, "")
      .replace(/\s+\d{3,4}p\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function displayName(item, options = {}) {
    const Naming = options.Naming;
    const pageUrl = item?.pageUrl || options.currentTabUrl || "";
    let best = "";
    for (const candidate of [item?.title, item?.pageTitle, item?.displayName, item?.filename]) {
      let cleaned = cleanTitleText(candidate, Naming);
      if (!cleaned || isUglyName(cleaned) || cleaned.length < 2) continue;
      if (Naming?.bindTitleToPage && pageUrl) {
        cleaned = Naming.bindTitleToPage(pageUrl, cleaned) || cleaned;
      }
      if (cleaned.length > best.length) best = cleaned;
    }
    if (!best && pageUrl) best = Naming?.bindTitleToPage?.(pageUrl, "") || "";
    if (!best) best = "영상";
    return best.length > 70 ? `${best.slice(0, 68).trim()}…` : best;
  }

  function downloadFilename(item, options = {}) {
    const { Naming, UVD } = options;
    const pageUrl = item?.pageUrl || options.currentTabUrl || "";
    let title = "";
    for (const candidate of [item?.title, item?.pageTitle, item?.displayName, item?.filename]) {
      let cleaned = cleanTitleText(candidate, Naming);
      if (!cleaned || isUglyName(cleaned) || UVD.isGenericSaveName(cleaned)) continue;
      if (Naming?.bindTitleToPage && pageUrl) {
        cleaned = Naming.bindTitleToPage(pageUrl, cleaned) || cleaned;
      }
      if (cleaned.length > title.length) title = cleaned;
    }
    if (!title && pageUrl) title = Naming?.bindTitleToPage?.(pageUrl, "") || "";
    const selected = options.selectedQuality || "";
    const quality = selected && !/^(best|all)$/i.test(selected)
      ? selected
      : item?.quality && !/^(best|all|unknown|highest)$/i.test(item.quality)
        ? item.quality
        : "";
    const mediaMode = options.mediaMode || "video";
    const isAudio = mediaMode === "audio" || item?.type === "audio";
    if (Naming?.buildFilename) {
      if (!title || UVD.isGenericSaveName(title)) return "";
      return Naming.buildFilename({
        title,
        pageTitle: title,
        quality,
        type: isAudio ? "audio" : "video",
        pageUrl,
        existing: item?.filename || "",
        url: item?.url || ""
      });
    }
    let base = UVD.applyFilenameTemplate("legacy", {
      title,
      quality,
      site: UVD.siteFromUrl(pageUrl || item?.url || ""),
      mediaMode
    });
    if (!base && title && !UVD.isGenericSaveName(title)) {
      base = title.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
      if (quality && !base.includes(quality)) base += `_${quality}`;
    }
    const extension = isAudio ? ".mp3" : ".mp4";
    if (!base) return "";
    return base.endsWith(extension) ? base : `${base}${extension}`;
  }

  return {
    formatSize,
    formatDuration,
    formatKind,
    estimateSize,
    estimateForQuality,
    estimateBarHtml,
    metaRowsHtml,
    isHlsItem,
    isUglyName,
    cleanTitleText,
    displayName,
    downloadFilename
  };
});
