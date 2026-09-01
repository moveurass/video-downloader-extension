(function initQualityMessages(root, factory) {
  const api = factory();
  root.UVDQualityMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeQualityMessages() {
  "use strict";

  function heightFromString(value, HLS) {
    if (HLS?.heightFromString) return HLS.heightFromString(value) || 0;
    const text = String(value || "");
    const match =
      text.match(/(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*p(?:[^\d]|$)/i) ||
      text.match(/[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)/i);
    return match ? parseInt(match[1], 10) : 0;
  }

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

  function sizeLabel(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
  }

  function tabHintHeight(tabId, deps) {
    if (tabId == null) return { height: 0, quality: "" };
    let height = 0;
    let quality = "";
    for (const item of deps.getTabMap(tabId).values()) {
      if (item?.height >= 240 && item.height > height) {
        height = item.height;
        quality = item.quality || deps.qualityLabel(item.height) || "";
      } else if (!height && item?.quality && !/^(best|all|unknown)$/i.test(item.quality)) {
        quality = item.quality;
        height = parseInt(String(item.quality).match(/(\d{3,4})/)?.[1], 10) || 0;
      }
    }
    return { height, quality };
  }

  async function playerHint(tabId, deps) {
    if (tabId == null || tabId < 0) return { height: 0, quality: "" };
    const result = await deps.tabs.sendMessage(tabId, { type: "GET_PLAYER_HEIGHT" })
      .catch(() => null);
    const height = Number(result?.height) || 0;
    const quality = String(result?.quality || "").trim();
    return {
      height: height >= 240 ? height : 0,
      quality: quality && !/^(best|all|unknown)$/i.test(quality)
        ? quality
        : deps.qualityLabel(height) || ""
    };
  }

  async function masterResponse(info, deps) {
    const byLabel = new Map();
    for (const variant of info.variants) {
      const height = variant.height ||
        heightFromString(variant.name, deps.HLS) ||
        heightFromString(variant.url, deps.HLS) ||
        heightFromBandwidth(variant.estimateBandwidth || variant.bandwidth);
      const label =
        (variant.quality && variant.quality !== "unknown" && variant.quality) ||
        deps.qualityLabel(height) ||
        (height ? `${height}p` : "");
      if (!label) continue;
      const bandwidth = variant.estimateBandwidth || variant.bandwidth || 0;
      if (!byLabel.has(label) || (byLabel.get(label).height || 0) < height) {
        byLabel.set(label, {
          id: label,
          label,
          height,
          estimateBandwidth: bandwidth
        });
      }
    }
    let duration = 0;
    try {
      const media = await deps.withReferer(() => deps.HLS.probe(info.variants[0].url));
      duration = media?.duration >= 1 ? media.duration : 0;
    } catch {
      // Size remains unknown.
    }
    for (const quality of byLabel.values()) {
      if (quality.estimateBandwidth > 0 && duration) {
        quality.estimatedSize = Math.round((quality.estimateBandwidth / 8) * duration);
        quality.approx = true;
        quality.label = `${quality.id} · ${sizeLabel(quality.estimatedSize)}`;
      }
    }
    const order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"];
    const real = [
      ...order.filter((label) => byLabel.has(label)).map((label) => byLabel.get(label)),
      ...[...byLabel].filter(([label]) => !order.includes(label)).map(([, value]) => value)
    ];
    const qualities = real.length > 1 ? [{ id: "best", label: "최고" }, ...real] : real;
    const best = real[0] || info.variants[0];
    const bandwidth = best?.estimateBandwidth || best?.bandwidth || 0;
    const estimatedSize = bandwidth > 0 && duration
      ? Math.round((bandwidth / 8) * duration)
      : 0;
    const bestChip = qualities.find((quality) => quality.id === "best");
    if (bestChip && estimatedSize) {
      Object.assign(bestChip, {
        estimatedSize,
        height: best?.height,
        approx: true,
        label: `최고 · ${sizeLabel(estimatedSize)}`
      });
    }
    return qualities.length
      ? { ok: true, qualities, source: "hls", duration, estimatedSize }
      : null;
  }

  function playlistCandidates(url) {
    const candidates = [];
    const push = (value) => {
      if (value && value !== url && !candidates.includes(value)) candidates.push(value);
    };
    try {
      const parsed = new URL(url);
      const names = ["master.m3u8", "playlist.m3u8", "index.m3u8", "hls.m3u8", "stream.m3u8", "video.m3u8"];
      const base = parsed.href.replace(/[^/]+$/, "");
      names.forEach((name) => push(base + name));
      let parent = base.replace(/\/[^/]+\/$/, "/");
      if (parent !== base) ["master.m3u8", "playlist.m3u8", "index.m3u8"]
        .forEach((name) => push(parent + name));
      const stripped = parsed.href.replace(
        /\/(?:2160|1440|1080|720|480|360|240)p?(?:\/|$)/i,
        "/"
      );
      if (stripped !== parsed.href) {
        const strippedBase = stripped.replace(/[^/]+$/, "");
        ["master.m3u8", "playlist.m3u8", "index.m3u8"]
          .forEach((name) => push(strippedBase + name));
      }
      parent = parent.replace(/\/[^/]+\/$/, "/");
      ["master.m3u8", "playlist.m3u8"].forEach((name) => push(parent + name));
    } catch {
      // No sibling candidates.
    }
    return candidates.slice(0, 8);
  }

  async function mediaResponse(url, info, message, tabId, deps) {
    const tabHint = tabHintHeight(tabId, deps);
    let height =
      Number(message.itemHeight) ||
      heightFromString(url, deps.HLS) ||
      Number(info.inferredHeight) ||
      tabHint.height;
    let label =
      (!/^(best|all|unknown)$/i.test(String(message.itemQuality || "")) &&
        String(message.itemQuality || "").trim()) ||
      deps.qualityLabel(height) ||
      tabHint.quality ||
      "";
    if (!label) {
      for (const sample of info.sampleUrls || []) {
        const sampleHeight = heightFromString(sample, deps.HLS);
        if (sampleHeight >= 240) {
          height = sampleHeight;
          label = deps.qualityLabel(height);
          break;
        }
      }
    }
    const current = tabId != null ? deps.getTabMap(tabId).get(url) : null;
    if (!label && current?.height >= 240) {
      height = current.height;
      label = deps.qualityLabel(height);
    } else if (!label && current?.quality && !/^(best|all|unknown)$/i.test(current.quality)) {
      label = current.quality;
    }
    if (!label) {
      const player = await playerHint(tabId, deps);
      height = player.height || height;
      label = player.quality || deps.qualityLabel(height) || "";
    }
    if (!label) {
      for (const candidate of playlistCandidates(url)) {
        try {
          const master = await deps.withReferer(() => deps.HLS.probe(candidate));
          if (master?.kind !== "master" || !master.variants?.length) continue;
          const heights = master.variants
            .map((variant) => variant.height || heightFromString(variant.url, deps.HLS))
            .filter((value) => value >= 240);
          if (heights.length) {
            height = Math.max(...heights);
            label = deps.qualityLabel(height);
            break;
          }
        } catch {
          // Try next sibling.
        }
      }
    }
    if (label && tabId != null && height >= 240 && current && !(current.height >= 240)) {
      deps.getTabMap(tabId).set(url, { ...current, height, quality: label });
    }
    return {
      ok: true,
      qualities: label ? [{ id: label, label, height: height || undefined }] : [{ id: "best", label: "최고" }],
      source: "hls-media",
      duration: info.duration >= 1 ? info.duration : 0,
      estimatedSize: 0
    };
  }

  function createHandler(deps) {
    return async function handleQualityMessage(message, tabId) {
      const url = message.url || message.pageUrl || "";
      if (!url) return { ok: false, error: "url 없음", qualities: [] };
      if (/\.m3u8(\?|$|#)/i.test(url) || message.mediaType === "stream") {
        try {
          const withReferer = (operation) => deps.withTabReferer(tabId, operation);
          const context = { ...deps, withReferer };
          const info = await withReferer(() => deps.HLS.probe(url));
          if (info?.kind === "master" && info.variants?.length) {
            const response = await masterResponse(info, context);
            if (response) return response;
          }
          if (info?.kind === "media") {
            return await mediaResponse(url, info, message, tabId, context);
          }
        } catch {
          // Fall through to helper/default.
        }
      }
      if (deps.needsHelper(url, url) || message.forceYtDlp) {
        let data = null;
        const cached = message.refresh ? null : deps.cache.get(url);
        if (cached && Date.now() - cached.at < deps.cacheTtl) data = cached.data;
        if (!data) {
          const [cookieHeader, cookiesList] = await Promise.all([
            deps.getCookieHeader(url),
            deps.collectCookies(url)
          ]);
          data = await deps.YtDlp.listFormats(url, {
            cookieHeader: cookieHeader || undefined,
            cookiesList: cookiesList?.length ? cookiesList : undefined,
            site: deps.siteKind(url, url) || undefined
          });
          deps.cache.set(url, { data, at: Date.now() });
          if (deps.cache.size > 60) deps.cache.delete(deps.cache.keys().next().value);
        }
        return {
          ok: true,
          qualities: data.qualities || [],
          heights: data.heights || [],
          title: data.title || "",
          duration: data.duration || 0,
          estimatedSize: data.estimatedSize || 0,
          thumbnail: data.thumbnail || "",
          source: "yt-dlp"
        };
      }
      return {
        ok: true,
        qualities: [{ id: "best", label: "최고" }],
        source: "default",
        duration: 0,
        estimatedSize: 0
      };
    };
  }

  return { heightFromString, heightFromBandwidth, playlistCandidates, createHandler };
});
