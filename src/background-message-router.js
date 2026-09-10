(function initBackgroundMessageRouter(root, factory) {
  const api = factory();
  root.UVDBackgroundMessages = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function makeRouterModule() {
  "use strict";

  function createRouter(deps) {
    const asyncReply = (operation, sendResponse, fallback) => {
      Promise.resolve()
        .then(operation)
        .then((value) => sendResponse(value))
        .catch((error) =>
          sendResponse({
            ok: false,
            ...(fallback || {}),
            error: String(error?.message || error)
          })
        );
      return { handled: true, keepChannel: true };
    };

    return function routeBackgroundMessage(message, sendResponse) {
      const UVD = deps.UVD;
      switch (message?.type) {
        case "GET_SETTINGS":
          return asyncReply(
            () => UVD.getSettings().then((settings) => ({ ok: true, settings })),
            sendResponse
          );
        case "SET_SETTINGS":
          return asyncReply(async () => {
            const settings = await UVD.setSettings(message.settings || message.patch || {});
            await deps.updateDownloadBadge().catch(() => {});
            return { ok: true, settings };
          }, sendResponse);
        case "GET_HISTORY":
          return asyncReply(
            () => UVD.getHistory().then((history) => ({ ok: true, history })),
            sendResponse
          );
        case "QUERY_LIBRARY":
          return asyncReply(
            () => UVD.queryLibrary(message.query || message.opts || {})
              .then((items) => ({ ok: true, items })),
            sendResponse,
            { items: [] }
          );
        case "UPDATE_HISTORY_ITEM":
          return asyncReply(
            () => UVD.updateHistoryItem(message.id, message.patch || {})
              .then((history) => ({ ok: true, history })),
            sendResponse
          );
        case "CLEAR_HISTORY":
          return asyncReply(
            () => UVD.clearHistory().then(() => ({ ok: true, history: [] })),
            sendResponse
          );
        case "GET_RECENT_DONE":
          return asyncReply(
            () => UVD.getRecentDone(message.limit || 3)
              .then((items) => ({ ok: true, items })),
            sendResponse
          );
        case "GET_SITE_PACKS":
          return asyncReply(
            () => UVD.getSitePacks().then((packs) => ({ ok: true, packs })),
            sendResponse
          );
        case "SET_SITE_PACKS":
          return asyncReply(
            () => UVD.setSitePacks(message.packs || [])
              .then((packs) => ({ ok: true, packs })),
            sendResponse
          );
        case "GET_WATCHLIST":
          return asyncReply(
            () => UVD.getWatchlist().then((watchlist) => ({ ok: true, watchlist })),
            sendResponse
          );
        case "ADD_WATCHLIST":
          return asyncReply(
            () => UVD.addWatchlist(message.item || message)
              .then((watchlist) => ({ ok: true, watchlist })),
            sendResponse
          );
        case "REMOVE_WATCHLIST":
          return asyncReply(async () => {
            const id = message.id || message.url || "";
            const watchlist = await UVD.removeWatchlist(id);
            if (id) await deps.alarms.clear(`uvd-watch-${id}`).catch(() => {});
            return { ok: true, watchlist };
          }, sendResponse);
        case "CLEAR_WATCHLIST":
          return asyncReply(async () => {
            await UVD.clearWatchlist();
            const alarms = await deps.alarms.getAll().catch(() => []);
            await Promise.all(
              alarms
                .filter((alarm) => alarm.name.startsWith("uvd-watch-"))
                .map((alarm) => deps.alarms.clear(alarm.name).catch(() => {}))
            );
            return { ok: true, watchlist: [] };
          }, sendResponse);
        case "REORDER_WATCHLIST":
          return asyncReply(
            () => UVD.reorderWatchlist(message.ids || message.orderedIds || [])
              .then((watchlist) => ({ ok: true, watchlist })),
            sendResponse
          );
        case "UPDATE_WATCHLIST_ITEM":
          return asyncReply(async () => {
            const id = message.id || "";
            const patch = message.patch || {};
            const watchlist = await UVD.updateWatchlistItem(id, patch);
            const alarmName = `uvd-watch-${id}`;
            await deps.alarms.clear(alarmName).catch(() => {});
            const when = Number(patch.scheduleAt || 0);
            if (when > Date.now() + 15_000) {
              await deps.alarms.create(alarmName, { when }).catch(() => {});
            }
            return { ok: true, watchlist };
          }, sendResponse);
        case "EXPORT_BACKUP":
          return asyncReply(async () => {
            const [settings, watchlist, history] = await Promise.all([
              UVD.getSettings(),
              UVD.getWatchlist(),
              UVD.getHistory()
            ]);
            const payload = JSON.stringify({
              app: "uvd",
              version: 1,
              exportedAt: new Date().toISOString(),
              settings,
              watchlist,
              history
            });
            const stamp = new Date()
              .toISOString()
              .slice(0, 16)
              .replace(/[-:T]/g, "");
            const filename = `uvd-backup-${stamp}.json`;
            await deps.downloads.download({
              url: `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`,
              filename,
              saveAs: true
            });
            return { ok: true, filename };
          }, sendResponse);
        case "IMPORT_BACKUP":
          return asyncReply(async () => {
            const sanitized = UVD.sanitizeBackup(message.data);
            if (!sanitized) {
              return { ok: false, error: "백업 파일 형식이 올바르지 않습니다" };
            }
            if (sanitized.settings) await UVD.setSettings(sanitized.settings);
            const [currentWatchlist, currentHistory] = await Promise.all([
              UVD.getWatchlist(),
              UVD.getHistory()
            ]);
            const seenUrls = new Set(
              (message.replace ? [] : currentWatchlist).map((w) =>
                UVD.normalizeUrlKey(w?.url || "")
              )
            );
            const mergedWatchlist = [
              ...sanitized.watchlist,
              ...(message.replace ? [] : currentWatchlist).filter((w) => {
                const key = UVD.normalizeUrlKey(w?.url || "");
                if (!key || seenUrls.has(key)) return false;
                seenUrls.add(key);
                return true;
              })
            ].slice(0, 100);
            const seenIds = new Set(
              (message.replace ? [] : currentHistory).map((h) => h?.id)
            );
            const mergedHistory = [
              ...sanitized.history,
              ...(message.replace ? [] : currentHistory).filter((h) => {
                if (!h?.id || seenIds.has(h.id)) return false;
                seenIds.add(h.id);
                return true;
              })
            ].slice(0, 100);
            await UVD.setWatchlistBulk(mergedWatchlist);
            await UVD.setHistoryBulk(mergedHistory);
            return {
              ok: true,
              imported: {
                settings: !!sanitized.settings,
                watchlist: sanitized.watchlist.length,
                history: sanitized.history.length
              }
            };
          }, sendResponse);
        case "REFRESH_BADGE":
          return asyncReply(
            () => deps.updateDownloadBadge().catch(() => {}).then(() => ({ ok: true })),
            sendResponse
          );
        case "OPEN_URL": {
          const url = message.url;
          if (url && /^https?:/i.test(url)) {
            deps.tabs.create({ url }).catch(() => {});
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: "bad url" });
          }
          return { handled: true, keepChannel: false };
        }
        case "CLEAR_MEDIA":
          if (message.tabId != null) {
            deps.clearMedia(message.tabId);
          }
          sendResponse({ ok: true });
          return { handled: true, keepChannel: false };
        case "PING":
          sendResponse({ ok: true, version: deps.version });
          return { handled: true, keepChannel: false };
        default:
          return { handled: false, keepChannel: false };
      }
    };
  }

  return { createRouter };
});
