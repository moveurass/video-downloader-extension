(function initProgressProtocol(root, factory) {
  const api = factory();
  root.UVDProgress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeProgressProtocol() {
  "use strict";

  const VERSION = 1;

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function orderOf(event) {
    if (!event) return { version: 0, attempt: 0, seq: 0, ordered: false };
    const version = numberOr(event.progressVersion, 0);
    const attempt = numberOr(event.progressAttempt, 0);
    const seq = numberOr(event.progressSeq, 0);
    return {
      version,
      attempt,
      seq,
      ordered: version > 0 && attempt > 0 && seq > 0
    };
  }

  /**
   * Accept a scoped progress event only when it is newer than the current one.
   * Legacy events remain compatible until an ordered event has been observed.
   */
  function shouldAccept(current, incoming) {
    if (!current) return true;
    const prev = orderOf(current);
    const next = orderOf(incoming);
    if (!prev.ordered) return true;
    if (!next.ordered) return false;
    if (next.attempt !== prev.attempt) return next.attempt > prev.attempt;
    return next.seq > prev.seq;
  }

  function isNewAttempt(current, incoming) {
    const prev = orderOf(current);
    const next = orderOf(incoming);
    return next.ordered && (!prev.ordered || next.attempt > prev.attempt);
  }

  function stablePercent(current, incoming) {
    const prevPercent = numberOr(current?.percent, 0);
    const nextPercent = Math.max(0, Math.min(100, numberOr(incoming?.percent, prevPercent)));
    return isNewAttempt(current, incoming)
      ? nextPercent
      : Math.max(prevPercent, nextPercent);
  }

  return {
    VERSION,
    orderOf,
    shouldAccept,
    isNewAttempt,
    stablePercent
  };
});
