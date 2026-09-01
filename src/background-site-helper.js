(function initBackgroundSiteHelper(root, factory) {
  const api = factory();
  root.UVDBackgroundSiteHelper = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makeBackgroundSiteHelper() {
  "use strict";

  function createRunner(deps) {
    async function ytdlpExtraFromSettings(pageUrl, force = {}) {
      const s = await deps.UVD.getSettings();
      const mediaMode = force.mediaMode || s.mediaMode || "video";
      const saveThumb =
        force.saveThumbnail !== undefined
          ? force.saveThumbnail
          : s.saveThumbnail !== false;
      return {
        audioOnly: mediaMode === "audio",
        writeSubs: mediaMode === "video_subs",
        writeThumbnail: saveThumb && mediaMode !== "audio",
        mediaMode,
        audioTrackId: force.audioTrackId || "",
        subtitleLanguages: Array.isArray(force.subtitleLanguages)
          ? force.subtitleLanguages
          : [],
        codecPref: s.codecPref || "best",
        speedProfile: s.downloadSpeed || force.speedProfile || "fast",
        yesPlaylist: deps.UVD.isPlaylistOnlyUrl
          ? deps.UVD.isPlaylistOnlyUrl(pageUrl)
          : deps.UVD.isPlaylistUrl(pageUrl),
        subfolder: s.subfolder
      };
    }

    async function collectCookiesForUrl(pageUrl) {
      if (!pageUrl || !deps.chrome.cookies?.getAll) return [];
      try {
        const u = new deps.URL(pageUrl);
        const hosts = new Set([u.hostname, u.hostname.replace(/^www\./, "")]);
        const base = u.hostname.replace(/^www\./, "");
        hosts.add(base);
        hosts.add(`.${base}`);
        if (/tiktok/i.test(base)) {
          [
            "tiktok.com",
            ".tiktok.com",
            "www.tiktok.com",
            "m.tiktok.com",
            "www.tiktokv.com",
            ".tiktokv.com"
          ].forEach((h) => hosts.add(h));
        }
        if (/youtube|youtu\.be/i.test(base)) {
          ["youtube.com", ".youtube.com", "www.youtube.com", ".youtube.co.kr"].forEach((h) =>
            hosts.add(h)
          );
        }
        if (/instagram|instagr\.am/i.test(base)) {
          [
            "instagram.com",
            ".instagram.com",
            "www.instagram.com",
            "cdninstagram.com",
            ".cdninstagram.com"
          ].forEach((h) => hosts.add(h));
        }
        if (/x\.com|twitter\.com|t\.co/i.test(base) || /x\.com|twitter/i.test(pageUrl)) {
          [
            "x.com",
            ".x.com",
            "twitter.com",
            ".twitter.com",
            "www.twitter.com",
            "mobile.twitter.com",
            "api.x.com"
          ].forEach((h) => hosts.add(h));
        }
        if (/facebook|fb\.watch|fb\.com/i.test(base) || /facebook/i.test(pageUrl)) {
          [
            "facebook.com",
            ".facebook.com",
            "www.facebook.com",
            "m.facebook.com",
            "fb.com",
            ".fb.com",
            "fb.watch"
          ].forEach((h) => hosts.add(h));
        }
        if (/bilibili|b23\.tv/i.test(base) || /bilibili/i.test(pageUrl)) {
          [
            "bilibili.com",
            ".bilibili.com",
            "www.bilibili.com",
            "m.bilibili.com",
            "b23.tv",
            ".bilibili.tv"
          ].forEach((h) => hosts.add(h));
        }
        const byKey = new Map();
        for (const host of hosts) {
          try {
            const list = await deps.chrome.cookies.getAll({ domain: host });
            for (const c of list || []) {
              if (!c?.name) continue;
              byKey.set(`${c.domain}|${c.path}|${c.name}`, c);
            }
          } catch {
            // Ignore failures for individual cookie domains.
          }
        }
        try {
          const list = await deps.chrome.cookies.getAll({ url: pageUrl });
          for (const c of list || []) {
            if (!c?.name) continue;
            byKey.set(`${c.domain}|${c.path}|${c.name}`, c);
          }
        } catch {
          // Ignore URL cookie lookup failures.
        }
        return [...byKey.values()].map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || "",
          path: c.path || "/",
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expirationDate || 0
        }));
      } catch {
        return [];
      }
    }

    async function getCookieHeaderForUrl(pageUrl) {
      const list = await collectCookiesForUrl(pageUrl);
      if (!list.length) return "";
      const map = new Map();
      for (const c of list) map.set(c.name, c.value);
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    function normalizeInstagramUrl(raw) {
      try {
        const u = new deps.URL(String(raw || "").trim());
        if (/instagr\.am$/i.test(u.hostname)) {
          u.hostname = "www.instagram.com";
        }
        u.pathname = u.pathname.replace(/\/reels\//i, "/reel/");
        u.search = "";
        u.hash = "";
        if (!u.pathname.endsWith("/")) u.pathname += "/";
        return u.href;
      } catch {
        return String(raw || "").trim();
      }
    }

    async function collectTikTokMediaUrls(tabId, pageUrl) {
      const urls = [];
      const seen = new Set();
      const push = (u) => {
        if (!u || typeof u !== "string" || !u.startsWith("http")) return;
        if (/tiktok\.com\/@|tiktok\.com\/t\//i.test(u) && !deps.isTiktokCdnUrl(u)) return;
        if (!deps.isTiktokCdnUrl(u) && !/mime_type=video|\/video\/tos\//i.test(u)) return;
        const key = u.split("?")[0];
        if (seen.has(key)) return;
        seen.add(key);
        urls.push(u);
      };

      if (tabId != null) {
        try {
          await deps.ensureContentScripts(tabId);
          const ext = await deps.withTimeout(
            deps.chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TIKTOK" }),
            5000,
            "extract"
          );
          for (const u of ext?.urls || []) push(u);
        } catch {
          // Use captured network items.
        }
        for (const item of deps.getTabItems(tabId)) push(item.url);
      }
      return urls;
    }

    async function downloadDirectMediaUrl(tabId, mediaUrl, pageUrl, filename) {
      if (!deps.looksLikeVideoFileUrl(mediaUrl)) {
        throw new Error("영상 파일이 아닌 주소입니다");
      }
      const name = deps.safeDownloadName(
        filename || `tiktok_${deps.now()}.mp4`,
        "video/mp4"
      );
      const blob = await deps.withTabReferer(tabId, async () => {
        const res = await deps.fetch(mediaUrl, {
          credentials: "include",
          cache: "no-store",
          headers: {
            Accept: "video/mp4,video/*,*/*;q=0.8",
            Referer: pageUrl || "https://www.tiktok.com/"
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ctype = (res.headers.get("content-type") || "").toLowerCase();
        if (
          ctype.includes("javascript") ||
          ctype.includes("text/html") ||
          ctype.includes("text/css") ||
          ctype.includes("application/json") ||
          ctype.includes("image/")
        ) {
          throw new Error(`영상이 아닌 응답 (${ctype || "unknown"})`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 100_000) {
          throw new Error(`파일이 너무 작음 (${Math.round(buf.byteLength / 1024)}KB)`);
        }
        const head = new deps.Uint8Array(buf.slice(0, 16));
        if (!deps.sniffIsVideo(head)) {
          throw new Error("영상 바이너리가 아닙니다 (이미지/기타 파일 제외)");
        }
        return new deps.Blob([buf], {
          type: ctype.startsWith("video/") ? ctype : "video/mp4"
        });
      });
      if (!blob || blob.size < 100_000) return null;
      const saved = await deps.downloadBlob(blob, name);
      return { ok: true, ...saved, method: "tiktok-fetch-blob" };
    }

    function assignHelperJobId(progress, jid) {
      if (!progress.helperJobId || !jid) return;
      const job = deps.getActiveDownload(jid);
      if (job) job.helperJobId = progress.helperJobId;
    }

    async function downloadTikTok(
      tabId,
      pageUrl,
      filename,
      preferQuality,
      jobId = null,
      forceOpts = {}
    ) {
      const jid = jobId || deps.getCurrentJobContext();
      const targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : "";
      if (!targetPage) throw new Error("TikTok 페이지 주소가 없습니다");
      if (
        !deps.isTiktokUrl(targetPage) &&
        !/vm\.tiktok\.com|vt\.tiktok\.com/i.test(targetPage)
      ) {
        throw new Error("TikTok 영상 링크가 아닙니다");
      }
      deps.emitDownloadProgress(tabId, 8, "TikTok 링크로 받는 중…", "start", jid);
      const helperUp = await deps.YtDlp.available().catch(() => false);
      if (!helperUp) {
        throw new Error(
          "TikTok은 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
        );
      }
      const cookieHeader = await getCookieHeaderForUrl(targetPage);
      let mediaUrl;
      try {
        const urls = (await collectTikTokMediaUrls(tabId, targetPage)).filter(
          deps.looksLikeVideoFileUrl
        );
        mediaUrl = urls[0];
      } catch {
        mediaUrl = undefined;
      }
      try {
        const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
        const nameHint = deps.ytdlpFilenameHint(filename);
        const result = await deps.YtDlp.downloadAndWait(
          {
            url: targetPage,
            pageUrl: targetPage,
            filename: nameHint || undefined,
            title: nameHint || undefined,
            quality: preferQuality || "best",
            site: "tiktok",
            cookieHeader: cookieHeader || undefined,
            mediaUrl:
              mediaUrl && deps.looksLikeVideoFileUrl(mediaUrl) ? mediaUrl : undefined,
            ...extra
          },
          (p) => {
            deps.throwIfJobStopped(jid);
            assignHelperJobId(p, jid);
            let message = p.message || "받는 중…";
            if (/\[download\]/i.test(message)) {
              message = `받는 중… ${Math.round(p.percent || 0)}%`;
            }
            if (/TikTok 링크 해석|공개 API|tikwm|직접/i.test(message)) {
              message = message.slice(0, 80);
            }
            if (/IP address is blocked|blocked from accessing/i.test(message)) {
              message = "TikTok 접근이 막혔습니다. 링크 붙여넣기로 다시 시도해 주세요";
            }
            const pct = Math.min(98, Math.max(2, Number(p.percent) || 10));
            deps.emitDownloadProgress(tabId, pct, message, "download", jid);
          },
          15 * 60 * 1000
        );
        deps.emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return {
          ok: true,
          method: result.method || "yt-dlp",
          downloadId: null,
          ytdlp: true,
          path: result.path || result.outDir || "",
          outDir: result.outDir || "",
          filename: result.filename || filename,
          size: result.size || 0
        };
      } catch (e) {
        const msg = String(e?.message || e);
        throw new Error(
          /TikTok|재생|링크|막혔|도우미/i.test(msg)
            ? msg
            : `TikTok 다운로드 실패. 공유 링크를 복사해 위 「영상 링크 붙여넣기」에 넣고 받아 주세요. (${msg.slice(0, 60)})`
        );
      }
    }

    async function downloadViaYtDlp(
      tabId,
      url,
      pageUrl,
      filename,
      preferQuality,
      jobId = null,
      forceOpts = {}
    ) {
      const jid = jobId || deps.getCurrentJobContext();
      const targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : url;
      const kind = deps.siteKind(url, targetPage);
      if (kind === "tiktok") {
        return downloadTikTok(tabId, targetPage, filename, preferQuality, jid, forceOpts);
      }
      if (kind === "instagram") {
        return downloadInstagram(tabId, targetPage, filename, preferQuality, jid, forceOpts);
      }
      const available = await deps.YtDlp.available();
      if (!available) {
        throw new Error(
          "소셜 사이트 받기에는 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
        );
      }
      const labelMap = {
        youtube: "YouTube",
        x: "X",
        facebook: "Facebook",
        bilibili: "Bilibili"
      };
      const label = labelMap[kind] || "영상";
      deps.emitDownloadProgress(tabId, 4, `${label} 준비 중…`, "start", jid);
      const needsCookieList =
        kind === "x" || kind === "facebook" || kind === "bilibili";
      const [cookieHeader, cookiesList] = await Promise.all([
        getCookieHeaderForUrl(targetPage),
        needsCookieList ? collectCookiesForUrl(targetPage) : Promise.resolve(undefined)
      ]);
      if (needsCookieList && cookiesList?.length) {
        deps.emitDownloadProgress(
          tabId,
          5,
          `${label} 받는 중… (쿠키 ${cookiesList.length}개)`,
          "start",
          jid
        );
      }
      const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
      if (extra.audioOnly) {
        deps.emitDownloadProgress(tabId, 5, "오디오만 추출 중…", "start", jid);
      } else if (extra.writeSubs) {
        deps.emitDownloadProgress(tabId, 5, "영상+자막 받는 중…", "start", jid);
      }
      const nameHint = deps.ytdlpFilenameHint(filename);
      const result = await deps.YtDlp.downloadAndWait(
        {
          url: targetPage,
          pageUrl: targetPage,
          filename: nameHint || undefined,
          title: nameHint || undefined,
          quality: preferQuality || "best",
          site: kind || undefined,
          cookieHeader: cookieHeader || undefined,
          cookiesList: cookiesList?.length ? cookiesList : undefined,
          ...extra
        },
        (p) => {
          deps.throwIfJobStopped(jid);
          assignHelperJobId(p, jid);
          let message = p.message || "받는 중…";
          if (/Merging|Merger|합치/i.test(message)) {
            message = "파일 합치는 중… (시간이 걸릴 수 있어요)";
          } else if (/추가 트랙|단계/.test(message)) {
            // Keep helper-localized multi-stage text.
          } else if (/\[download\]/i.test(message) && !/받는 중/.test(message)) {
            message = `받는 중… ${Math.round(p.percent || 0)}%`;
          } else if (
            /Destination|Writing|subtitle|마무리/i.test(message) &&
            !/받는 중|합치|트랙/.test(message)
          ) {
            message = "마무리 중…";
          }
          if (/ERROR/i.test(message)) message = message.slice(0, 120);
          const pct = Math.min(98, Math.max(2, Number(p.percent) || 10));
          deps.emitDownloadProgress(tabId, pct, message, p.status || "download", jid);
        },
        40 * 60 * 1000
      );
      deps.emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
      return {
        ok: true,
        method: "yt-dlp",
        downloadId: null,
        ytdlp: true,
        path: result.path || result.outDir || "",
        outDir: result.outDir || "",
        filename: result.filename || nameHint || filename,
        size: result.size || 0
      };
    }

    async function downloadInstagram(
      tabId,
      pageUrl,
      filename,
      preferQuality,
      jobId = null,
      forceOpts = {}
    ) {
      const jid = jobId || deps.getCurrentJobContext();
      let targetPage = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : "";
      targetPage = normalizeInstagramUrl(targetPage);
      if (!targetPage || !deps.isInstagramUrl(targetPage)) {
        throw new Error(
          "Instagram 게시물 링크가 아닙니다. /p/… 또는 /reel/… 주소를 붙여 넣어 주세요"
        );
      }
      deps.emitDownloadProgress(tabId, 5, "Instagram 준비 중…", "start", jid);
      if (tabId != null) {
        try {
          await deps.ensureContentScripts(tabId);
          await deps.chrome.tabs.sendMessage(tabId, { type: "SCAN_NOW" }).catch(() => {});
          await deps.chrome.tabs
            .sendMessage(tabId, { type: "EXTRACT_INSTAGRAM" })
            .catch(() => {});
        } catch {
          // Use captured items.
        }
        await new Promise((resolve) => deps.setTimeout(resolve, 400));
        const items = deps.getTabItems(tabId);
        if (items.length) {
          const cdns = items.map((i) => i.url).filter((u) => deps.isInstagramCdnUrl(u));
          for (const mediaUrl of cdns.slice(0, 5)) {
            try {
              deps.emitDownloadProgress(
                tabId,
                18,
                "재생 스트림 저장 중…",
                "download",
                jid
              );
              const saved = await downloadDirectMediaUrl(
                tabId,
                mediaUrl,
                targetPage,
                filename
              );
              if (saved?.ok || saved?.downloadId != null) {
                deps.emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
                return {
                  ok: true,
                  downloadId: saved.downloadId ?? null,
                  path: saved.path || "",
                  filename: saved.filename || filename,
                  size: saved.size || 0,
                  method: saved.method || "instagram-cdn",
                  ytdlp: false
                };
              }
            } catch (e) {
              deps.console.warn("[UVD] instagram CDN", e);
            }
          }
        }
      }
      const helperUp = await deps.YtDlp.available().catch(() => false);
      if (!helperUp) {
        throw new Error(
          "Instagram은 로컬 도우미가 필요합니다. helper/install_autostart.command 를 실행해 주세요"
        );
      }
      const [cookiesList, cookieHeader] = await Promise.all([
        collectCookiesForUrl("https://www.instagram.com/"),
        getCookieHeaderForUrl("https://www.instagram.com/")
      ]);
      if (!cookiesList.length) {
        throw new Error(
          "Instagram 로그인 쿠키가 없습니다. Chrome에서 instagram.com 에 로그인한 뒤 다시 시도해 주세요"
        );
      }
      deps.emitDownloadProgress(
        tabId,
        28,
        `Instagram 받는 중… (쿠키 ${cookiesList.length}개)`,
        "download",
        jid
      );
      try {
        const extra = await ytdlpExtraFromSettings(targetPage, forceOpts);
        const nameHint = deps.ytdlpFilenameHint(filename);
        const result = await deps.YtDlp.downloadAndWait(
          {
            url: targetPage,
            pageUrl: targetPage,
            filename: nameHint || undefined,
            title: nameHint || undefined,
            quality: preferQuality || "best",
            site: "instagram",
            cookieHeader: cookieHeader || undefined,
            cookiesList,
            ...extra
          },
          (p) => {
            deps.throwIfJobStopped(jid);
            assignHelperJobId(p, jid);
            let message = p.message || "받는 중…";
            if (/\[download\]/i.test(message)) {
              message = `받는 중… ${Math.round(p.percent || 0)}%`;
            }
            if (/login|log in|not logged|empty media|rate-limit|403|400/i.test(message)) {
              message =
                "Instagram 인증 문제 — 브라우저에서 로그인·새로고침 후 링크를 다시 붙여 넣어 주세요";
            }
            const pct = Math.min(98, Math.max(2, Number(p.percent) || 28));
            deps.emitDownloadProgress(tabId, pct, message, "download", jid);
          },
          20 * 60 * 1000
        );
        deps.emitDownloadProgress(tabId, 100, "저장 완료", "done", jid);
        return {
          ok: true,
          method: result.method || "yt-dlp",
          downloadId: null,
          ytdlp: true,
          path: result.path || result.outDir || "",
          outDir: result.outDir || "",
          filename: result.filename || filename,
          size: result.size || 0
        };
      } catch (e) {
        const msg = String(e?.message || e);
        if (/login|cookie|empty media|not granting|400|403|rate/i.test(msg)) {
          throw new Error(
            "Instagram 다운로드 실패. ① Chrome에서 로그인 ② 게시물/릴스를 한 번 열기 ③ 공유 링크를 다시 붙여 넣기"
          );
        }
        throw new Error(
          /Instagram|로그인|도우미/i.test(msg)
            ? msg
            : `Instagram 다운로드 실패: ${msg.slice(0, 80)}`
        );
      }
    }

    return {
      ytdlpExtraFromSettings,
      collectCookiesForUrl,
      collectCookies: collectCookiesForUrl,
      getCookieHeaderForUrl,
      getCookieHeader: getCookieHeaderForUrl,
      normalizeInstagramUrl,
      collectTikTokMediaUrls,
      downloadDirectMediaUrl,
      downloadDirect: downloadDirectMediaUrl,
      downloadTikTok,
      downloadInstagram,
      downloadViaYtDlp,
      download: downloadViaYtDlp
    };
  }

  return { createRunner };
});
