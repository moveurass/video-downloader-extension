(function initBackgroundHelperMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundHelperMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeHelperMessages() {
  "use strict";

  function createHandler(deps) {
    return function handleHelperMessage(msg, tabId, sendResponse) {
      switch (msg?.type) {
        case "YTDLP_HEALTH": {
          deps.YtDlp.health(!!msg.force)
            .then((h) => sendResponse({ ok: true, ...h }))
            .catch((e) =>
              sendResponse({ ok: false, error: String(e?.message || e) })
            );
          return { handled: true, keepChannel: true };
        }
        case "DOWNLOAD_HELPER_STARTER": {
          // Drop a double-clickable .command into Downloads for macOS users
          (async () => {
            try {
              const script = `#!/bin/bash
# Universal Video Downloader — local yt-dlp helper
# Double-click this file (or: chmod +x 후 실행)
set -e
PORT=8787
if curl -s --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
  osascript -e 'display notification "이미 실행 중입니다" with title "UVD Helper"' 2>/dev/null || true
  echo "Already running on :$PORT"
  exit 0
fi
if ! command -v yt-dlp >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then brew install yt-dlp
  elif command -v pip3 >/dev/null 2>&1; then pip3 install -U yt-dlp
  fi
fi
LOG_DIR="$HOME/Library/Logs/uvd-helper"
mkdir -p "$LOG_DIR" "$HOME/Downloads/VideoDownloader"
# Prefer repo helper if found next to common clone paths
for CAND in \\
  "$HOME/video-downloader-extension/helper/yt_dlp_server.py" \\
  "$HOME/Downloads/video-downloader-extension/helper/yt_dlp_server.py" \\
  "$HOME/Desktop/video-downloader-extension/helper/yt_dlp_server.py"
do
  if [ -f "$CAND" ]; then
    nohup /usr/bin/python3 "$CAND" >>"$LOG_DIR/uvd-helper.log" 2>>"$LOG_DIR/uvd-helper.err.log" &
    sleep 1
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok"'; then
      osascript -e 'display notification "도우미가 시작되었습니다" with title "UVD Helper"' 2>/dev/null || true
      echo "OK :$PORT"
      exit 0
    fi
  fi
done
# Fallback: tell user to run from extension folder
osascript -e 'display dialog "helper/yt_dlp_server.py 경로를 찾지 못했습니다.\\n확장 프로그램 폴더의 helper/start_background.command 를 실행해 주세요." buttons {"OK"}' 2>/dev/null || true
exit 1
`;
              const dataUrl =
                "data:application/x-sh;charset=utf-8," + encodeURIComponent(script);
              const downloadId = await new Promise((resolve, reject) => {
                deps.chrome.downloads.download(
                  {
                    url: dataUrl,
                    filename: "UVD-도우미-시작.command",
                    saveAs: false,
                    conflictAction: "uniquify"
                  },
                  (id) => {
                    if (deps.chrome.runtime.lastError || id == null) {
                      reject(
                        new Error(
                          deps.chrome.runtime.lastError?.message || "다운로드 실패"
                        )
                      );
                    } else resolve(id);
                  }
                );
              });
              sendResponse({
                ok: true,
                downloadId,
                hint: "다운로드 폴더의 UVD-도우미-시작.command 를 더블클릭하세요 (처음엔 실행 권한 필요할 수 있음)"
              });
            } catch (e) {
              sendResponse({ ok: false, error: String(e?.message || e) });
            }
          })();
          return { handled: true, keepChannel: true };
        }
        case "SHOW_DOWNLOAD": {
          (async () => {
            try {
              if (msg.downloadId != null) {
                deps.chrome.downloads.show(msg.downloadId);
                sendResponse({ ok: true });
                return;
              }
              if (msg.path && typeof msg.path === "string") {
                // Search chrome downloads by filename
                const name = msg.path.split(/[/\\]/).pop();
                const items = await deps.chrome.downloads.search({
                  filenameRegex: name
                    ? name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                    : undefined,
                  limit: 5,
                  orderBy: ["-startTime"]
                });
                if (items?.[0]?.id != null) {
                  deps.chrome.downloads.show(items[0].id);
                  sendResponse({ ok: true });
                  return;
                }
                deps.chrome.downloads.showDefaultFolder?.();
                sendResponse({ ok: true, fallback: true });
                return;
              }
              deps.chrome.downloads.showDefaultFolder?.();
              sendResponse({ ok: true, fallback: true });
            } catch (e) {
              sendResponse({ ok: false, error: String(e?.message || e) });
            }
          })();
          return { handled: true, keepChannel: true };
        }
        case "DOWNLOAD_BATCH": {
          // Multi-link paste: start each URL as its own job
          const urls = Array.isArray(msg.urls)
            ? msg.urls
            : deps.UVD.parseUrlsFromText(msg.text || "");
          const unique = [...new Set(urls.filter((u) => /^https?:/i.test(u)))];
          if (!unique.length) {
            sendResponse({ ok: false, error: "유효한 링크가 없습니다" });
            return { handled: true, keepChannel: false };
          }
          const tid = msg.tabId ?? tabId;
          const preferQuality = msg.preferQuality || "best";
          (async () => {
            const settings = await deps.UVD.getSettings();
            const started = [];
            for (const pageUrl of unique.slice(0, deps.maxConcurrent())) {
              const fname = await deps.buildSaveFilename({
                title: msg.title || deps.UVD.siteFromUrl(pageUrl) || "영상",
                quality: preferQuality,
                pageUrl,
                mediaMode: settings.mediaMode
              });
              // fire each as tracked job without waiting on popup
              const jobId = deps.createDownloadJob({
                tabId: tid,
                title: fname,
                pageUrl,
                filename: fname,
                mediaMode: settings.mediaMode,
                quality: preferQuality
              });
              const keep = deps.startKeepAlive();
              started.push(jobId);
              deps.withJobContext(jobId, () =>
                deps.downloadPageFromUi(tid, pageUrl, preferQuality, jobId)
              )
                .then((r) => {
                  deps.finishDownloadJob(jobId, r, null);
                  deps.stopKeepAlive(keep);
                })
                .catch((err) => {
                  deps.finishDownloadJob(jobId, null, err);
                  deps.stopKeepAlive(keep);
                });
            }
            sendResponse({
              ok: true,
              started: true,
              count: started.length,
              jobIds: started,
              total: unique.length,
              truncated: unique.length > started.length
            });
          })().catch((e) =>
            sendResponse({ ok: false, error: String(e?.message || e) })
          );
          return { handled: true, keepChannel: true };
        }
        default:
          return { handled: false, keepChannel: false };
      }
    };
  }

  return { createHandler };
});
