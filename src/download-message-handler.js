(function initDownloadMessageHandler(root, factory) {
  const api = factory();
  root.UVDDownloadMessages = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeDownloadMessages() {
  "use strict";

  function createHandler(deps) {
    const runAsync = (operation, sendResponse) => {
      Promise.resolve()
        .then(operation)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return { handled: true, keepChannel: true };
    };

    return function handleDownloadMessage(message, sendResponse) {
      const id = message?.jobId || message?.id || "";
      switch (message?.type) {
        case "CANCEL_DOWNLOAD":
          return runAsync(() => deps.cancel(id), sendResponse);
        case "PAUSE_DOWNLOAD":
          return runAsync(() => deps.pause(id), sendResponse);
        case "RESUME_DOWNLOAD":
          return runAsync(() => deps.resume(id), sendResponse);
        case "GET_ACTIVE_DOWNLOADS": {
          const jobs = deps.list();
          if (jobs && typeof jobs.then === "function") {
            return runAsync(
              async () => ({ ok: true, jobs: await jobs }),
              sendResponse
            );
          }
          sendResponse({ ok: true, jobs });
          return { handled: true, keepChannel: false };
        }
        case "GET_DOWNLOAD_PROGRESS": {
          const jobs = deps.list();
          if (jobs && typeof jobs.then === "function") {
            return runAsync(async () => {
              const resolved = await jobs;
              const job =
                resolved.find((item) => item.status === "running") ||
                resolved[0] ||
                null;
              return {
                ok: true,
                jobs: resolved,
                job,
                progress: deps.progress(message.tabId) || null
              };
            }, sendResponse);
          }
          const job =
            jobs.find((item) => item.status === "running") || jobs[0] || null;
          sendResponse({
            ok: true,
            jobs,
            job,
            progress: deps.progress(message.tabId) || null
          });
          return { handled: true, keepChannel: false };
        }
        default:
          return { handled: false, keepChannel: false };
      }
    };
  }

  return { createHandler };
});
