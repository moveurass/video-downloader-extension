(function initDownloadQueueState(root, factory) {
  const api = factory(root.UVDProgress);
  root.UVDQueueState = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeQueueState(Progress) {
  "use strict";

  if (!Progress && typeof require === "function") {
    Progress = require("./progress-protocol.js");
  }

  const TERMINAL = new Set(["done", "error", "cancelled"]);

  function statusOf(incoming, current = {}) {
    if (incoming?.status) return incoming.status;
    if (incoming?.phase === "done") return "done";
    if (incoming?.phase === "error") return "error";
    if (incoming?.phase === "paused") return "paused";
    if (current.status === "paused" || current.status === "cancelled") {
      return current.status;
    }
    return current.status || "running";
  }

  function shouldAccept(current, incoming, options = {}) {
    if (!current?.id) return true;
    if (options.local || current._optimistic) return true;
    return Progress.shouldAccept(current, incoming);
  }

  function shouldIgnoreAmbient(current, incoming) {
    if (!current || !TERMINAL.has(current.status) && current.status !== "paused") {
      return false;
    }
    return (
      !incoming?.status &&
      incoming?.phase !== "done" &&
      incoming?.phase !== "error"
    );
  }

  function percentFor(current, incoming, status = statusOf(incoming, current)) {
    if (status === "done") return 100;
    if (!current) {
      const n = Number(incoming?.percent);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    }
    if (status === "running" && current.status === "running") {
      return Progress.stablePercent(current, incoming);
    }
    const n = Number(incoming?.percent);
    const fallback = Number(current.percent) || 0;
    return Math.max(0, Math.min(100, Number.isFinite(n) ? n : fallback));
  }

  return {
    statusOf,
    shouldAccept,
    shouldIgnoreAmbient,
    percentFor
  };
});
