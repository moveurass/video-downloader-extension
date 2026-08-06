#!/usr/bin/env python3
"""
Local companion for Universal Video Downloader.
Wraps yt-dlp so the Chrome extension can download many more sites.

Usage:
  python3 helper/yt_dlp_server.py

Requires:
  pip install -U yt-dlp
  # or: brew install yt-dlp

Default: http://127.0.0.1:8787
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = int(os.environ.get("UVD_PORT", "8787"))
HOME = Path.home()
OUT_DIR = Path(os.environ.get("UVD_OUT", HOME / "Downloads" / "VideoDownloader"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
COOKIE_DIR = Path(os.environ.get("UVD_COOKIE_DIR", HOME / ".cache" / "uvd-helper"))
COOKIE_DIR.mkdir(parents=True, exist_ok=True)


def write_netscape_cookies(cookies: list, path: Path) -> int:
    """
    Write Chrome-exported cookies (list of dicts) as Netscape format for yt-dlp.
    dict keys: name, value, domain, path, secure, expirationDate
    """
    lines = ["# Netscape HTTP Cookie File", "# https://curl.se/docs/http-cookies.html", ""]
    n = 0
    for c in cookies or []:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "")
        value = str(c.get("value") or "")
        if not name:
            continue
        domain = str(c.get("domain") or "")
        if not domain:
            continue
        # Netscape: subdomain flag TRUE if domain starts with .
        flag = "TRUE" if domain.startswith(".") else "FALSE"
        cpath = str(c.get("path") or "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        try:
            exp = int(float(c.get("expirationDate") or 0))
        except (TypeError, ValueError):
            exp = 0
        if exp <= 0:
            exp = int(time.time()) + 3600 * 24 * 30
        # tab-separated
        lines.append(f"{domain}\t{flag}\t{cpath}\t{secure}\t{exp}\t{name}\t{value}")
        n += 1
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return n


# ─── TikTok (SnapTik / TikWM style multi-path resolver) ─────


def is_tiktok_page(url: str) -> bool:
    try:
        h = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not h:
        return False
    if "tiktokcdn" in h or "byteicdn" in h or "byteoversea" in h:
        return False
    return "tiktok.com" in h or h.endswith("tiktokv.com")


def clean_tiktok_url(url: str) -> str:
    """Normalize share / short links to a stable form for APIs."""
    u = (url or "").strip()
    if not u:
        return u
    # strip tracking query noise but keep path
    try:
        p = urlparse(u)
        # keep only essential query if any (usually none for /@user/video/id)
        q = parse_qs(p.query)
        keep = {}
        for k in ("_d", "is_from_webapp", "sender_device", "item_id"):
            if k in q:
                keep[k] = q[k][0]
        u = urlunparse((p.scheme, p.netloc, p.path, "", urlencode(keep), ""))
    except Exception:
        pass
    return u.rstrip("/")


def walk_json_for_media(obj, out: list[str], depth: int = 0) -> None:
    if depth > 40 or obj is None:
        return
    if isinstance(obj, str):
        if obj.startswith("http") and re.search(
            r"tiktokcdn|byteicdn|tiktokv\.com|byteoversea|musical\.ly", obj, re.I
        ):
            if not re.search(r"\.(jpe?g|png|webp|gif)(\?|$)", obj, re.I) or re.search(
                r"video|play|media|mime_type=video", obj, re.I
            ):
                out.append(obj)
        return
    if isinstance(obj, list):
        for x in obj[:200]:
            walk_json_for_media(x, out, depth + 1)
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if kl in (
                "playaddr",
                "downloadaddr",
                "play_addr",
                "download_addr",
                "play",
                "hdplay",
                "wmplay",
                "nwm_video_url",
                "nwm_video_url_hq",
            ) and isinstance(v, str):
                walk_json_for_media(v, out, depth + 1)
            elif kl in ("url_list", "urlList") and isinstance(v, list):
                for x in v:
                    walk_json_for_media(x, out, depth + 1)
            else:
                walk_json_for_media(v, out, depth + 1)


def http_post_form(url: str, fields: dict, headers: dict | None = None, timeout: int = 25) -> dict | None:
    data = urlencode(fields).encode("utf-8")
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/plain, */*",
    }
    if headers:
        hdrs.update(headers)
    try:
        req = Request(url, data=data, headers=hdrs, method="POST")
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw)
    except Exception:
        return None


def http_get_json(url: str, headers: dict | None = None, timeout: int = 25) -> dict | None:
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    if headers:
        hdrs.update(headers)
    try:
        req = Request(url, headers=hdrs, method="GET")
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw)
    except Exception:
        return None


def resolve_tiktok_via_public_apis(page_url: str) -> dict | None:
    """
    Same idea as SnapTik / TikWM web tools: call a resolve API with the page link.
    Returns {play_url, title, cover, method} or None.
    """
    u = clean_tiktok_url(page_url)
    candidates: list[tuple[str, dict | None]] = []

    # 1) TikWM (widely used free resolver)
    r = http_post_form(
        "https://www.tikwm.com/api/",
        {"url": u, "hd": "1"},
        headers={"Referer": "https://www.tikwm.com/"},
    )
    if r and (r.get("code") == 0 or r.get("code") == "0") and isinstance(r.get("data"), dict):
        d = r["data"]
        play = d.get("hdplay") or d.get("play") or d.get("wmplay")
        if play:
            return {
                "play_url": play,
                "title": d.get("title") or d.get("id") or "tiktok",
                "cover": d.get("cover") or d.get("origin_cover"),
                "id": str(d.get("id") or ""),
                "method": "tikwm",
                "duration": d.get("duration"),
            }

    # 2) tikwm alternative query style
    r = http_get_json(
        "https://www.tikwm.com/api/?" + urlencode({"url": u, "hd": "1"}),
        headers={"Referer": "https://www.tikwm.com/"},
    )
    if r and (r.get("code") == 0 or r.get("code") == "0") and isinstance(r.get("data"), dict):
        d = r["data"]
        play = d.get("hdplay") or d.get("play") or d.get("wmplay")
        if play:
            return {
                "play_url": play,
                "title": d.get("title") or "tiktok",
                "cover": d.get("cover"),
                "id": str(d.get("id") or ""),
                "method": "tikwm-get",
            }

    # 3) Generic third-party (may change; best-effort)
    for api in (
        "https://api.tiklydown.eu.org/api/download?" + urlencode({"url": u}),
        "https://tikdown.org/getAjax?" + urlencode({"url": u}),
    ):
        try:
            r = http_get_json(api)
            if not r:
                continue
            # various shapes
            data = r.get("data") or r.get("result") or r
            if isinstance(data, dict):
                play = (
                    data.get("play")
                    or data.get("hdplay")
                    or data.get("video")
                    or data.get("nwm_video_url")
                    or data.get("nwm_video_url_hq")
                )
                if isinstance(play, list) and play:
                    play = play[0]
                if play and str(play).startswith("http"):
                    return {
                        "play_url": str(play),
                        "title": data.get("title") or data.get("desc") or "tiktok",
                        "cover": data.get("cover") or data.get("author_avatar"),
                        "method": "public-api",
                    }
        except Exception:
            continue

    return None


def _sniff_is_video(head: bytes) -> bool:
    if not head or len(head) < 12:
        return False
    # Reject images
    if head[:2] == b"BM":  # BMP
        return False
    if head[:3] == b"\xff\xd8\xff":  # JPEG
        return False
    if head[:8] == b"\x89PNG\r\n\x1a\n":  # PNG
        return False
    if head[:4] == b"GIF8":
        return False
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return False
    # Video containers
    if len(head) >= 8 and head[4:8] == b"ftyp":  # MP4/MOV
        return True
    if head[:4] == b"\x1aE\xdf\xa3":  # WebM/MKV
        return True
    if head[:1] == b"G":  # MPEG-TS sync
        return True
    return False


def download_url_to_file(
    media_url: str,
    dest: Path,
    referer: str = "https://www.tiktok.com/",
    cookie_header: str = "",
) -> int:
    """Stream download media_url to dest. Returns bytes written. Rejects non-video."""
    # Block obvious non-video URLs
    if re.search(r"\.(js|css|json|bmp|jpe?g|png|gif|webp|svg)(\?|$)", media_url, re.I):
        raise ValueError("not a video url")
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": referer or "https://www.tiktok.com/",
        "Accept": "video/mp4,video/*,*/*;q=0.8",
        "Origin": "https://www.tiktok.com",
    }
    if cookie_header:
        hdrs["Cookie"] = cookie_header
    req = Request(media_url, headers=hdrs, method="GET")
    written = 0
    first = b""
    with urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if any(x in ctype for x in ("javascript", "text/html", "text/css", "image/", "json")):
            raise ValueError(f"bad content-type {ctype}")
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            if written == 0:
                first = chunk[:16]
                if not _sniff_is_video(first) and not ctype.startswith("video/"):
                    raise ValueError("response is not a video file")
            f.write(chunk)
            written += len(chunk)
    if written < 100_000:
        raise ValueError(f"file too small ({written})")
    return written


def try_tiktok_direct_download(job_id: str, payload: dict, outtmpl_base: str) -> bool:
    """
    SnapTik-style path: resolve play URL via public API or client-provided mediaUrl,
    then download bytes. Returns True if job completed successfully.
    """
    page_url = (payload.get("pageUrl") or payload.get("url") or "").strip()
    media_hint = (payload.get("mediaUrl") or "").strip()
    cookie_header = (payload.get("cookieHeader") or "").strip()
    title_hint = (payload.get("filename") or payload.get("title") or "tiktok").strip()

    play_url = ""
    title = title_hint
    method = ""

    if media_hint and media_hint.startswith("http") and "tiktok.com/@" not in media_hint:
        play_url = media_hint
        method = "client-cdn"

    if not play_url and is_tiktok_page(page_url):
        with jobs_lock:
            jobs[job_id]["message"] = "TikTok 링크 해석 중… (공개 API)"
            jobs[job_id]["percent"] = 8
        resolved = resolve_tiktok_via_public_apis(page_url)
        if resolved and resolved.get("play_url"):
            play_url = resolved["play_url"]
            title = resolved.get("title") or title
            method = resolved.get("method") or "public-api"

    if not play_url:
        return False

    # Build output path
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title)
    safe = re.sub(r"^\(\d{1,4}\)\s*", "", safe)
    safe = " ".join(safe.split()).strip(" ._-" )[:80] or "tiktok"
    dest = OUT_DIR / f"{safe}.mp4"
    # uniquify
    if dest.exists():
        i = 2
        while True:
            cand = OUT_DIR / f"{safe} ({i}).mp4"
            if not cand.exists():
                dest = cand
                break
            i += 1

    with jobs_lock:
        jobs[job_id]["message"] = f"TikTok 받는 중… ({method})"
        jobs[job_id]["percent"] = 15
        jobs[job_id]["target"] = play_url[:120]

    try:
        size = download_url_to_file(
            play_url,
            dest,
            referer=page_url or "https://www.tiktok.com/",
            cookie_header=cookie_header,
        )
        if size < 50_000:
            try:
                dest.unlink(missing_ok=True)
            except Exception:
                pass
            return False
        with jobs_lock:
            jobs[job_id].update(
                {
                    "status": "done",
                    "percent": 100,
                    "message": f"저장 완료 → {dest}",
                    "path": str(dest),
                    "filename": dest.name,
                    "size": size,
                    "method": f"tiktok-{method}",
                    "finishedAt": time.time(),
                }
            )
        return True
    except Exception as e:
        with jobs_lock:
            jobs[job_id]["message"] = f"TikTok 직접 저장 실패: {e}"
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        return False


def find_ytdlp() -> str | None:
    for name in ("yt-dlp", "yt-dlp_macos", "youtube-dl"):
        path = shutil.which(name)
        if path:
            return path
    # common user install locations
    candidates = [
        HOME / ".local" / "bin" / "yt-dlp",
        Path("/opt/homebrew/bin/yt-dlp"),
        Path("/usr/local/bin/yt-dlp"),
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def ytdlp_version(bin_path: str) -> str:
    try:
        out = subprocess.check_output([bin_path, "--version"], text=True, timeout=8)
        return out.strip()
    except Exception:
        return "unknown"


def cors(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return {}


def send_json(handler: BaseHTTPRequestHandler, code: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    cors(handler)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def run_download(job_id: str, payload: dict) -> None:
    bin_path = find_ytdlp()
    url = (payload.get("url") or "").strip()
    page_url = (payload.get("pageUrl") or payload.get("referer") or "").strip()
    quality = (payload.get("quality") or "best").strip()
    title_hint = (payload.get("filename") or payload.get("title") or "").strip()

    with jobs_lock:
        jobs[job_id].update(
            {
                "status": "running",
                "percent": 2,
                "message": "시작…",
                "startedAt": time.time(),
            }
        )

    if not url and not page_url:
        with jobs_lock:
            jobs[job_id].update(
                {"status": "error", "message": "URL 없음", "error": "no url"}
            )
        return

    # Prefer page URL when both given (site extractors work on watch pages)
    target = page_url if page_url and page_url.startswith("http") else url

    # ── TikTok first: SnapTik/TikWM-style resolve (no yt-dlp required) ──
    site_early = (payload.get("site") or "").lower()
    if (
        site_early == "tiktok"
        or is_tiktok_page(target)
        or is_tiktok_page(page_url)
        or (payload.get("mediaUrl") or "").strip()
    ):
        try:
            if try_tiktok_direct_download(job_id, payload, title_hint):
                return
        except Exception as e:
            with jobs_lock:
                jobs[job_id]["message"] = f"TikTok 직접 경로 실패, yt-dlp 시도… ({e})"

    if not bin_path:
        with jobs_lock:
            jobs[job_id].update(
                {
                    "status": "error",
                    "percent": 0,
                    "message": "다운로드 실패 (TikTok 해석 실패 + yt-dlp 없음)",
                    "error": "yt-dlp not found",
                }
            )
        return
    # If user passed a direct m3u8/mp4, use that
    if url and (
        ".m3u8" in url
        or url.endswith((".mp4", ".webm", ".mkv"))
        or "m3u8" in url.lower()
    ):
        # still try page first if looks like a site page was also provided
        if page_url and "://" in page_url and ".m3u8" not in page_url:
            target = page_url
        else:
            target = url

    # output template — clean human names (no "(2) " notification prefix, no "_best")
    def clean_name(raw: str) -> str:
        s = (raw or "").strip()
        # strip extension
        for ext in (".mp4", ".ts", ".webm", ".mkv", ".m4a", ".mp3"):
            if s.lower().endswith(ext):
                s = s[: -len(ext)]
        # notification / tab counters: "(2) title"
        s = re.sub(r"^\(\d{1,4}\)\s*", "", s)
        s = re.sub(r"^\[\d{1,4}\]\s*", "", s)
        # useless quality tags we sometimes pass from the extension
        s = re.sub(r"[_\s-]*(best|all|unknown)$", "", s, flags=re.I)
        s = re.sub(r"[_\s-]*(best|all)[_\s-]*", " ", s, flags=re.I)
        s = "".join(c if c not in '<>:"/\\|?*' else " " for c in s)
        s = " ".join(s.split()).strip(" ._-" )[:80]
        return s or "video"

    if title_hint:
        safe = clean_name(title_hint)
        # Readable old-style names: keep spaces + unicode (no restrict-filenames)
        outtmpl = str(OUT_DIR / f"{safe}.%(ext)s")
    else:
        # Real video title from extractor — keep spaces/unicode so names stay readable
        # (e.g. "SSIS-001 이복 여동생 이야기.mp4")
        # Use .s (chars) not .B (bytes) so Korean titles are not cut mid-glyph.
        outtmpl = str(OUT_DIR / "%(title).100s.%(ext)s")

    site = (payload.get("site") or "").lower()
    host = ""
    try:
        host = urlparse(target).hostname or ""
    except Exception:
        host = ""

    is_youtube = site == "youtube" or "youtube" in host or "youtu.be" in target
    is_tiktok = site == "tiktok" or "tiktok" in host
    is_instagram = (
        site == "instagram"
        or "instagram.com" in host
        or "instagr.am" in host
        or "instagram.com" in target
    )
    is_x = (
        site in ("x", "twitter")
        or host in ("x.com", "twitter.com", "t.co", "mobile.twitter.com")
        or host.endswith(".x.com")
        or host.endswith(".twitter.com")
        or "x.com/" in target
        or "twitter.com/" in target
    )
    is_facebook = (
        site == "facebook"
        or "facebook.com" in host
        or host in ("fb.watch", "fb.com")
        or host.endswith(".facebook.com")
        or "facebook.com/" in target
        or "fb.watch/" in target
    )
    is_bilibili = (
        site == "bilibili"
        or "bilibili.com" in host
        or host == "b23.tv"
        or "bilibili.tv" in host
        or "bilibili.com/" in target
        or "b23.tv/" in target
    )

    # Normalize Instagram URLs for yt-dlp
    if is_instagram and target:
        try:
            p = urlparse(target)
            path = p.path.replace("/reels/", "/reel/")
            if not path.endswith("/"):
                path += "/"
            target = urlunparse((p.scheme or "https", p.netloc, path, "", "", ""))
        except Exception:
            pass

    # Write browser cookies (from extension) to Netscape file — required for Instagram
    cookies_file: str | None = None
    cookies_list = payload.get("cookiesList") or payload.get("cookies")
    if isinstance(cookies_list, list) and cookies_list:
        try:
            cpath = COOKIE_DIR / f"cookies_{job_id}.txt"
            n = write_netscape_cookies(cookies_list, cpath)
            if n > 0:
                cookies_file = str(cpath)
        except Exception as e:
            print(f"[uvd-helper] cookie write failed: {e}", file=sys.stderr)

    # ── format selection (maximize quality; never re-encode) ──
    # YouTube serves separate video/audio streams. Must pick best of each + merge.
    # Avoid forcing android client — it often caps at 360p/720p.
    merge_fmt = "mp4"
    sort_args: list[str] = []
    codec_pref = (payload.get("codecPref") or "best").strip().lower()
    if codec_pref not in ("best", "h264", "compat", "avc"):
        codec_pref = "best"
    if codec_pref == "avc":
        codec_pref = "h264"

    def height_fmt(h: str | None, dash: bool = True) -> str:
        """Build format string with optional height cap + codec preference."""
        if dash:
            if codec_pref in ("h264", "compat"):
                # Prefer AVC (+ AAC for compat), fall back to any
                if h:
                    return (
                        f"bv*[height<=?{h}][vcodec^=avc1]+ba[acodec^=mp4a]/"
                        f"bv*[height<=?{h}][vcodec^=avc1]+ba/"
                        f"bv*[height<=?{h}]+ba/b[height<=?{h}]/bv*+ba/b"
                    )
                return (
                    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/"
                    "bv*[vcodec^=avc1]+ba/"
                    "bv*+ba/b"
                )
            # best quality: any codec
            if h:
                return f"bv*[height<=?{h}]+ba/b[height<=?{h}]/bv*+ba/b"
            return "bv*+ba/b"
        # progressive single file
        if h:
            return f"b[height<=?{h}]/b"
        return "b"

    if is_instagram:
        # Instagram posts are usually progressive mp4; cookies required for many posts
        if quality in ("best", "all", "", "4K", "max", "highest"):
            fmt = "best"
        elif quality.endswith("p") and quality[:-1].isdigit():
            h = quality[:-1]
            fmt = f"b[height<=?{h}]/best"
        else:
            fmt = "best"
        merge_fmt = "mp4"
        sort_args = ["-S", "res,tbr"]
    elif is_tiktok:
        # TikTok is usually one progressive file; keep simple selectors
        if quality in ("best", "all", "", "4K", "max", "highest"):
            fmt = height_fmt(None, dash=False)
        elif quality.endswith("p") and quality[:-1].isdigit():
            fmt = height_fmt(quality[:-1], dash=False)
        else:
            fmt = "b"
        merge_fmt = "mp4"
    elif is_youtube or is_bilibili:
        # Max resolution + best audio. Bilibili also often uses DASH-like streams.
        if quality in ("best", "all", "", "4K", "2160p", "max", "highest"):
            fmt = height_fmt(None, dash=True)
        elif quality == "1440p":
            fmt = height_fmt("1440", dash=True)
        elif quality == "1080p":
            fmt = height_fmt("1080", dash=True)
        elif quality == "720p":
            fmt = height_fmt("720", dash=True)
        elif quality.endswith("p") and quality[:-1].isdigit():
            fmt = height_fmt(quality[:-1], dash=True)
        else:
            fmt = height_fmt(None, dash=True)
        if codec_pref in ("h264", "compat"):
            sort_args = ["-S", "res,codec:h264:vp9:av01,fps,tbr"]
            merge_fmt = "mp4"
        else:
            sort_args = ["-S", "res,fps,hdr:12,vbr,tbr,abr,asr"]
            # mkv accepts VP9/AV1+Opus without re-encode
            merge_fmt = "mkv"
    elif is_x or is_facebook:
        # Often progressive or simple streams; cookies help a lot
        if quality in ("best", "all", "", "4K", "max", "highest"):
            fmt = "bv*+ba/b"
        elif quality.endswith("p") and quality[:-1].isdigit():
            h = quality[:-1]
            fmt = f"bv*[height<=?{h}]+ba/b[height<=?{h}]/b"
        else:
            fmt = "bv*+ba/b"
        if codec_pref in ("h264", "compat"):
            fmt = (
                "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/"
                "bv*[vcodec^=avc1]+ba/" + fmt
            )
            merge_fmt = "mp4"
            sort_args = ["-S", "res,codec:h264,tbr"]
        else:
            merge_fmt = "mp4"
            sort_args = ["-S", "res,tbr"]
    else:
        if quality in ("best", "all", ""):
            fmt = height_fmt(None, dash=True)
        elif quality.endswith("p") and quality[:-1].isdigit():
            fmt = height_fmt(quality[:-1], dash=True)
        else:
            fmt = height_fmt(None, dash=True)
        if codec_pref in ("h264", "compat"):
            merge_fmt = "mp4"
            sort_args = ["-S", "res,codec:h264,tbr"]
        else:
            merge_fmt = "mp4"

    # Concurrent DASH/HLS fragments (4K has many fragments — parallel is essential)
    concurrent = "16" if is_youtube else "4"
    referer = page_url or payload.get("referer") or ""

    audio_only = bool(payload.get("audioOnly") or payload.get("mediaMode") == "audio")
    write_subs = bool(
        payload.get("writeSubs")
        or payload.get("mediaMode") in ("video_subs", "video+subs", "subs")
    )
    write_thumbnail = bool(payload.get("writeThumbnail")) and not audio_only
    yes_playlist = bool(payload.get("yesPlaylist") or payload.get("playlist"))

    def build_cmd(format_str: str, merge: str, extra: list[str] | None = None) -> list[str]:
        c = [
            bin_path,
            "--newline",
            "-o",
            outtmpl,
            "--no-overwrites",
            "--ignore-config",
            "--no-mtime",
            "--retries",
            "5",
            "--fragment-retries",
            "5",
            "-N",
            concurrent,
            "--http-chunk-size",
            "10M",
            "--socket-timeout",
            "20",
        ]
        # Playlist: only when explicitly requested (batch paste of playlist URLs)
        if yes_playlist:
            c.append("--yes-playlist")
        else:
            c.append("--no-playlist")

        if audio_only:
            # Extract audio → mp3
            c.extend(
                [
                    "-f",
                    "ba/b",
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--audio-quality",
                    "0",
                ]
            )
        else:
            c.extend(["-f", format_str, "--merge-output-format", merge])
            c.extend(sort_args)

        if write_subs and not audio_only:
            c.extend(
                [
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    "ko.*,en.*,ko,en",
                    "--convert-subs",
                    "srt",
                    "--embed-subs",
                ]
            )
        if write_thumbnail:
            c.extend(
                [
                    "--write-thumbnail",
                    "--convert-thumbnails",
                    "jpg",
                ]
            )

        # Windows-safe only (keeps Korean/spaces). Never --restrict-filenames
        # which strips non-ASCII and makes unreadable names like "SSIS_001.mp4".
        if not title_hint:
            c.append("--windows-filenames")
        if referer:
            c.extend(["--add-header", f"Referer:{referer}"])
            try:
                origin = f"{urlparse(referer).scheme}://{urlparse(referer).netloc}"
                c.extend(["--add-header", f"Origin:{origin}"])
            except Exception:
                pass
        # Prefer Netscape cookie file from extension (works while Chrome is open)
        if cookies_file and Path(cookies_file).is_file():
            c.extend(["--cookies", cookies_file])
        else:
            cookies = payload.get("cookies")
            if isinstance(cookies, str) and Path(cookies).is_file():
                c.extend(["--cookies", cookies])
        # Cookie header alone is weak for Instagram API but helps some CDNs
        cookie_header = (payload.get("cookieHeader") or "").strip()
        if cookie_header and not cookies_file:
            c.extend(["--add-header", f"Cookie:{cookie_header}"])
        if payload.get("cookiesFromBrowser"):
            # May fail if Chrome profile is locked — attempts without it still run
            c.extend(["--cookies-from-browser", str(payload["cookiesFromBrowser"])])
        # Instagram extractor: use webpage + API
        if is_instagram:
            c.extend(["--extractor-args", "instagram:include_ads=false"])
        if extra:
            c.extend(extra)
        c.append(target)
        return c

    # Site-specific attempt chains
    if is_instagram:
        # Instagram: cookies file first, then cookies-from-browser fallback
        attempts: list[tuple[str, str, list[str]]] = [
            (fmt, "mp4", []),
            ("best", "mp4", []),
            ("b", "mp4", []),
            ("bestvideo+bestaudio/best", "mp4", []),
            ("best", "mp4", ["--cookies-from-browser", "chrome"]),
            ("b", "mp4", ["--cookies-from-browser", "chrome"]),
        ]
    elif is_tiktok:
        # Impersonate real browsers — TikTok blocks bare yt-dlp IPs
        imp_chrome = ["--impersonate", "chrome"]
        imp_android = ["--impersonate", "chrome-131:android-14"]
        imp_ios = ["--impersonate", "safari-18.0:ios-18.0"]
        # cookies-from-browser as late fallback (Chrome lock often fails while browsing)
        cfb = ["--cookies-from-browser", "chrome", "--impersonate", "chrome"]
        attempts = [
            (fmt, "mp4", imp_chrome),
            ("b", "mp4", imp_chrome),
            ("best", "mp4", imp_chrome),
            ("b", "mp4", imp_android),
            ("best", "mp4", imp_android),
            ("b", "mp4", imp_ios),
            ("b", "mp4", cfb),
            ("best", "mp4", cfb),
            # last resort without impersonate
            ("b", "mp4", []),
            ("best", "mp4", []),
        ]
    elif is_youtube:
        attempts = [
            (fmt, merge_fmt, []),
            ("bv*+ba/b", "mkv", []),
            ("bestvideo+bestaudio/best", "mkv", []),
            ("best", "mp4", []),
        ]
    else:
        attempts = [
            (fmt, "mp4", []),
            ("bv*+ba/b", "mkv", []),
            ("best", "mp4", []),
        ]
    # de-dupe by (format, extra-key)
    seen_key = set()
    uniq_attempts = []
    for a in attempts:
        key = (a[0], " ".join(a[2]))
        if key in seen_key:
            continue
        seen_key.add(key)
        uniq_attempts.append(a)
    attempts = uniq_attempts

    with jobs_lock:
        jobs[job_id]["target"] = target
        jobs[job_id]["outDir"] = str(OUT_DIR)
        jobs[job_id]["message"] = "포맷 선택 중…"

    started_at = time.time()
    printed_paths: list[str] = []
    last_line = ""
    code = 1

    try:
        for attempt_i, (fmt_try, merge_try, extra) in enumerate(attempts):
            cmd = build_cmd(fmt_try, merge_try, extra)
            with jobs_lock:
                jobs[job_id]["cmd"] = " ".join(cmd[:8]) + " …"
                if attempt_i:
                    jobs[job_id]["message"] = f"다른 화질로 재시도 ({attempt_i + 1}/{len(attempts)})…"
                    jobs[job_id]["percent"] = max(2, jobs[job_id].get("percent", 2))

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            last_line = ""
            printed_paths = []
            for line in proc.stdout:
                line = line.rstrip()
                last_line = line
                if line.startswith("/") or (len(line) > 3 and line[1:3] == ":\\"):
                    if any(
                        line.lower().endswith(ext)
                        for ext in (".mp4", ".webm", ".mkv", ".m4a", ".mp3")
                    ):
                        printed_paths.append(line)
                percent = None
                if "[download]" in line and "%" in line:
                    try:
                        part = line.split("%")[0].split()[-1]
                        percent = float(part)
                    except Exception:
                        percent = None
                with jobs_lock:
                    # Keep last non-noisy message for UI
                    if line and not line.startswith("["):
                        jobs[job_id]["message"] = line[-200:]
                    elif "[download]" in line or "Merging" in line or "Destination" in line:
                        jobs[job_id]["message"] = line[-200:]
                    if percent is not None:
                        # Monotonic within a single yt-dlp attempt so UI doesn't bounce
                        prev_p = float(jobs[job_id].get("percent") or 0)
                        p = max(2, min(99, percent))
                        # Allow small resets only at the very start of a new fragment chain
                        if p + 15 < prev_p and p < 8:
                            jobs[job_id]["percent"] = p
                        else:
                            jobs[job_id]["percent"] = max(prev_p, p)
                    elif "Destination" in line or "Merging" in line or "Merger" in line:
                        jobs[job_id]["percent"] = max(jobs[job_id].get("percent", 50), 90)
                        jobs[job_id]["message"] = "파일 합치는 중…"

            code = proc.wait(timeout=3600)
            if code == 0:
                break
            # Retry only on format / DRM style failures
            err_l = (last_line or "").lower()
            if "format is not available" in err_l or "only images are available" in err_l or "drm" in err_l:
                continue
            # Other errors: don't keep retrying forever
            if attempt_i + 1 < len(attempts) and "http error 403" in err_l:
                continue
            break

        # Resolve output file
        final_path = None
        final_size = 0
        if printed_paths:
            final_path = printed_paths[-1]
        else:
            # Newest video file written after we started
            candidates = []
            for pat in ("*.mp4", "*.webm", "*.mkv", "*.m4a"):
                candidates.extend(OUT_DIR.glob(pat))
            candidates = [p for p in candidates if p.is_file() and p.stat().st_mtime >= started_at - 2]
            candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            if candidates:
                final_path = str(candidates[0])

        if final_path and Path(final_path).is_file():
            # Make sure saved name is human-readable (strip "(2) " counters etc.)
            try:
                p = Path(final_path)
                stem = p.stem
                cleaned = clean_name(stem)
                # Drop trailing _best/_all noise
                cleaned = re.sub(r"[_\s-]+(best|all)$", "", cleaned, flags=re.I).strip(" ._-" )
                if cleaned and cleaned != stem and len(cleaned) >= 2:
                    dest = p.with_name(f"{cleaned}{p.suffix}")
                    n = 1
                    while dest.exists() and dest != p:
                        dest = p.with_name(f"{cleaned}_{n}{p.suffix}")
                        n += 1
                    if dest != p:
                        p.rename(dest)
                        final_path = str(dest)
            except Exception as e:
                print(f"[uvd-helper] rename cleanup: {e}", file=sys.stderr)
            final_size = Path(final_path).stat().st_size

        with jobs_lock:
            if code == 0 and final_path and final_size > 50_000:
                jobs[job_id].update(
                    {
                        "status": "done",
                        "percent": 100,
                        "message": f"저장 완료 → {final_path}",
                        "path": final_path,
                        "filename": Path(final_path).name,
                        "size": final_size,
                        "finishedAt": time.time(),
                    }
                )
            elif code == 0:
                jobs[job_id].update(
                    {
                        "status": "done",
                        "percent": 100,
                        "message": f"저장 완료 → {OUT_DIR}",
                        "path": final_path or str(OUT_DIR),
                        "size": final_size,
                        "finishedAt": time.time(),
                    }
                )
            else:
                err = last_line or f"yt-dlp 종료 코드 {code}"
                # Friendly common errors
                if "Sign in to confirm" in err or "login required" in err.lower():
                    err = "로그인이 필요한 영상입니다. 브라우저에서 로그인한 뒤 다시 시도해 주세요"
                elif "Private video" in err or "private" in err.lower():
                    err = "비공개 영상이라 받을 수 없습니다"
                elif "Video unavailable" in err:
                    err = "영상을 사용할 수 없습니다"
                elif "format is not available" in err.lower() or "only images are available" in err.lower():
                    err = "이 영상의 재생 포맷을 받지 못했습니다. 잠시 후 다시 시도해 주세요"
                elif "ip address is blocked" in err.lower() or "blocked from accessing" in err.lower():
                    err = (
                        "TikTok이 이 PC의 접근을 막았습니다. "
                        "브라우저에서 해당 영상을 재생한 뒤(로그인 권장) 다시 시도해 주세요"
                    )
                elif "unable to extract" in err.lower() or "status code 0" in err.lower():
                    err = "TikTok 정보를 읽지 못했습니다. 영상 페이지를 새로고침한 뒤 재생 후 다시 시도해 주세요"
                elif "instagram" in err.lower() and (
                    "login" in err.lower() or "cookie" in err.lower() or "rate-limit" in err.lower()
                ):
                    err = "Instagram 로그인이 필요합니다. Chrome에서 로그인한 뒤 링크를 다시 붙여 넣어 주세요"
                jobs[job_id].update(
                    {
                        "status": "error",
                        "percent": 0,
                        "message": err,
                        "error": err,
                        "finishedAt": time.time(),
                    }
                )
    except Exception as e:
        with jobs_lock:
            jobs[job_id].update(
                {
                    "status": "error",
                    "percent": 0,
                    "message": str(e),
                    "error": str(e),
                    "finishedAt": time.time(),
                }
            )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[uvd-helper] " + (fmt % args) + "\n")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health" or self.path.startswith("/health?"):
            bin_path = find_ytdlp()
            send_json(
                self,
                200,
                {
                    "ok": True,
                    "service": "uvd-ytdlp-helper",
                    "ytdlp": bin_path is not None,
                    "ytdlpPath": bin_path,
                    "ytdlpVersion": ytdlp_version(bin_path) if bin_path else None,
                    "outDir": str(OUT_DIR),
                    "port": PORT,
                },
            )
            return

        if self.path.startswith("/job/"):
            job_id = self.path.split("/job/", 1)[-1].split("?")[0]
            with jobs_lock:
                job = jobs.get(job_id)
            if not job:
                send_json(self, 404, {"ok": False, "error": "job not found"})
                return
            send_json(self, 200, {"ok": True, "job": job})
            return

        send_json(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        # List available video heights / quality labels (no download)
        if self.path == "/formats" or self.path.startswith("/formats?"):
            payload = read_json(self)
            bin_path = find_ytdlp()
            if not bin_path:
                send_json(
                    self,
                    503,
                    {
                        "ok": False,
                        "error": "yt-dlp not installed",
                        "hint": "pip install -U yt-dlp",
                    },
                )
                return
            url = (payload.get("url") or payload.get("pageUrl") or "").strip()
            if not url:
                send_json(self, 400, {"ok": False, "error": "url required"})
                return
            is_tt = "tiktok" in url.lower()
            cookies_file = None
            try:
                cookies_list = payload.get("cookiesList") or payload.get("cookies")
                if isinstance(cookies_list, list) and cookies_list:
                    cpath = COOKIE_DIR / f"formats_cookies_{os.getpid()}.txt"
                    n = write_netscape_cookies(cookies_list, cpath)
                    if n > 0:
                        cookies_file = str(cpath)
                cmd = [
                    bin_path,
                    "--skip-download",
                    "--no-playlist",
                    "--ignore-config",
                    "-J",
                ]
                if is_tt:
                    cmd.extend(["--impersonate", "chrome"])
                if cookies_file:
                    cmd.extend(["--cookies", cookies_file])
                cookie_header = (payload.get("cookieHeader") or "").strip()
                if cookie_header and not cookies_file:
                    cmd.extend(["--add-header", f"Cookie:{cookie_header}"])
                cmd.append(url)
                out = subprocess.check_output(
                    cmd,
                    text=True,
                    timeout=90,
                    stderr=subprocess.STDOUT,
                )
                # -J prints JSON; may have warnings before/after — find last JSON object
                text = out.strip()
                # Prefer last line that looks like JSON object
                info = None
                for line in reversed(text.splitlines()):
                    line = line.strip()
                    if line.startswith("{") and line.endswith("}"):
                        try:
                            info = json.loads(line)
                            break
                        except json.JSONDecodeError:
                            continue
                if info is None:
                    info = json.loads(text[text.find("{") : text.rfind("}") + 1])
            except subprocess.TimeoutExpired:
                if cookies_file:
                    try:
                        Path(cookies_file).unlink(missing_ok=True)
                    except Exception:
                        pass
                send_json(self, 504, {"ok": False, "error": "포맷 조회 시간 초과"})
                return
            except Exception as e:
                if cookies_file:
                    try:
                        Path(cookies_file).unlink(missing_ok=True)
                    except Exception:
                        pass
                msg = str(e)
                if "IP address is blocked" in msg or "blocked from accessing" in msg:
                    msg = "TikTok 접근이 막혔습니다. 브라우저에서 재생 후 다시 열어 주세요"
                send_json(self, 500, {"ok": False, "error": f"포맷 조회 실패: {msg}"})
                return
            finally:
                if cookies_file:
                    try:
                        Path(cookies_file).unlink(missing_ok=True)
                    except Exception:
                        pass

            # Collect video heights + rough size estimates from formats
            entries = info.get("entries") or [info]
            # Prefer first real entry for duration/title on playlists
            primary = next((e for e in entries if e and not e.get("entries")), info) or info
            duration = primary.get("duration") or info.get("duration") or 0
            try:
                duration = float(duration or 0)
            except (TypeError, ValueError):
                duration = 0

            heights: set[int] = set()
            # height -> best estimated bytes for that height
            size_by_h: dict[int, int] = {}
            # height -> preferred short codec label for that height
            codec_by_h: dict[int, str] = {}

            def short_codec(vcodec: str) -> str:
                v = (vcodec or "").lower()
                if not v or v == "none":
                    return ""
                if "av01" in v or "av1" in v:
                    return "av1"
                if "vp09" in v or "vp9" in v:
                    return "vp9"
                if "avc" in v or "h264" in v:
                    return "h264"
                if "hev" in v or "h265" in v or "hvc1" in v:
                    return "hevc"
                return v.split(".")[0][:6]

            def fmt_size(f: dict, dur: float) -> int:
                fs = f.get("filesize") or f.get("filesize_approx")
                if fs:
                    try:
                        return int(fs)
                    except (TypeError, ValueError):
                        pass
                tbr = f.get("tbr") or f.get("vbr") or 0
                try:
                    tbr = float(tbr or 0)
                except (TypeError, ValueError):
                    tbr = 0
                if tbr > 0 and dur >= 1:
                    return int((tbr * 1000 / 8) * dur)
                return 0

            for ent in entries:
                if not ent:
                    continue
                ent_dur = ent.get("duration") or duration or 0
                try:
                    ent_dur = float(ent_dur or 0)
                except (TypeError, ValueError):
                    ent_dur = 0
                for f in ent.get("formats") or []:
                    if not f:
                        continue
                    h = f.get("height")
                    vcodec = (f.get("vcodec") or "none").lower()
                    if h and vcodec != "none":
                        try:
                            hi = int(h)
                        except (TypeError, ValueError):
                            continue
                        heights.add(hi)
                        sz = fmt_size(f, ent_dur)
                        if sz > 0:
                            size_by_h[hi] = max(size_by_h.get(hi, 0), sz)
                        # Prefer higher tbr format's codec for this height
                        sc = short_codec(vcodec)
                        if sc and (
                            hi not in codec_by_h
                            or (sz > 0 and sz >= size_by_h.get(hi, 0))
                        ):
                            codec_by_h[hi] = sc
                if ent.get("height"):
                    try:
                        heights.add(int(ent["height"]))
                    except (TypeError, ValueError):
                        pass

            def label_for(h: int) -> str | None:
                if h < 240:
                    return None
                if h >= 2160:
                    return "4K"
                if h >= 1440:
                    return "1440p"
                if h >= 1080:
                    return "1080p"
                if h >= 720:
                    return "720p"
                if h >= 480:
                    return "480p"
                if h >= 360:
                    return "360p"
                return "240p"

            def size_label(sz: int) -> str:
                if not sz or sz <= 0:
                    return ""
                mb = sz / (1024 * 1024)
                if mb >= 100:
                    return f"{int(round(mb))}MB"
                if mb >= 10:
                    return f"{mb:.0f}MB"
                if mb >= 1:
                    return f"{mb:.1f}MB"
                kb = sz / 1024
                return f"{int(round(kb))}KB"

            def chip_label(lab: str, h: int, sz: int, codec: str) -> str:
                parts = [lab]
                sl = size_label(sz)
                if sl:
                    parts.append(sl)
                if codec:
                    parts.append(codec)
                return " · ".join(parts)

            bucket_max: dict[str, int] = {}
            bucket_size: dict[str, int] = {}
            bucket_codec: dict[str, str] = {}
            for h in heights:
                lab = label_for(h)
                if not lab:
                    continue
                if h >= bucket_max.get(lab, 0):
                    bucket_max[lab] = h
                    if size_by_h.get(h):
                        bucket_size[lab] = size_by_h[h]
                    if codec_by_h.get(h):
                        bucket_codec[lab] = codec_by_h[h]

            order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"]
            qualities = []
            if bucket_max:
                best_h = max(bucket_max.values())
                best_sz = size_by_h.get(best_h) or max(bucket_size.values(), default=0)
                best_codec = codec_by_h.get(best_h) or ""
                q_best = {
                    "id": "best",
                    "label": chip_label("최고", best_h, best_sz, best_codec),
                    "height": best_h,
                    "codec": best_codec or None,
                }
                if best_sz:
                    q_best["estimatedSize"] = int(best_sz)
                    q_best["approx"] = True
                qualities.append(q_best)
            for lab in order:
                if lab in bucket_max:
                    h = bucket_max[lab]
                    sz = int(bucket_size.get(lab) or 0)
                    codec = bucket_codec.get(lab) or codec_by_h.get(h) or ""
                    q = {
                        "id": lab,
                        "label": chip_label(lab, h, sz, codec),
                        "height": h,
                        "codec": codec or None,
                    }
                    if sz:
                        q["estimatedSize"] = sz
                        q["approx"] = True
                    qualities.append(q)
            for lab, h in sorted(bucket_max.items(), key=lambda x: -x[1]):
                if lab not in order and lab != "best":
                    sz = int(bucket_size.get(lab) or 0)
                    codec = bucket_codec.get(lab) or ""
                    q = {
                        "id": lab,
                        "label": chip_label(lab, h, sz, codec),
                        "height": h,
                        "codec": codec or None,
                    }
                    if sz:
                        q["estimatedSize"] = sz
                        q["approx"] = True
                    qualities.append(q)

            # Overall best estimate for card summary
            overall_size = 0
            if size_by_h:
                overall_size = max(size_by_h.values())
            elif primary.get("filesize") or primary.get("filesize_approx"):
                try:
                    overall_size = int(
                        primary.get("filesize") or primary.get("filesize_approx") or 0
                    )
                except (TypeError, ValueError):
                    overall_size = 0

            thumb = (
                primary.get("thumbnail")
                or (primary.get("thumbnails") or [{}])[-1].get("url")
                or info.get("thumbnail")
                or ""
            )

            send_json(
                self,
                200,
                {
                    "ok": True,
                    "url": url,
                    "title": primary.get("title") or info.get("title") or "",
                    "duration": duration if duration >= 1 else 0,
                    "estimatedSize": int(overall_size) if overall_size else 0,
                    "thumbnail": thumb or "",
                    "heights": sorted(heights, reverse=True),
                    "qualities": qualities,
                },
            )
            return

        if self.path == "/download" or self.path.startswith("/download?"):
            payload = read_json(self)
            bin_path = find_ytdlp()
            url = (payload.get("url") or payload.get("pageUrl") or "").strip()
            site = (payload.get("site") or "").lower()
            # TikTok can resolve via public APIs without yt-dlp
            is_tt = site == "tiktok" or is_tiktok_page(url) or bool(payload.get("mediaUrl"))
            if not bin_path and not is_tt:
                send_json(
                    self,
                    503,
                    {
                        "ok": False,
                        "error": "yt-dlp not installed",
                        "hint": "pip install -U yt-dlp  또는  brew install yt-dlp",
                    },
                )
                return

            if not url and not payload.get("mediaUrl"):
                send_json(self, 400, {"ok": False, "error": "url required"})
                return

            job_id = uuid.uuid4().hex[:12]
            with jobs_lock:
                jobs[job_id] = {
                    "id": job_id,
                    "status": "queued",
                    "percent": 0,
                    "message": "대기 중…",
                    "url": url,
                }

            t = threading.Thread(
                target=run_download, args=(job_id, payload), daemon=True
            )
            t.start()

            send_json(
                self,
                200,
                {
                    "ok": True,
                    "jobId": job_id,
                    "outDir": str(OUT_DIR),
                    "message": "yt-dlp 다운로드 시작",
                },
            )
            return

        send_json(self, 404, {"ok": False, "error": "not found"})


def main() -> None:
    bin_path = find_ytdlp()
    print(f"UVD yt-dlp helper  http://{HOST}:{PORT}")
    print(f"  output: {OUT_DIR}")
    if bin_path:
        print(f"  yt-dlp: {bin_path} ({ytdlp_version(bin_path)})")
    else:
        print("  ⚠ yt-dlp 없음 →  pip install -U yt-dlp")
        print("     또는 brew install yt-dlp")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        server.server_close()


if __name__ == "__main__":
    main()
