(function initBackgroundMediaMessages(root, factory) {
  const api = factory();
  root.UVDBackgroundMediaMessages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeMediaMessages() {
  "use strict";

  function createHandler(deps) {
    const isTopFrame = (sender) =>
      sender?.frameId == null || sender.frameId === 0;

    return function handleMediaMessage(msg, tabId, sender, sendResponse) {
      switch (msg?.type) {
        case "HLS_PROGRESS": {
          const p = msg.progress || {};
          const jid = p.jobId || msg.jobId || null;
          const tid = tabId ?? msg.tabId ?? sender.tab?.id ?? -1;
          if (jid) {
            const job = deps.activeDownloads.get(jid);
            if (job && deps.jobIsStopping(job)) {
              sendResponse({ ok: true, stopped: true });
              return { handled: true, keepChannel: false };
            }
            const sourceAttempt = Number(p.progressAttempt) || 0;
            if (
              job &&
              sourceAttempt > 0 &&
              sourceAttempt !== (Number(job.progressAttempt) || 1)
            ) {
              sendResponse({ ok: true, stale: true });
              return { handled: true, keepChannel: false };
            }
          }
          const percent =
            typeof p.percent === "number"
              ? Math.min(98, Math.max(0, p.percent))
              : deps.hlsPhasePercent(p);
          const phase = p.phase || "download";
          const message =
            p.message ||
            (phase === "merge"
              ? "파일 만드는 중…"
              : phase === "save"
                ? "디스크에 저장 중…"
                : "받는 중…");
          try {
            deps.emitDownloadProgress(tid, percent, message, phase, jid, {
              progressAttempt: p.progressAttempt,
              segmentCurrent: p.current,
              segmentTotal: p.total,
              bytesReceived: p.bytesReceived,
              totalBytes: p.bytesTotal
            });
          } catch {
            /* job cancelled / paused — expected */
          }
          sendResponse({ ok: true });
          return { handled: true, keepChannel: false };
        }
        case "PAGE_META": {
          if (tabId != null && msg.pageMeta) {
            const pageUrl =
              msg.pageMeta.lastUrl || sender.tab?.url || msg.pageUrl || "";
            if (isTopFrame(sender)) {
              deps.setTabMeta(tabId, {
                ...msg.pageMeta,
                lastUrl: pageUrl || msg.pageMeta.lastUrl,
                pageKey: pageUrl
                  ? deps.pageIdentityKey(pageUrl)
                  : msg.pageMeta.pageKey
              });
            } else if (pageUrl) {
              // all_frames content scripts may report an empty player title.
              // Keep the top-page identity without clearing its real metadata.
              deps.setTabMeta(tabId, {
                lastUrl: pageUrl,
                pageKey: deps.pageIdentityKey(pageUrl)
              });
            }
          }
          sendResponse({ ok: true });
          return { handled: true, keepChannel: false };
        }
        case "PAGE_MEDIA": {
          if (tabId == null) {
            return { handled: true, keepChannel: false };
          }
          const pageUrl = sender.tab?.url || msg.pageUrl || "";
          if (msg.pageMeta && isTopFrame(sender)) {
            deps.setTabMeta(tabId, {
              ...msg.pageMeta,
              lastUrl: pageUrl || msg.pageMeta.lastUrl,
              pageKey: pageUrl ? deps.pageIdentityKey(pageUrl) : undefined
            });
          } else if (pageUrl) {
            deps.setTabMeta(tabId, {
              lastUrl: pageUrl,
              pageKey: deps.pageIdentityKey(pageUrl)
            });
          }
          for (const item of msg.items || []) {
            deps.addMedia(tabId, {
              ...item,
              source: item.source || "page",
              pageUrl
            });
          }
          sendResponse({ ok: true });
          return { handled: true, keepChannel: false };
        }
        case "GET_MEDIA": {
          const pageUrl = msg.pageUrl || "";
          if (msg.tabId != null && (pageUrl || msg.title)) {
            const meta = {};
            if (pageUrl) {
              meta.lastUrl = pageUrl;
              meta.pageKey = deps.pageIdentityKey(pageUrl);
            }
            // The active tab query is a reliable fallback when a service
            // worker started after tabs.onUpdated already fired.
            if (msg.title) meta.title = msg.title;
            deps.setTabMeta(msg.tabId, meta);
          }
          deps
            .getMediaForTabAsync(msg.tabId, {
              pageUrl,
              title: msg.title || ""
            })
            .then((items) => sendResponse({ items: items || [] }))
            .catch((error) => {
              console.warn("[UVD] GET_MEDIA", error);
              if (
                msg.pageUrl &&
                deps.needsYtDlpHelper(msg.pageUrl, msg.pageUrl)
              ) {
                const placeholder = deps.makeSitePlaceholder({
                  id: msg.tabId,
                  url: msg.pageUrl,
                  title: msg.title || ""
                });
                sendResponse({ items: placeholder ? [placeholder] : [] });
              } else {
                sendResponse({ items: deps.getMediaForTab(msg.tabId) });
              }
            });
          return { handled: true, keepChannel: true };
        }
        case "PROBE_PAGE_META": {
          (async () => {
            try {
              const url = String(msg.url || msg.pageUrl || "").trim();
              const expectedKey = String(msg.expectedKey || msg.key || "").trim();
              if (!url || !/^https?:/i.test(url)) {
                sendResponse({ ok: false, exists: false, error: "url 없음" });
                return;
              }
              const probeTabId = tabId;
              if (probeTabId != null && probeTabId >= 0) {
                try {
                  const tab = await deps.chrome.tabs
                    .get(probeTabId)
                    .catch(() => null);
                  if (tab?.url) {
                    const tabHost = new URL(tab.url).hostname.replace(/^www\./, "");
                    const urlHost = new URL(url).hostname.replace(/^www\./, "");
                    if (
                      tabHost &&
                      urlHost &&
                      (tabHost === urlHost ||
                        tabHost.endsWith("." + urlHost) ||
                        urlHost.endsWith("." + tabHost))
                    ) {
                      const result = await deps.chrome.tabs
                        .sendMessage(probeTabId, {
                          type: "PROBE_PAGE_META",
                          url,
                          expectedKey,
                          key: expectedKey
                        })
                        .catch(() => null);
                      if (
                        result &&
                        (result.ok || result.exists === false || result.error)
                      ) {
                        sendResponse({
                          ...result,
                          source: result.source || "content"
                        });
                        return;
                      }
                    }
                  }
                } catch {
                  /* fall through */
                }
              }
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 12000);
              let res;
              try {
                res = await deps.fetch(url, {
                  method: "GET",
                  signal: ctrl.signal,
                  credentials: "omit",
                  redirect: "follow",
                  headers: { Accept: "text/html,application/xhtml+xml" }
                });
              } finally {
                clearTimeout(timer);
              }
              const finalUrl = res.url || url;
              const status = res.status;
              if (!res.ok) {
                sendResponse({
                  ok: false,
                  exists: false,
                  status,
                  url,
                  finalUrl,
                  error: `HTTP ${status}`
                });
                return;
              }
              const html = await res.text();
              const pickMeta = (...patterns) => {
                for (const pattern of patterns) {
                  const match = html.match(pattern);
                  if (match?.[1]) return match[1].trim();
                }
                return "";
              };
              let thumb =
                pickMeta(
                  /property=["']og:image(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i,
                  /content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url|:url)?["']/i,
                  /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
                  /content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i,
                  /rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
                  /<video[^>]+poster=["']([^"']+)["']/i
                ) || "";
              if (!thumb) {
                const images = [
                  ...html.matchAll(
                    /<img[^>]+(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["'][^>]+src=["']([^"']+)["']/gi
                  ),
                  ...html.matchAll(
                    /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id)=["'][^"']*(?:cover|thumb|poster|preview)[^"']*["']/gi
                  )
                ];
                for (const match of images) {
                  const imageUrl = match[1];
                  if (
                    imageUrl &&
                    !/\.svg(\?|$)/i.test(imageUrl) &&
                    !/sprite|icon|logo|avatar|1x1|pixel/i.test(imageUrl)
                  ) {
                    thumb = imageUrl;
                    break;
                  }
                }
              }
              let title =
                pickMeta(
                  /property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
                  /content=["']([^"']+)["'][^>]*property=["']og:title["']/i,
                  /<title[^>]*>([^<]{2,200})<\/title>/i
                ) || "";
              const decode = (value) =>
                String(value || "")
                  .replace(/&amp;/g, "&")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'");
              thumb = decode(thumb);
              title = decode(title);
              if (thumb.startsWith("//")) {
                try {
                  thumb = new URL(url).protocol + thumb;
                } catch {
                  thumb = "https:" + thumb;
                }
              }
              if (thumb.startsWith("/")) {
                try {
                  thumb = new URL(thumb, finalUrl || url).href;
                } catch {
                  thumb = "";
                }
              }
              if (thumb && !/^https?:/i.test(thumb)) {
                try {
                  thumb = new URL(thumb, finalUrl || url).href;
                } catch {
                  thumb = "";
                }
              }
              const bodySample = html.slice(0, 8000);
              const blocked =
                /just a moment|cf-browser-verification|attention required|checking your browser|enable javascript|access denied|captcha/i.test(
                  title + " " + bodySample
                );
              const notFound =
                /not\s*found|404|페이지를\s*찾을|존재하지\s*않|no\s*results?|검색\s*결과\s*없|video\s*not\s*found|deleted|removed/i.test(
                  title + " " + bodySample
                );
              const isSearch =
                /\/search/i.test(finalUrl) ||
                /[?&](q|keyword|query|search)=/i.test(finalUrl);
              const keyUpper = expectedKey.toUpperCase();
              const keyLoose = keyUpper.replace(/[-_\s]/g, "");
              const hay = `${title} ${finalUrl}`
                .toUpperCase()
                .replace(/[-_\s]/g, "");
              const keyInPage =
                !expectedKey ||
                (keyLoose.length >= 4 && hay.includes(keyLoose));
              const looksVideoPath =
                /\/(v|video|watch|dm\d*\/v|en\/v|ja\/v)\//i.test(finalUrl);
              let exists = !blocked && !notFound && !isSearch;
              if (exists && expectedKey && !keyInPage) {
                exists = looksVideoPath && !!thumb;
              }
              if (
                exists &&
                expectedKey &&
                keyLoose.length >= 5 &&
                !keyInPage &&
                !thumb
              ) {
                exists = false;
              }
              sendResponse({
                ok: true,
                exists,
                status,
                url,
                finalUrl,
                thumbnail: thumb || "",
                title: title || "",
                keyInPage,
                isSearch,
                notFound,
                source: "background-fetch"
              });
            } catch (error) {
              sendResponse({
                ok: false,
                exists: false,
                error: String(error?.message || error || "probe failed")
              });
            }
          })();
          return { handled: true, keepChannel: true };
        }
        case "FETCH_THUMB": {
          (async () => {
            try {
              const url = String(msg.url || "").trim();
              if (!url) {
                sendResponse({ ok: false, error: "url 없음" });
                return;
              }
              if (url.startsWith("data:image/")) {
                sendResponse({ ok: true, dataUrl: url });
                return;
              }
              if (!/^https?:/i.test(url)) {
                sendResponse({ ok: false, error: "bad url" });
                return;
              }
              const thumbTabId = tabId;
              if (thumbTabId != null && thumbTabId >= 0) {
                try {
                  const tab = await deps.chrome.tabs
                    .get(thumbTabId)
                    .catch(() => null);
                  if (tab?.url) {
                    const tabHost = new URL(tab.url).hostname.replace(/^www\./, "");
                    let urlHost = "";
                    try {
                      urlHost = new URL(url).hostname.replace(/^www\./, "");
                    } catch {
                      urlHost = "";
                    }
                    const sameSite =
                      tabHost &&
                      urlHost &&
                      (tabHost === urlHost ||
                        urlHost.endsWith(tabHost) ||
                        tabHost.endsWith(urlHost) ||
                        /123av|missav|jable|njav|netflav|surrit|javcdn|javplayer/i.test(
                          urlHost
                        ));
                    if (sameSite) {
                      const result = await deps.chrome.tabs
                        .sendMessage(thumbTabId, {
                          type: "FETCH_THUMB_PAGE",
                          url
                        })
                        .catch(() => null);
                      if (result?.ok && result.dataUrl) {
                        sendResponse({
                          ok: true,
                          dataUrl: result.dataUrl,
                          source: "page"
                        });
                        return;
                      }
                    }
                  }
                } catch {
                  /* fall through */
                }
              }
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 10000);
              let res;
              try {
                res = await deps.fetch(url, {
                  method: "GET",
                  signal: ctrl.signal,
                  credentials: "omit",
                  redirect: "follow",
                  cache: "force-cache"
                });
              } finally {
                clearTimeout(timer);
              }
              if (!res.ok) {
                sendResponse({ ok: false, error: `HTTP ${res.status}` });
                return;
              }
              const contentType = (
                res.headers.get("content-type") || ""
              ).toLowerCase();
              if (
                contentType &&
                !contentType.startsWith("image/") &&
                !contentType.includes("octet-stream")
              ) {
                sendResponse({ ok: false, error: "not image" });
                return;
              }
              const buffer = await res.arrayBuffer();
              if (
                !buffer ||
                buffer.byteLength < 80 ||
                buffer.byteLength > 2_500_000
              ) {
                sendResponse({ ok: false, error: "size" });
                return;
              }
              const bytes = new Uint8Array(buffer);
              if (buffer.byteLength < 200 && contentType.includes("gif")) {
                sendResponse({ ok: false, error: "tiny" });
                return;
              }
              let binary = "";
              const chunk = 0x8000;
              for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(
                  null,
                  bytes.subarray(i, i + chunk)
                );
              }
              const mime =
                contentType && contentType.startsWith("image/")
                  ? contentType.split(";")[0]
                  : "image/jpeg";
              const dataUrl = `data:${mime};base64,${deps.btoa(binary)}`;
              sendResponse({
                ok: true,
                dataUrl,
                bytes: buffer.byteLength
              });
            } catch (error) {
              sendResponse({
                ok: false,
                error: String(error?.message || error || "fetch failed")
              });
            }
          })();
          return { handled: true, keepChannel: true };
        }
        case "PROBE_HLS": {
          const tid = msg.tabId ?? tabId;
          const url = msg.url;
          if (url && tid != null) {
            deps.probedUrls.delete(url);
            deps
              .maybeProbeHls(tid, url)
              .then(() =>
                sendResponse({
                  ok: true,
                  item: deps.getTabMap(tid).get(url) || null
                })
              )
              .catch((error) =>
                sendResponse({
                  ok: false,
                  error: String(error.message || error)
                })
              );
            return { handled: true, keepChannel: true };
          }
          sendResponse({ ok: false, error: "no url" });
          return { handled: true, keepChannel: false };
        }
        default:
          return { handled: false, keepChannel: false };
      }
    };
  }

  return { createHandler };
});
