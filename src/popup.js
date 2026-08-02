/**
 * Minimal popup: one best video, one download button. No yt-dlp noise.
 */

let currentTabId = null;
let currentTabUrl = null;
let allItems = [];
let downloading = false;

const $ = (sel) => document.querySelector(sel);
const listEl = $("#list");
const emptyEl = $("#empty");
const pageHost = $("#pageHost");
const progressEl = $("#progress");
const progressFill = $("#progressFill");
const progressText = $("#progressText");

function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return null;
  bytes = Number(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(sec) {
  // Hide junk like 0:00 from tiny/invalid values
  if (sec == null || !Number.isFinite(Number(sec)) || Number(sec) < 1) return null;
  sec = Number(sec);
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Always MP4 for video — no .ts jargon for users */
function formatKind(item) {
  if (item.type === "audio" || (item.mime || "").startsWith("audio/")) {
    return { label: "오디오", ext: ".mp3" };
  }
  return { label: "MP4 동영상", ext: ".mp4" };
}

/** Estimate stream size from average bitrate × duration (rough only) */
function estimateSize(item) {
  if (item.size && item.size > 0) return { bytes: item.size, approx: false };
  if (item.estimatedSize && item.estimatedSize > 0) {
    return { bytes: item.estimatedSize, approx: true };
  }
  const dur = Number(item.duration) || 0;
  // Prefer average bitrate; peak BANDWIDTH alone is often ~2× real file size
  const avgBw = Number(item.estimateBandwidth) || 0;
  const peakBw = Number(item.bandwidth) || 0;
  const bw = avgBw || (peakBw ? Math.round(peakBw * 0.55) : 0);
  if (bw > 0 && dur >= 1) {
    return { bytes: Math.round((bw / 8) * dur), approx: true };
  }
  // rough fallback: segments × ~220KB (2–6s HLS pieces)
  if (item.segmentCount && item.segmentCount > 5) {
    return { bytes: item.segmentCount * 220_000, approx: true };
  }
  return null;
}

function metaRowsHtml(item) {
  const kind = formatKind(item);
  const dur = formatDuration(item.duration);
  const est = estimateSize(item);
  const sizeText = est
    ? est.approx
      ? `약 ${formatSize(est.bytes)}`
      : formatSize(est.bytes)
    : "다운로드 후 확정";
  const quality = item.quality || null;
  const res =
    item.width && item.height ? `${item.width}×${item.height}` : null;
  const qualityText = [quality, res].filter(Boolean).join(" · ") || "—";
  // No segment counts in UI (user request)
  const lengthText = dur || "—";

  const rows = [
    ["형식", "MP4"],
    ["화질", qualityText],
    ["길이", lengthText],
    ["용량", sizeText]
  ];

  return rows
    .map(
      ([k, v]) =>
        `<div class="meta-row"><span class="meta-k">${escapeHtml(k)}</span><span class="meta-v">${escapeHtml(v)}</span></div>`
    )
    .join("");
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function isHlsItem(item) {
  const url = item?.url || "";
  if (/\.m3u8(\?|$|#)/i.test(url)) return true;
  if (/m3u8/i.test(url) && (item.isHls || item.type === "stream")) return true;
  return false;
}

function isUglyName(name) {
  const b = String(name || "")
    .replace(/\.(mp4|webm|ts|m3u8|mp3)$/i, "")
    .replace(/\s*\(\d+p|4K\)\s*/gi, "")
    .trim();
  if (!b || b.length < 2) return true;
  if (/javplayer|surrit|cloudfront|player/i.test(b)) return true;
  if (/^(www\.)?[a-z0-9-]+\.(com|cc|net|tv|io|me)$/i.test(b)) return true;
  if (/\.(com|cc|net|tv)\b/i.test(b) && b.length < 28 && !/[가-힣]/.test(b)) return true;
  if (/\d+x\d+/i.test(b)) return true;
  if (/^\d+[_-]\d+/i.test(b)) return true;
  if (/^(영상|동영상|video|media|audio|다운로드|가능)$/i.test(b)) return true;
  if (/^[a-f0-9]{12,}$/i.test(b)) return true;
  return false;
}

/** Clean page title → readable Korean/Japanese name */
function cleanTitleText(raw) {
  if (!raw) return "";
  let t = String(raw);
  // HTML entities
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  // emoji / symbols
  t = t
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[♥❤💕💗💖💘⭐✨♡]/g, "");
  // site suffixes
  t = t.replace(
    /\s*[\-|–—|·•:]\s*(YouTube|123AV|123av|MissAV|Jable|Netflix|Twitch|Bilibili).*$/i,
    ""
  );
  // strip extension / junk
  t = t
    .replace(/\.(m3u8|mp4|webm|ts|mp3|mkv)$/i, "")
    .replace(/다운로드\s*가능/g, "")
    .replace(/\s*[\(\[]\s*\d{3,4}\s*p\s*[\)\]]/gi, "")
    .replace(/\s+\d{3,4}p\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function siteLabel() {
  try {
    if (pageHost?.textContent && pageHost.textContent !== "—") {
      return pageHost.textContent.replace(/^www\./, "");
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 목록 제목 — 무슨 영상인지 바로 알 수 있게
 * 예: "SSIS-001 이복 여동생이 귀에 키스하는 이야기"
 */
function displayName(item) {
  const candidates = [
    item.title,
    item.pageTitle,
    item.displayName,
    item.filename
  ];
  // 가장 길고 읽기 좋은 제목 선택
  let best = "";
  for (const c of candidates) {
    const cleaned = cleanTitleText(c);
    if (!cleaned || isUglyName(cleaned) || cleaned.length < 2) continue;
    if (cleaned.length > best.length) best = cleaned;
  }
  if (!best) best = "영상";
  if (best.length > 70) best = best.slice(0, 68).trim() + "…";
  return best;
}

/**
 * 저장 파일명 — 제목으로 구분
 * 예: "SSIS-001 이복 여동생 이야기_720p.mp4"
 */
function downloadFilename(item) {
  let base = "";
  for (const c of [item.title, item.pageTitle, item.displayName]) {
    const cleaned = cleanTitleText(c);
    if (cleaned && !isUglyName(cleaned) && cleaned.length > base.length) {
      base = cleaned;
    }
  }
  if (!base || isUglyName(base)) base = "영상";

  if (base.length > 52) {
    base = base.slice(0, 50).replace(/\s+\S*$/, "") || base.slice(0, 50);
  }
  base = base.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();

  const q =
    item.quality &&
    item.quality !== "unknown" &&
    !base.includes(item.quality)
      ? `_${item.quality}`
      : "";
  const ext = item.type === "audio" ? ".mp3" : ".mp4";
  return `${base}${q}${ext}`;
}

function thumbHtml(item) {
  const src = item.thumbnail;
  if (src) {
    return `<img class="thumb-img" src="${escapeAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<span class="thumb-fallback">🎬</span>`;
}

function showProgress(show, percent = 0, text = "") {
  if (!show) {
    progressEl.classList.add("hidden");
    return;
  }
  progressEl.classList.remove("hidden");
  progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  progressText.textContent = text || `받는 중… ${percent}%`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function userError(err) {
  if (!err) return null;
  const s = String(err);

  // Hide all technical URL / English API noise
  if (
    /No URL|URL 없음|url required|invalid url|Invalid URL|not a valid URL|미디어 URL|url is/i.test(
      s
    )
  ) {
    return "받을 주소가 없습니다. 페이지를 새로고침한 뒤 재생해 주세요";
  }
  if (/Failed to fetch|NetworkError|네트워크 접근|CORS|Load failed/i.test(s)) {
    return "네트워크 접근이 막혔습니다. 영상을 재생한 뒤 다시 눌러 주세요";
  }
  if (/재생목록 URL|m3u8|playlist only/i.test(s) && /직접 저장|병합/i.test(s)) {
    return "스트리밍 영상을 합치는 중 문제가 생겼습니다. 다시 시도해 주세요";
  }
  if (/Blob URL|blob/i.test(s) && /Capture|캡처|받을 수/i.test(s)) {
    return "이 영상 형식을 바로 받을 수 없습니다. 재생 후 다시 시도해 주세요";
  }
  if (/yt-dlp|헬퍼|8787|start\.command/i.test(s)) {
    return "이 영상은 지금 받을 수 없습니다";
  }
  if (/DRM|SAMPLE-AES|Widevine/i.test(s)) return "보호된 영상이라 받을 수 없습니다";
  if (/HTTP 403|HTTP 401|접근 거부/i.test(s)) {
    return "접근이 거부되었습니다. 재생 후 다시 시도해 주세요";
  }
  if (/HTTP \d{3}/i.test(s)) {
    return "서버에서 영상을 주지 않았습니다. 재생 후 다시 시도해 주세요";
  }
  if (/너무 작|세그먼트 부족|병합 실패|유효한 세그먼트/i.test(s)) {
    return "영상 데이터를 충분히 받지 못했습니다. 재생 후 다시 시도해 주세요";
  }
  if (/시간 초과|timeout/i.test(s)) return "시간이 초과되었습니다. 다시 시도해 주세요";
  if (/Could not establish connection|Receiving end|Extension context/i.test(s)) {
    return "페이지를 새로고침한 뒤 다시 시도해 주세요";
  }
  if (/offscreen|OFFSCREEN|빈 청크|IndexedDB에 영상/i.test(s)) {
    return "저장 중 문제가 생겼습니다. 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요";
  }
  if (/파일 저장 실패/i.test(s)) {
    return s.length < 120
      ? s
      : "파일 저장에 실패했습니다. chrome://downloads 를 확인해 주세요";
  }
  if (/다운로드가 중단|USER_CANCELED|NETWORK_FAILED/i.test(s)) {
    return "다운로드가 중단되었습니다. 다시 시도해 주세요";
  }

  // Strip technical prefixes; never show raw English "url ..." dumps
  let clean = s.replace(/^Error:\s*/i, "").trim();
  if (/^https?:\/\//i.test(clean) || /url/i.test(clean) && clean.length < 40) {
    return "받을 수 없는 주소입니다. 페이지를 새로고침한 뒤 재생해 주세요";
  }
  // If mostly English technical, soften
  if (/^[A-Za-z0-9\s:./_-]+$/.test(clean) && /url|fetch|http|blob|null|undefined/i.test(clean)) {
    return "다운로드에 실패했습니다. 재생 후 다시 시도해 주세요";
  }
  if (clean.length > 90) return clean.slice(0, 87) + "…";
  return clean || "다운로드에 실패했습니다";
}

function render() {
  // Backend already returns max ~1–2 items; still hard-cap UI to 1
  const items = allItems.slice(0, 1);
  listEl.innerHTML = "";

  if (!items.length) {
    listEl.appendChild(emptyEl);
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  const item = items[0];
  const card = document.createElement("article");
  card.className = "card";

  const name = displayName(item);
  const file = downloadFilename(item);
  // keep in sync for actual download
  item._saveAs = file;

  card.innerHTML = `
    <div class="card-top">
      <div class="thumb">${thumbHtml(item)}</div>
      <div class="meta">
        <div class="name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
        <div class="meta-grid">${metaRowsHtml(item)}</div>
        <div class="filename-box" title="${escapeAttr(file)}">
          <span class="filename-label">저장 이름</span>
          <span class="filename-value">${escapeHtml(file)}</span>
        </div>
      </div>
    </div>
    <div class="card-actions">
      <button type="button" class="btn primary btn-dl">다운로드</button>
    </div>
  `;

  const img = card.querySelector(".thumb-img");
  if (img) {
    img.addEventListener("error", () => {
      img.replaceWith(
        Object.assign(document.createElement("span"), {
          className: "thumb-fallback",
          textContent: "🎬"
        })
      );
    });
  }

  card.querySelector(".btn-dl").addEventListener("click", async (e) => {
    if (downloading) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "받는 중…";
    downloading = true;
    try {
      await downloadItem(item);
    } finally {
      downloading = false;
      btn.disabled = false;
      btn.textContent = "다운로드";
    }
  });

  listEl.appendChild(card);
}

async function downloadItem(item) {
  showProgress(true, 5, "받는 중…");
  let finished = false;
  // Long streams can take many minutes — only warn, don't cancel SW work
  const watchdog = setTimeout(() => {
    if (finished) return;
    toast("아직 받는 중입니다. 팝업을 닫지 말고 기다려 주세요…", "error");
  }, 120_000);

  try {
    const saveName = item._saveAs || downloadFilename(item);
    const res = await chrome.runtime.sendMessage({
      type: isHlsItem(item) ? "DOWNLOAD_HLS" : "DOWNLOAD",
      url: item.url,
      filename: saveName,
      tabId: currentTabId,
      pageUrl: currentTabUrl || item.pageUrl,
      preferQuality: "best",
      mediaType: item.type,
      preferYtDlp: false,
      autoHls: true
    });
    finished = true;
    clearTimeout(watchdog);

    if (res?.ok && res.downloadId != null) {
      const sz = res.size || 0;
      if (sz > 0 && sz < 200_000) {
        showProgress(false);
        toast("파일이 너무 작습니다. 실제 영상이 저장되지 않았을 수 있습니다", "error");
      } else {
        showProgress(true, 100, "저장 완료");
        setTimeout(() => showProgress(false), 1500);
        const mb = sz >= 1024 * 1024 ? `${(sz / 1024 / 1024).toFixed(1)}MB` : "";
        const where = res.path
          ? res.path.split(/[/\\]/).slice(-2).join("/")
          : "다운로드/VideoDownloader";
        toast(mb ? `저장 완료 (${mb}) · ${where}` : `저장 완료 · ${where}`, "ok");
        // Reveal file in Finder / open downloads shelf
        try {
          chrome.downloads.show(res.downloadId);
        } catch {
          try {
            chrome.tabs.create({ url: "chrome://downloads" });
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      showProgress(false);
      toast(
        userError(res?.error) ||
          "다운로드 실패 — 저장이 확인되지 않았습니다",
        "error"
      );
    }
  } catch (e) {
    finished = true;
    clearTimeout(watchdog);
    showProgress(false);
    toast(userError(e?.message) || "다운로드 실패", "error");
  } finally {
    finished = true;
    clearTimeout(watchdog);
  }
}

async function loadMedia() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  currentTabId = tab.id;
  currentTabUrl = tab.url || null;

  try {
    pageHost.textContent = tab.url ? new URL(tab.url).hostname : "—";
  } catch {
    pageHost.textContent = "—";
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" });
  } catch {
    /* restricted */
  }

  let res = await chrome.runtime.sendMessage({
    type: "GET_MEDIA",
    tabId: currentTabId
  });
  allItems = res?.items || [];

  // Ensure thumbnail from page
  if (allItems[0] && !allItems[0].thumbnail) {
    try {
      const meta = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_META" });
      if (meta?.thumbnail || meta?.title) {
        allItems = allItems.map((i) => ({
          ...i,
          thumbnail: i.thumbnail || meta.thumbnail,
          title: i.title || meta.title
        }));
        chrome.runtime
          .sendMessage({
            type: "PAGE_META",
            tabId: currentTabId,
            pageMeta: meta
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  // If HLS missing duration/size, ask background to probe then refresh list
  const first = allItems[0];
  if (first && isHlsItem(first) && !(first.duration >= 1)) {
    try {
      await chrome.runtime.sendMessage({
        type: "PROBE_HLS",
        url: first.url,
        tabId: currentTabId
      });
      // Force re-probe path: send PAGE_MEDIA touch via GET after short wait
      await new Promise((r) => setTimeout(r, 600));
      res = await chrome.runtime.sendMessage({
        type: "GET_MEDIA",
        tabId: currentTabId
      });
      allItems = res?.items || allItems;
    } catch {
      /* ignore */
    }
  }
  render();
}

$("#btnScan").addEventListener("click", async () => {
  $("#btnScan").textContent = "…";
  await loadMedia();
  $("#btnScan").textContent = "↻";
});

$("#btnClear").addEventListener("click", async () => {
  if (currentTabId == null) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_MEDIA", tabId: currentTabId });
  allItems = [];
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "MEDIA_UPDATED" && msg.tabId === currentTabId) {
    allItems = msg.items || [];
    render();
  }
  if (msg.type === "HLS_PROGRESS" && (msg.tabId === currentTabId || msg.tabId === -1)) {
    const p = msg.progress;
    if (!p) return;
    if (p.phase === "error") {
      showProgress(false);
    } else if (p.phase === "done") {
      showProgress(true, 100, "저장 완료");
      setTimeout(() => showProgress(false), 800);
    } else {
      const pct = p.percent || 10;
      // Never surface raw segment counts like "1234/2375"
      let text = `받는 중… ${Math.round(pct)}%`;
      if (p.message && !/\d+\s*\/\s*\d+/.test(p.message) && !/조각|세그먼트|yt-dlp|헬퍼/i.test(p.message)) {
        text = p.message;
      } else if (p.phase === "merge" || /만들|합치/i.test(p.message || "")) {
        text = "파일 만드는 중…";
      } else if (p.phase === "save" || /저장/i.test(p.message || "")) {
        text = "저장 중…";
      }
      showProgress(true, pct, text);
    }
  }
});

loadMedia();
