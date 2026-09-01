(function initMediaQuality(root, factory) {
  const api = factory();
  root.UVDQuality = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeMediaQuality() {
  "use strict";

  const FALLBACK_QUALITY_CHIPS = Object.freeze([{ id: "best", label: "최고" }]);

  function formatMb(bytes) {
    const mb = Number(bytes) / (1024 * 1024);
    if (!Number.isFinite(mb) || mb <= 0) return "";
    return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
  }

  function heightToQualityId(height) {
    const h = Number(height) || 0;
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    if (h >= 240) return "240p";
    return "";
  }

  function concreteQualityChip(quality) {
    if (!quality) return null;
    let id = String(quality.id || "");
    if (!id || id === "best" || /^(best|all|unknown)$/i.test(id)) {
      id = heightToQualityId(quality.height) || "";
    }
    if (!id) return null;
    const parts = [id];
    const size = quality.estimatedSize > 0 ? formatMb(quality.estimatedSize) : "";
    if (size) parts.push(size);
    if (quality.codec) parts.push(quality.codec);
    return {
      ...quality,
      id,
      label: parts.join(" · "),
      height: quality.height || 0
    };
  }

  function ensureQualityChoices(list) {
    const cleaned = (Array.isArray(list) ? list : [])
      .filter(
        (q) =>
          q &&
          q.id &&
          !/unsupported|error|fail|http/i.test(String(q.label || "")) &&
          !/unsupported|error/i.test(String(q.id))
      )
      .map((q) => ({ ...q, label: q.label || q.id }));

    const seen = new Set();
    const unique = [];
    for (const quality of cleaned) {
      const id = String(quality.id);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(quality);
    }

    const bestEntry = unique.find((q) => q.id === "best");
    const real = unique.filter((q) => q.id !== "best");
    if (real.length === 1) {
      return [concreteQualityChip(real[0]) || real[0]];
    }
    if (real.length === 0 && bestEntry) {
      const concrete = concreteQualityChip(bestEntry);
      return concrete ? [concrete] : [{ ...bestEntry, label: bestEntry.label || "최고" }];
    }
    if (real.length > 1) {
      const out = [];
      if (bestEntry) {
        out.push({ ...bestEntry, label: bestEntry.label || "최고" });
      } else {
        const top = real[0];
        out.push({
          id: "best",
          label: top.estimatedSize
            ? `최고 · ${formatMb(top.estimatedSize)}`
            : "최고",
          height: top.height,
          estimatedSize: top.estimatedSize,
          codec: top.codec,
          approx: top.approx
        });
      }
      return [...out, ...real];
    }
    if (unique.length) return unique;
    return FALLBACK_QUALITY_CHIPS.map((item) => ({ ...item }));
  }

  return {
    FALLBACK_QUALITY_CHIPS,
    formatMb,
    heightToQualityId,
    concreteQualityChip,
    ensureQualityChoices
  };
});
