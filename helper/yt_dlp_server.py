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
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

try:
    from .name_utils import clean_name, is_generic_name, unique_output_path
except ImportError:
    from name_utils import clean_name, is_generic_name, unique_output_path

HOST = "127.0.0.1"
PORT = int(os.environ.get("UVD_PORT", "8787"))
HOME = Path.home()
OUT_DIR = Path(os.environ.get("UVD_OUT", HOME / "Downloads" / "VideoDownloader"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Access control ──
# Browsers always attach an Origin header to cross-origin fetch/XHR/form POSTs,
# so requiring extension origins blocks arbitrary web pages from commanding the
# helper. Requests without Origin (curl, local scripts) are allowed.
# Pin one exact origin with UVD_ALLOWED_ORIGIN=chrome-extension://<id>.
# Optional shared secret: set UVD_TOKEN and configure the same token in the
# extension settings — then every protected request must send X-UVD-Token.
ALLOWED_ORIGIN_EXACT = os.environ.get("UVD_ALLOWED_ORIGIN", "").strip()
AUTH_TOKEN = os.environ.get("UVD_TOKEN", "").strip()

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
# job_id -> running subprocess (not JSON-serializable; keep aside)
process_map: dict[str, subprocess.Popen] = {}
COOKIE_DIR = Path(os.environ.get("UVD_COOKIE_DIR", HOME / ".cache" / "uvd-helper"))
COOKIE_DIR.mkdir(parents=True, exist_ok=True)
PAIR_FILE = COOKIE_DIR / "pairing.json"
pairing_lock = threading.Lock()


def load_auto_pairing() -> dict[str, str]:
    if AUTH_TOKEN:
        return {}
    try:
        data = json.loads(PAIR_FILE.read_text(encoding="utf-8"))
        origin = str(data.get("origin") or "")
        token = str(data.get("token") or "")
        if re.fullmatch(r"chrome-extension://[a-p]{32}", origin) and len(token) >= 32:
            return {"origin": origin, "token": token}
    except Exception:
        pass
    return {}


auto_pairing = load_auto_pairing()


def pair_extension(origin: str, token: str) -> tuple[bool, str]:
    """Pin the first extension origin and its locally generated token."""
    global auto_pairing
    if AUTH_TOKEN:
        return False, "manual token configured"
    if not re.fullmatch(r"chrome-extension://[a-p]{32}", origin or ""):
        return False, "invalid extension origin"
    if ALLOWED_ORIGIN_EXACT and origin != ALLOWED_ORIGIN_EXACT:
        # /pair is reachable before request_authorized(); a pinned install
        # must not be re-pairable by a different extension.
        return False, "origin not allowed"
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token or ""):
        return False, "invalid pairing token"
    with pairing_lock:
        if auto_pairing and auto_pairing.get("origin") != origin:
            return False, "helper already paired"
        # Same extension origin may rotate its token: a reinstalled extension
        # (storage wiped) would otherwise be locked out for good. Browsers do
        # not let web pages forge an Origin header, and another extension has
        # a different id, so origin equality is the authorization here.
        if auto_pairing and auto_pairing.get("token") == token:
            return True, ""
        auto_pairing = {"origin": origin, "token": token}
        try:
            PAIR_FILE.write_text(
                json.dumps(auto_pairing, ensure_ascii=True),
                encoding="utf-8",
            )
            os.chmod(PAIR_FILE, 0o600)
        except Exception as error:
            auto_pairing = {}
            return False, f"could not save pairing: {error}"
    return True, ""


TMP_ROOT = OUT_DIR / ".uvd-tmp"
OUT_DIR_IS_DEFAULT = "UVD_OUT" not in os.environ


def subfolder_segments(subfolder: str) -> list[str]:
    out = []
    for raw in re.split(r"[\\/]+", str(subfolder or "")):
        seg = re.sub(r'[<>:"|?*\x00-\x1f]', "", raw).strip().strip(".")
        if not seg or seg in (".", ".."):
            continue
        out.append(seg[:64])
        if len(out) >= 3:
            break
    return out


def publish_dir_for(subfolder: str) -> Path:
    """
    Mirror the browser path's "Downloads/<subfolder>" so helper and extension
    saves land in the same place. With a custom UVD_OUT the subfolder nests
    inside it; the default OUT_DIR already *is* Downloads/VideoDownloader.
    """
    segments = subfolder_segments(subfolder)
    if not segments:
        return OUT_DIR
    base = HOME / "Downloads" if OUT_DIR_IS_DEFAULT else OUT_DIR
    candidate = base.joinpath(*segments)
    try:
        if candidate.resolve() == OUT_DIR.resolve():
            return OUT_DIR
    except OSError:
        pass
    return candidate
# Partial downloads older than this are considered abandoned and swept at startup.
TMP_MAX_AGE_SECONDS = 3 * 24 * 3600


def _signal_process_tree(proc: subprocess.Popen, hard: bool) -> None:
    """Signal yt-dlp and the aria2c/ffmpeg children it spawned (own session)."""
    if os.name != "nt":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL if hard else signal.SIGTERM)
            return
        except Exception:
            pass
    try:
        proc.kill() if hard else proc.terminate()
    except Exception:
        pass


def kill_process_tree(proc: subprocess.Popen, grace: float = 2.0) -> None:
    if proc.poll() is not None:
        return
    _signal_process_tree(proc, hard=False)
    try:
        proc.wait(timeout=grace)
    except Exception:
        _signal_process_tree(proc, hard=True)
        try:
            proc.wait(timeout=grace)
        except Exception:
            pass


def resume_key_for(payload: dict, target: str) -> str:
    """
    Stable per-download key so a paused job and its resume share one work_dir
    and yt-dlp's --continue finds the .part files. The extension passes its own
    job id; otherwise derive from what makes the download unique.
    """
    raw = str(payload.get("resumeKey") or "").strip()
    if not raw:
        import hashlib

        parts = [
            target,
            str(payload.get("quality") or "best"),
            str(payload.get("mediaMode") or ""),
            str(payload.get("audioTrackId") or ""),
            "audio" if payload.get("audioOnly") else "",
        ]
        raw = "auto_" + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:20]
    return re.sub(r"[^A-Za-z0-9_-]", "_", raw)[:80] or "job"


def purge_work_dir(work_dir: Path | None) -> None:
    if not work_dir:
        return
    try:
        if work_dir.resolve().parent != TMP_ROOT.resolve():
            return
        shutil.rmtree(work_dir, ignore_errors=True)
        TMP_ROOT.rmdir()
    except OSError:
        pass


def sweep_tmp_dirs(max_age: float = TMP_MAX_AGE_SECONDS) -> int:
    """Remove abandoned per-download temp dirs; called at startup."""
    removed = 0
    try:
        if not TMP_ROOT.is_dir():
            return 0
        now = time.time()
        for entry in TMP_ROOT.iterdir():
            try:
                if not entry.is_dir():
                    entry.unlink(missing_ok=True)
                    removed += 1
                    continue
                newest = entry.stat().st_mtime
                for child in entry.rglob("*"):
                    try:
                        newest = max(newest, child.stat().st_mtime)
                    except OSError:
                        pass
                if now - newest > max_age or not any(entry.iterdir()):
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
            except OSError:
                pass
        try:
            TMP_ROOT.rmdir()
        except OSError:
            pass
    except Exception as error:
        print(f"[uvd-helper] tmp sweep: {error}", file=sys.stderr)
    return removed


def request_cancel_job(job_id: str, purge: bool = False) -> bool:
    """Mark job cancelled and kill yt-dlp (and its children) if running."""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return False
        job["cancel"] = True
        job["purge"] = bool(purge)
        job["status"] = "cancelled"
        job["message"] = "취소됨"
        job["error"] = "사용자가 취소했습니다"
        work_dir = job.get("workDir")
        running = job_id in process_map
    proc = process_map.get(job_id)
    if proc and proc.poll() is None:
        kill_process_tree(proc)
    process_map.pop(job_id, None)
    # When the worker thread is no longer around to honour the flag, purge here.
    if purge and work_dir and not running:
        purge_work_dir(Path(work_dir))
    return True


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
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return n


def cookie_header_to_list(cookie_header: str, scope_url: str) -> list[dict]:
    """
    Turn a bare "k=v; k2=v2" header into cookie dicts bound to the host of
    scope_url, so yt-dlp only sends them to that site (and its subdomains)
    instead of to every host the extractor touches.
    """
    header = (cookie_header or "").strip()
    if not header:
        return []
    try:
        parsed = urlparse(scope_url or "")
        host = (parsed.hostname or "").lower()
    except Exception:
        host = ""
    if not host or host.replace(".", "").isdigit():
        return []
    base = host[4:] if host.startswith("www.") else host
    secure = (parsed.scheme or "https").lower() == "https"
    out = []
    for part in header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        if not name:
            continue
        out.append(
            {
                "name": name,
                "value": value.strip(),
                "domain": f".{base}",
                "path": "/",
                "secure": secure,
                "httpOnly": False,
                "expirationDate": 0,
            }
        )
    return out


def payload_cookie_list(payload: dict, scope_url: str) -> list:
    """Prefer the extension's domain-scoped list; fall back to scoping a bare header."""
    cookies_list = payload.get("cookiesList") or payload.get("cookies")
    if isinstance(cookies_list, list) and cookies_list:
        return cookies_list
    return cookie_header_to_list(payload.get("cookieHeader") or "", scope_url)


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
                "title": d.get("title") or "",
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


TIKTOK_COOKIE_HOST_SUFFIXES = (
    "tiktok.com",
    "tiktokv.com",
    "tiktokv.us",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "byteoversea.com",
    "byteicdn.com",
    "ibyteimg.com",
    "muscdn.com",
)


def tiktok_cookie_host(url: str) -> bool:
    """Only first-party TikTok/ByteDance hosts may receive the user's TikTok cookies."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return bool(host) and any(
        host == suffix or host.endswith("." + suffix)
        for suffix in TIKTOK_COOKIE_HOST_SUFFIXES
    )


class _CookieScopedRedirectHandler(HTTPRedirectHandler):
    """Drop the Cookie header when a redirect leaves the trusted host set."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and not tiktok_cookie_host(newurl):
            new_req.remove_header("Cookie")
        return new_req


def download_url_to_file(
    media_url: str,
    dest: Path,
    referer: str = "https://www.tiktok.com/",
    cookie_header: str = "",
    should_cancel=None,
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
    # play_url may come from a third-party resolver (tikwm etc.) or a page-
    # supplied CDN URL; never hand the session cookie jar to those hosts.
    if cookie_header and tiktok_cookie_host(media_url):
        hdrs["Cookie"] = cookie_header
    req = Request(media_url, headers=hdrs, method="GET")
    opener = build_opener(_CookieScopedRedirectHandler())
    written = 0
    first = b""
    with opener.open(req, timeout=120) as resp, open(dest, "wb") as f:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if any(x in ctype for x in ("javascript", "text/html", "text/css", "image/", "json")):
            raise ValueError(f"bad content-type {ctype}")
        while True:
            if should_cancel and should_cancel():
                raise RuntimeError("cancelled")
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


def supplied_title_hint(payload: dict) -> str:
    """Prefer a real page/video title over a filename or opaque identifier."""
    for key in ("title", "filename"):
        candidate = str(payload.get(key) or "").strip()
        if candidate and not is_generic_name(candidate):
            return candidate
    return ""


def try_tiktok_direct_download(job_id: str, payload: dict, outtmpl_base: str) -> bool:
    """
    SnapTik-style path: resolve play URL via public API or client-provided mediaUrl,
    then download bytes. Returns True if job completed successfully.
    """
    page_url = (payload.get("pageUrl") or payload.get("url") or "").strip()
    media_hint = (payload.get("mediaUrl") or "").strip()
    cookie_header = (payload.get("cookieHeader") or "").strip()
    title_hint = supplied_title_hint(payload)

    play_url = ""
    title = title_hint
    method = ""

    if media_hint and media_hint.startswith("http") and "tiktok.com/@" not in media_hint:
        play_url = media_hint
        method = "client-cdn"

    if (not play_url or not title) and is_tiktok_page(page_url):
        with jobs_lock:
            jobs[job_id]["message"] = "TikTok 링크 해석 중… (공개 API)"
            jobs[job_id]["percent"] = 8
        resolved = resolve_tiktok_via_public_apis(page_url)
        if resolved and resolved.get("play_url"):
            play_url = play_url or resolved["play_url"]
            title = resolved.get("title") or title
            method = resolved.get("method") or "public-api"

    if not play_url:
        return False

    # A resolver media URL without a human title must fall through to yt-dlp,
    # whose extractor can populate %(title)s. Never publish an id/generic name.
    if not title or is_generic_name(title):
        return False

    # Build output path
    safe = clean_name(title)
    dest = unique_output_path(OUT_DIR, f"{safe}.mp4")

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
            should_cancel=lambda: bool(jobs.get(job_id, {}).get("cancel")),
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
            cancelled = bool(jobs[job_id].get("cancel"))
            if not cancelled:
                jobs[job_id]["message"] = f"TikTok 직접 저장 실패: {e}"
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        # A cancelled job must not fall through to the yt-dlp attempts.
        return cancelled


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


def is_youtube_download(site: str, *urls: str) -> bool:
    """Recognize YouTube pages and the googlevideo media URLs they resolve to."""
    if (site or "").lower() == "youtube":
        return True
    youtube_domains = (
        "youtube.com",
        "youtube-nocookie.com",
        "youtu.be",
        "googlevideo.com",
    )
    for value in urls:
        try:
            host = (urlparse(value or "").hostname or "").lower().rstrip(".")
        except Exception:
            continue
        if any(host == domain or host.endswith(f".{domain}") for domain in youtube_domains):
            return True
    return False


def should_use_aria2(
    aria2_path: str | None, speed_profile: str, is_youtube: bool
) -> bool:
    """Use aria2 only for fast-profile sites where multi-connection is reliable."""
    return bool(aria2_path and speed_profile == "fast" and not is_youtube)


def is_aria2_failure(return_code: int, output: str) -> bool:
    """Identify yt-dlp failures caused by its external aria2c downloader."""
    if return_code == 0:
        return False
    text = (output or "").lower()
    return "aria2c exited" in text or (
        "aria2c" in text and ("error" in text or "failed" in text)
    )


def should_retry_without_aria2(
    using_aria2: bool,
    fallback_used: bool,
    return_code: int,
    output: str,
) -> bool:
    """Allow one native retry when the external downloader caused the failure."""
    return (
        using_aria2
        and not fallback_used
        and is_aria2_failure(return_code, output)
    )


_version_cache: dict[str, tuple[str, float]] = {}
VERSION_CACHE_SECONDS = 10 * 60


def ytdlp_version(bin_path: str) -> str:
    """
    Cached: /health is polled every few seconds by the popup with a 1.2 s
    client timeout, and a cold `yt-dlp --version` alone can take that long,
    which made the helper look offline intermittently.
    """
    cached = _version_cache.get(bin_path)
    now = time.time()
    if cached and now - cached[1] < VERSION_CACHE_SECONDS:
        return cached[0]
    try:
        out = subprocess.check_output([bin_path, "--version"], text=True, timeout=8)
        version = out.strip() or "unknown"
    except Exception:
        version = "unknown"
    _version_cache[bin_path] = (version, now)
    return version


def origin_allowed(origin: str) -> bool:
    if not origin:
        # No Origin = non-browser local client. Browsers cannot omit Origin on
        # cross-origin fetch/XHR/form POSTs, so this cannot be forged by a page.
        return True
    if ALLOWED_ORIGIN_EXACT:
        return origin == ALLOWED_ORIGIN_EXACT
    if auto_pairing.get("origin"):
        return origin == auto_pairing["origin"]
    return origin.startswith("chrome-extension://")


def request_authorized(handler: BaseHTTPRequestHandler) -> bool:
    if not origin_allowed((handler.headers.get("Origin") or "").strip()):
        return False
    expected_token = AUTH_TOKEN or auto_pairing.get("token") or ""
    if (
        expected_token
        and (handler.headers.get("X-UVD-Token") or "").strip() != expected_token
    ):
        return False
    return True


def cors(handler: BaseHTTPRequestHandler) -> None:
    origin = (handler.headers.get("Origin") or "").strip()
    if origin and origin_allowed(origin):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-UVD-Token")


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


def collect_track_choices(info: dict) -> tuple[list[dict], list[dict]]:
    """Return stable, user-selectable yt-dlp audio and subtitle tracks."""
    entries = info.get("entries") or [info]
    audio_by_id: dict[str, dict] = {}
    subtitle_by_id: dict[str, dict] = {}

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for fmt in entry.get("formats") or []:
            if not isinstance(fmt, dict):
                continue
            format_id = str(fmt.get("format_id") or "").strip()
            acodec = str(fmt.get("acodec") or "none")
            vcodec = str(fmt.get("vcodec") or "none")
            if (
                format_id
                and acodec != "none"
                and vcodec == "none"
                and re.fullmatch(r"[A-Za-z0-9._-]{1,100}", format_id)
            ):
                language = str(fmt.get("language") or "und")
                note = str(
                    fmt.get("format_note")
                    or fmt.get("format")
                    or acodec.split(".")[0]
                )
                channels = fmt.get("audio_channels")
                label = f"{language} · {note}"
                if channels:
                    label += f" · {channels}ch"
                audio_by_id.setdefault(
                    format_id,
                    {
                        "id": format_id,
                        "label": label[:120],
                        "language": language,
                        "codec": acodec,
                        "channels": channels,
                    },
                )

        for automatic, key in (
            (False, "subtitles"),
            (True, "automatic_captions"),
        ):
            for language, tracks in (entry.get(key) or {}).items():
                language = str(language or "").strip()
                if not language or language in subtitle_by_id:
                    continue
                first = (tracks or [{}])[0] if isinstance(tracks, list) else {}
                name = str((first or {}).get("name") or language)
                ext = str((first or {}).get("ext") or "")
                suffix = "자동" if automatic else "자막"
                label = f"{name} · {suffix}"
                if ext:
                    label += f" · {ext}"
                subtitle_by_id[language] = {
                    "id": language,
                    "label": label[:120],
                    "language": language,
                    "automatic": automatic,
                    "ext": ext,
                }

    def language_rank(track: dict) -> tuple[int, str]:
        language = str(track.get("language") or "").lower()
        if language.startswith("ko"):
            return (0, language)
        if language.startswith("en"):
            return (1, language)
        if language == "und":
            return (3, language)
        return (2, language)

    audio_tracks = sorted(audio_by_id.values(), key=language_rank)[:40]
    subtitle_tracks = sorted(subtitle_by_id.values(), key=language_rank)[:60]
    return audio_tracks, subtitle_tracks


def run_download(job_id: str, payload: dict) -> None:
    bin_path = find_ytdlp()
    url = (payload.get("url") or "").strip()
    page_url = (payload.get("pageUrl") or payload.get("referer") or "").strip()
    quality = (payload.get("quality") or "best").strip()
    title_hint = supplied_title_hint(payload)
    # directFile: url IS the media file — download it as-is (referer only as
    # header), never re-target to the page for extractor detection.
    direct_file = bool(payload.get("directFile"))
    # DASH manifests also use the supplied media URL directly, but unlike a
    # progressive file yt-dlp must select and merge separate video/audio tracks.
    manifest = bool(payload.get("manifest")) or ".mpd" in url.lower()

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
    if (direct_file or manifest) and url:
        target = url
    else:
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
    if not direct_file and url and (
        ".m3u8" in url
        or ".mpd" in url
        or url.endswith((".mp4", ".webm", ".mkv"))
        or "m3u8" in url.lower()
        or "mpd" in url.lower()
    ):
        # still try page first if looks like a site page was also provided
        if (
            not manifest
            and page_url
            and "://" in page_url
            and ".m3u8" not in page_url
            and ".mpd" not in page_url
        ):
            target = page_url
        else:
            target = url

    # Download into a hidden per-download directory, then publish one uniquely
    # named completed file. This lets extractor titles remain the source of
    # truth and avoids yt-dlp silently reusing an existing same-title file.
    # The directory is keyed by resumeKey (not job id) so pause → resume lands
    # in the same place and --continue picks up the .part files.
    work_dir = TMP_ROOT / resume_key_for(payload, target)
    work_dir.mkdir(parents=True, exist_ok=True)
    publish_dir = publish_dir_for(payload.get("subfolder") or "")
    try:
        publish_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        publish_dir = OUT_DIR
    with jobs_lock:
        jobs[job_id]["workDir"] = str(work_dir)

    # output template — clean human names (no "(2) " notification prefix, no "_best")
    if title_hint:
        safe = clean_name(title_hint)
        # Readable old-style names: keep spaces + unicode (no restrict-filenames)
        outtmpl = str(work_dir / f"{safe}.%(ext)s")
    else:
        # Real video title from extractor — keep spaces/unicode so names stay readable
        # (e.g. "SSIS-001 이복 여동생 이야기.mp4")
        # Use .s (chars) not .B (bytes) so Korean titles are not cut mid-glyph.
        outtmpl = str(work_dir / "%(title).100s.%(ext)s")

    site = (payload.get("site") or "").lower()
    host = ""
    try:
        host = urlparse(target).hostname or ""
    except Exception:
        host = ""

    is_youtube = is_youtube_download(site, target, page_url)
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

    # Write browser cookies (from extension) to Netscape file — required for Instagram.
    # A bare cookieHeader is scoped to the page host here; it is never passed as a
    # global --add-header, which yt-dlp would send to every CDN/redirect host.
    cookies_file: str | None = None
    cookies_list = payload_cookie_list(
        payload, payload.get("pageUrl") or payload.get("referer") or target
    )
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

    audio_only = bool(
        payload.get("audioOnly") or payload.get("mediaMode") == "audio"
    )
    selected_audio_track = str(payload.get("audioTrackId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", selected_audio_track):
        selected_audio_track = ""
    if selected_audio_track and not audio_only:
        height_cap = ""
        if quality.endswith("p") and quality[:-1].isdigit():
            height_cap = f"[height<=?{quality[:-1]}]"
        fmt = f"bv*{height_cap}+{selected_audio_track}"

    # Concurrent DASH/HLS fragments — higher = faster when CDN allows.
    # YouTube handles high parallelism well; other CDNs get a solid middle ground.
    # (Was 16 / 4 — raised for throughput without dropping quality.)
    if is_youtube:
        concurrent = "24"
    elif is_tiktok or is_bilibili:
        concurrent = "16"
    else:
        concurrent = "12"
    # Optional override from extension: speedProfile fast|normal|safe
    speed_profile = (payload.get("speedProfile") or payload.get("speed") or "fast").strip().lower()
    if speed_profile in ("safe", "slow"):
        concurrent = "8" if is_youtube else "4"
    elif speed_profile in ("normal", "medium"):
        concurrent = "16" if is_youtube else "8"
    # else "fast" / default → values above

    referer = page_url or payload.get("referer") or ""

    selected_subtitle_languages = [
        str(language).strip()
        for language in (payload.get("subtitleLanguages") or [])
        if re.fullmatch(r"[A-Za-z0-9._-]{1,40}", str(language).strip())
    ][:20]
    write_subs = bool(
        payload.get("writeSubs")
        or payload.get("mediaMode") in ("video_subs", "video+subs", "subs")
        or selected_subtitle_languages
    )
    write_thumbnail = bool(payload.get("writeThumbnail")) and not audio_only
    yes_playlist = bool(payload.get("yesPlaylist") or payload.get("playlist"))

    # aria2c is an optional speed boost. YouTube/googlevideo reject its
    # aggressive multi-connection requests often enough that native yt-dlp is
    # always the safer default there.
    aria2 = shutil.which("aria2c")
    aria2_for_job = should_use_aria2(aria2, speed_profile, is_youtube)

    # yt-dlp writes the FINAL saved path here — exact attribution even with
    # concurrent jobs, and no Downloads-folder listing needed (macOS TCC can
    # block globbing for launchd agents while child writes still succeed).
    path_file = COOKIE_DIR / f"path_{job_id}.txt"
    try:
        path_file.unlink(missing_ok=True)
    except OSError:
        pass

    def build_cmd(
        format_str: str,
        merge: str,
        extra: list[str] | None = None,
        use_aria2: bool = False,
    ) -> list[str]:
        c = [
            bin_path,
            "--newline",
            "--no-simulate",
            "--print-to-file",
            "after_move:filepath",
            str(path_file),
            "-o",
            outtmpl,
            "--no-overwrites",
            "--continue",
            "--part",
            "--ignore-config",
            "--no-mtime",
            "--retries",
            "8",
            "--fragment-retries",
            "10",
            "-N",
            concurrent,
            "--http-chunk-size",
            "10M",
            "--socket-timeout",
            "30",
        ]
        # External multi-connection downloader when allowed for this attempt.
        if use_aria2:
            # -x connections/server, -s splits, -j parallel jobs
            c.extend(
                [
                    "--downloader",
                    "aria2c",
                    "--downloader-args",
                    "aria2c:--continue=true -x 16 -s 16 -k 1M -j 16 --file-allocation=none --min-split-size=1M",
                ]
            )
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
                    selected_audio_track or "ba/b",
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
                    ",".join(selected_subtitle_languages)
                    if selected_subtitle_languages
                    else "ko.*,en.*,ko,en",
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
        # Domain-scoped Netscape cookie file from the extension (works while
        # Chrome is open). Arbitrary local cookie-jar paths / browser profiles
        # from the payload are intentionally not accepted.
        if cookies_file and Path(cookies_file).is_file():
            c.extend(["--cookies", cookies_file])
        # Instagram extractor: use webpage + API
        if is_instagram:
            c.extend(["--extractor-args", "instagram:include_ads=false"])
        if extra:
            c.extend(extra)
        c.append("--")
        c.append(target)
        return c

    # Site-specific attempt chains
    if direct_file:
        # Single generic-download attempt — format fallbacks are meaningless
        # for a plain file URL and only waste time when the CDN rejects us.
        attempts: list[tuple[str, str, list[str]]] = [("b", "mp4", [])]
    elif is_instagram:
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
    if selected_audio_track:
        attempts = [(fmt, merge_fmt, [])]
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
        jobs[job_id]["outDir"] = str(publish_dir)
        jobs[job_id]["message"] = "포맷 선택 중…"

    started_at = time.time()
    printed_paths: list[str] = []
    last_line = ""
    code = 1
    aria2_fallback_used = False
    native_retry_index = -1

    try:
        for attempt_i, (fmt_try, merge_try, extra) in enumerate(attempts):
            using_aria2 = aria2_for_job
            cmd = build_cmd(fmt_try, merge_try, extra, use_aria2=using_aria2)
            with jobs_lock:
                jobs[job_id]["cmd"] = " ".join(cmd[:8]) + " …"
                # Fresh multi-stage progress per attempt (video / audio / merge)
                jobs[job_id]["_dl_stage"] = 0
                jobs[job_id]["_dest_count"] = 0
                jobs[job_id]["_raw_dl_pct"] = None
                jobs[job_id]["_disp_pct"] = 0.0
                if attempt_i == native_retry_index:
                    jobs[job_id]["message"] = (
                        "aria2 고속 다운로드 오류 → 기본 다운로더로 다시 시도…"
                    )
                    jobs[job_id]["percent"] = min(
                        30, max(2, float(jobs[job_id].get("percent") or 2))
                    )
                elif attempt_i:
                    jobs[job_id]["message"] = f"다른 화질로 재시도 ({attempt_i + 1}/{len(attempts)})…"
                    # Soft reset so bar can move again honestly
                    jobs[job_id]["percent"] = min(
                        30, max(2, float(jobs[job_id].get("percent") or 2))
                    )

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                bufsize=1,
                start_new_session=(os.name != "nt"),
            )
            process_map[job_id] = proc
            assert proc.stdout is not None
            last_line = ""
            printed_paths = []
            aria2_failure_line = ""
            for line in proc.stdout:
                with jobs_lock:
                    cancelled = bool(jobs.get(job_id, {}).get("cancel"))
                if cancelled:
                    kill_process_tree(proc)
                    break
                line = line.rstrip()
                last_line = line
                if is_aria2_failure(1, line):
                    aria2_failure_line = line
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

                    # New output file = next stream (video then audio). Without this,
                    # monotonic % sticks at 99 while the second track still downloads.
                    if "[download]" in line and "Destination" in line:
                        dest_n = int(jobs[job_id].get("_dest_count", 0) or 0) + 1
                        jobs[job_id]["_dest_count"] = dest_n
                        if dest_n > 1:
                            jobs[job_id]["_dl_stage"] = dest_n - 1
                            jobs[job_id]["_raw_dl_pct"] = 0
                            jobs[job_id]["_disp_pct"] = 0.0
                            jobs[job_id]["message"] = f"추가 트랙 받는 중… ({dest_n}번째)"

                    if percent is not None:
                        prev_raw = jobs[job_id].get("_raw_dl_pct")
                        stage = int(jobs[job_id].get("_dl_stage", 0) or 0)
                        # Fallback stage detect: only when the previous track was
                        # essentially done. yt-dlp's raw % is based on an
                        # ESTIMATED total (~size) and drops when the estimate
                        # grows — a loose threshold here misread that as a new
                        # track and made the bar jump around.
                        if (
                            prev_raw is not None
                            and float(prev_raw) >= 96
                            and percent < 15
                        ):
                            stage = stage + 1
                            jobs[job_id]["_dl_stage"] = stage
                            jobs[job_id]["_disp_pct"] = 0.0
                            jobs[job_id]["message"] = f"추가 트랙 받는 중… ({stage + 1}단계)"
                        jobs[job_id]["_raw_dl_pct"] = percent

                        # Displayed % is monotonic per stage — raw % wobbles with
                        # size re-estimates, which looked like the bar bouncing.
                        disp = max(
                            float(jobs[job_id].get("_disp_pct") or 0.0), percent
                        )
                        jobs[job_id]["_disp_pct"] = disp

                        # Map into UI bands — leave headroom so we never sit at 99 early:
                        #   stage 0 (main/video or single file): 3–85%
                        #   stage 1+ (audio / extra):            85–92%
                        #   merge/post:                          92–97%
                        #   done:                                100%
                        if stage <= 0:
                            mapped = 3.0 + (disp / 100.0) * 82.0  # 3..85
                        else:
                            mapped = 85.0 + (disp / 100.0) * 7.0  # 85..92
                        mapped = max(2.0, min(92.0, mapped))
                        prev_p = float(jobs[job_id].get("percent") or 0)
                        # Monotonic within band; stage bumps start at ≥ previous
                        jobs[job_id]["percent"] = max(prev_p, mapped) if stage == 0 else max(
                            max(prev_p, 85.0), mapped
                        )
                        # Friendly message with the monotonic stream %
                        if stage <= 0:
                            jobs[job_id]["message"] = f"받는 중… {disp:.0f}%"
                        else:
                            jobs[job_id]["message"] = (
                                f"추가 트랙 받는 중… {disp:.0f}% "
                                f"(전체 {jobs[job_id]['percent']:.0f}%)"
                            )
                    elif "Merging" in line or "Merger" in line or "Post-process" in line:
                        # Merge/remux can take long on large files — hold mid-90s, not 99
                        prev_p = float(jobs[job_id].get("percent") or 50)
                        jobs[job_id]["percent"] = max(prev_p, 93.0)
                        jobs[job_id]["percent"] = min(97.0, jobs[job_id]["percent"])
                        jobs[job_id]["message"] = "파일 합치는 중… (시간이 걸릴 수 있어요)"
                    elif "Deleting original" in line or "Fixup" in line:
                        jobs[job_id]["percent"] = max(
                            float(jobs[job_id].get("percent") or 90), 96.0
                        )
                        jobs[job_id]["message"] = "마무리 중…"

            try:
                code = proc.wait(timeout=3600)
            except subprocess.TimeoutExpired:
                kill_process_tree(proc)
                process_map.pop(job_id, None)
                raise RuntimeError("yt-dlp가 1시간 동안 끝나지 않아 중단했습니다")
            process_map.pop(job_id, None)
            with jobs_lock:
                if jobs.get(job_id, {}).get("cancel"):
                    jobs[job_id].update(
                        {
                            "status": "cancelled",
                            "message": "취소됨",
                            "error": "사용자가 취소했습니다",
                            "finishedAt": time.time(),
                        }
                    )
                    return
            if code == 0:
                break
            # aria2 can be rejected by a CDN even though yt-dlp's native
            # downloader works. Retry this exact format once without aria2,
            # then keep every later format fallback native as well.
            if should_retry_without_aria2(
                using_aria2,
                aria2_fallback_used,
                code,
                aria2_failure_line or last_line,
            ):
                aria2_fallback_used = True
                aria2_for_job = False
                native_retry_index = attempt_i + 1
                attempts.insert(native_retry_index, (fmt_try, merge_try, extra))
                continue
            # Retry only on format / DRM style failures
            err_l = (last_line or "").lower()
            if "format is not available" in err_l or "only images are available" in err_l or "drm" in err_l:
                continue
            # Other errors: don't keep retrying forever
            if attempt_i + 1 < len(attempts) and "http error 403" in err_l:
                continue
            break

        with jobs_lock:
            if jobs.get(job_id, {}).get("cancel"):
                jobs[job_id].update(
                    {
                        "status": "cancelled",
                        "message": "취소됨",
                        "error": "사용자가 취소했습니다",
                        "finishedAt": time.time(),
                    }
                )
                return

        # Resolve output file — prefer the exact path yt-dlp reported
        final_path = None
        final_size = 0
        try:
            if path_file.is_file():
                lines = [
                    ln.strip()
                    for ln in path_file.read_text(encoding="utf-8").splitlines()
                    if ln.strip()
                ]
                if lines:
                    final_path = lines[-1]
        except OSError:
            final_path = None
        if not final_path and printed_paths:
            final_path = printed_paths[-1]
        if not final_path:
            # Newest video file written after we started
            candidates = []
            for pat in ("*.mp4", "*.webm", "*.mkv", "*.m4a"):
                candidates.extend(work_dir.glob(pat))
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

            # Publish the completed media under its human title. The hidden
            # per-job path prevents an existing title from being overwritten
            # or mistaken for this job's result.
            try:
                source = Path(final_path)
                destination = unique_output_path(publish_dir, source.name)
                if source.resolve() != destination.resolve():
                    shutil.move(str(source), str(destination))
                    final_path = str(destination)
                # --write-thumbnail lands beside the template (inside work_dir);
                # publish it under the final stem instead of leaving litter.
                for thumb in list(work_dir.glob("*.jpg")) + list(work_dir.glob("*.png")) + list(work_dir.glob("*.webp")):
                    try:
                        thumb_dest = Path(final_path).with_suffix(thumb.suffix)
                        if not thumb_dest.exists():
                            shutil.move(str(thumb), str(thumb_dest))
                        else:
                            thumb.unlink(missing_ok=True)
                    except Exception:
                        pass
            except Exception as e:
                print(f"[uvd-helper] publish output: {e}", file=sys.stderr)
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
                        "message": f"저장 완료 → {publish_dir}",
                        "path": final_path or str(publish_dir),
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
                elif aria2_fallback_used:
                    err = (
                        "aria2 고속 다운로드가 실패해 기본 다운로더로 다시 시도했지만 "
                        f"완료하지 못했습니다: {err}"
                    )
                elif is_aria2_failure(code, err):
                    err = (
                        "aria2 고속 다운로드에 실패했습니다. "
                        "속도 설정을 안전 모드로 바꾼 뒤 다시 시도해 주세요"
                    )
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
    finally:
        # Session cookies must not linger on disk after the job ends
        if cookies_file:
            try:
                Path(cookies_file).unlink(missing_ok=True)
            except Exception:
                pass
        try:
            path_file.unlink(missing_ok=True)
        except Exception:
            pass
        with jobs_lock:
            state = jobs.get(job_id, {})
            finished_ok = state.get("status") == "done"
            purge = bool(state.get("purge"))
        if finished_ok or purge:
            # Completed downloads have been published; explicit cancels do not
            # want the partial files. Paused/errored jobs keep them so the same
            # resumeKey can --continue.
            purge_work_dir(work_dir)
        else:
            try:
                work_dir.rmdir()  # only succeeds when nothing was written
                TMP_ROOT.rmdir()
            except OSError:
                pass


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
                    "pairingMode": (
                        "manual"
                        if AUTH_TOKEN
                        else "paired"
                        if auto_pairing
                        else "available"
                    ),
                },
            )
            return

        if self.path.startswith("/job/"):
            if not request_authorized(self):
                send_json(self, 403, {"ok": False, "error": "forbidden origin"})
                return
            rest = self.path.split("/job/", 1)[-1].split("?")[0]
            if rest.endswith("/cancel"):
                job_id = rest[: -len("/cancel")].rstrip("/")
                ok = request_cancel_job(job_id)
                send_json(
                    self,
                    200 if ok else 404,
                    {"ok": ok, "error": None if ok else "job not found"},
                )
                return
            job_id = rest
            with jobs_lock:
                job = jobs.get(job_id)
                # strip non-serializable
                safe = {k: v for k, v in (job or {}).items() if k != "proc"}
            if not job:
                send_json(self, 404, {"ok": False, "error": "job not found"})
                return
            send_json(self, 200, {"ok": True, "job": safe})
            return

        send_json(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/pair" or self.path.startswith("/pair?"):
            origin = (self.headers.get("Origin") or "").strip()
            payload = read_json(self)
            ok, error = pair_extension(origin, str(payload.get("token") or ""))
            send_json(
                self,
                200 if ok else 409,
                {"ok": ok, "error": error or None, "pairingMode": "paired" if ok else "manual" if AUTH_TOKEN else "unavailable"},
            )
            return
        if not request_authorized(self):
            send_json(self, 403, {"ok": False, "error": "forbidden origin"})
            return

        # Cancel running yt-dlp job
        if self.path.startswith("/job/") and self.path.rstrip("/").endswith("/cancel"):
            rest = self.path.split("/job/", 1)[-1].split("?")[0]
            job_id = rest[: -len("/cancel")].rstrip("/") if rest.endswith("/cancel") else rest
            cancel_payload = read_json(self)
            # purge=true (user cancel) removes partial files; a pause omits it so
            # the next job with the same resumeKey can --continue.
            ok = request_cancel_job(job_id, purge=bool(cancel_payload.get("purge")))
            send_json(
                self,
                200 if ok else 404,
                {"ok": ok, "error": None if ok else "job not found"},
            )
            return

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
                cookies_list = payload_cookie_list(payload, url)
                if isinstance(cookies_list, list) and cookies_list:
                    cpath = COOKIE_DIR / f"formats_cookies_{uuid.uuid4().hex[:12]}.txt"
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
                cmd.append("--")
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
            audio_tracks, subtitle_tracks = collect_track_choices(info)

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
                    "audioTracks": audio_tracks,
                    "subtitleTracks": subtitle_tracks,
                },
            )
            return

        # Flat playlist listing (YouTube etc.) — no download
        if self.path == "/playlist" or self.path.startswith("/playlist?"):
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
            max_items = payload.get("max") or payload.get("limit") or 200
            try:
                max_items = int(max_items)
            except (TypeError, ValueError):
                max_items = 200
            max_items = max(1, min(500, max_items))
            cookies_file = None
            try:
                cookies_list = payload_cookie_list(payload, url)
                if isinstance(cookies_list, list) and cookies_list:
                    cpath = COOKIE_DIR / f"pl_cookies_{uuid.uuid4().hex[:12]}.txt"
                    n = write_netscape_cookies(cookies_list, cpath)
                    if n > 0:
                        cookies_file = str(cpath)
                cmd = [
                    bin_path,
                    "--flat-playlist",
                    "--skip-download",
                    "--ignore-config",
                    "-J",
                    "--playlist-end",
                    str(max_items),
                ]
                if cookies_file:
                    cmd.extend(["--cookies", cookies_file])
                cmd.append("--")
                cmd.append(url)
                out = subprocess.check_output(
                    cmd,
                    text=True,
                    timeout=120,
                    stderr=subprocess.STDOUT,
                )
                text = out.strip()
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
                send_json(self, 504, {"ok": False, "error": "재생목록 조회 시간 초과"})
                return
            except Exception as e:
                send_json(
                    self,
                    500,
                    {"ok": False, "error": f"재생목록 조회 실패: {e}"},
                )
                return
            finally:
                if cookies_file:
                    try:
                        Path(cookies_file).unlink(missing_ok=True)
                    except Exception:
                        pass

            raw_entries = info.get("entries") or []
            pl_title = info.get("title") or info.get("playlist_title") or "재생목록"
            entries_out = []
            is_yt_pl = bool(
                re.search(r"youtube\.com|youtu\.be|music\.youtube", (url or ""), re.I)
            )

            def _yt_video_id(*candidates: object) -> str:
                """Extract a single YouTube video id (11 chars), never a list id."""
                for c in candidates:
                    if c is None:
                        continue
                    s = str(c).strip()
                    if not s:
                        continue
                    if re.match(r"^[\w-]{11}$", s) and not re.match(
                        r"^(PL|UU|LL|FL|OL|RD|SD|UL)", s, re.I
                    ):
                        return s
                    m = re.search(
                        r"(?:v=|/shorts/|/embed/|/live/|youtu\.be/)([\w-]{11})",
                        s,
                    )
                    if m:
                        return m.group(1)
                    m = re.search(
                        r"(?:ytimg\.com|img\.youtube\.com)/vi/([\w-]{11})/",
                        s,
                    )
                    if m:
                        return m.group(1)
                return ""

            for e in raw_entries:
                if not e or e.get("entries"):
                    continue
                raw_id = e.get("id") or ""
                eurl = e.get("url") or e.get("webpage_url") or e.get("original_url") or ""
                # Resolve per-entry video id BEFORE building thumb (critical:
                # flat playlist sometimes attaches the *playlist cover* thumb
                # which is always the first video — never reuse that as-is.)
                vid = _yt_video_id(raw_id, eurl, e.get("display_id"))
                if not vid:
                    ths = e.get("thumbnails") or []
                    if isinstance(ths, list):
                        for t in ths:
                            u = t.get("url") if isinstance(t, dict) else t
                            vid = _yt_video_id(u)
                            if vid:
                                break
                if not vid:
                    vid = _yt_video_id(e.get("thumbnail"))

                eid = vid or str(raw_id or eurl or "")
                etitle = (e.get("title") or eid or "영상")
                if isinstance(etitle, str):
                    etitle = etitle.strip()
                else:
                    etitle = str(etitle)

                if is_yt_pl and vid:
                    eurl = f"https://www.youtube.com/watch?v={vid}"
                elif not eurl and eid and is_yt_pl:
                    eurl = f"https://www.youtube.com/watch?v={eid}"
                elif not eurl and eid:
                    eurl = str(eid) if str(eid).startswith("http") else ""
                if not eurl:
                    continue

                dur = e.get("duration") or 0
                try:
                    dur = float(dur or 0)
                except (TypeError, ValueError):
                    dur = 0

                # Per-video poster only. Do NOT fall back to playlist-level
                # or shared first-video cover — that made every row identical.
                thumb = ""
                if vid:
                    thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                else:
                    thumb = (e.get("thumbnail") or "") or ""
                    if not thumb:
                        ths = e.get("thumbnails") or []
                        if isinstance(ths, list) and ths:
                            for t in reversed(ths):
                                if isinstance(t, dict) and t.get("url"):
                                    thumb = t["url"]
                                    break
                                if isinstance(t, str) and t.startswith("http"):
                                    thumb = t
                                    break
                    if isinstance(thumb, str) and thumb.startswith("//"):
                        thumb = "https:" + thumb
                    # If thumb still points at a YT id, prefer stable CDN for *that* id
                    tvid = _yt_video_id(thumb)
                    if tvid:
                        thumb = f"https://i.ytimg.com/vi/{tvid}/hqdefault.jpg"

                uploader = (
                    e.get("uploader")
                    or e.get("channel")
                    or e.get("playlist_uploader")
                    or ""
                )
                entries_out.append(
                    {
                        "id": str(vid or eid),
                        "title": etitle[:120],
                        "url": eurl,
                        "duration": int(dur) if dur >= 1 else 0,
                        "thumbnail": thumb or "",
                        "uploader": str(uploader)[:60] if uploader else "",
                        "view_count": e.get("view_count") or 0,
                    }
                )
                if len(entries_out) >= max_items:
                    break

            send_json(
                self,
                200,
                {
                    "ok": True,
                    "url": url,
                    "title": pl_title,
                    "count": len(entries_out),
                    "playlistCount": info.get("playlist_count")
                    or info.get("n_entries")
                    or len(entries_out),
                    "entries": entries_out,
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


def cleanup_stale_cookie_files() -> None:
    """Remove cookie files left over from previous runs (crashes, old versions)."""
    try:
        for p in COOKIE_DIR.glob("*.txt"):
            try:
                p.unlink()
            except OSError:
                pass
    except Exception:
        pass


def main() -> None:
    cleanup_stale_cookie_files()
    swept = sweep_tmp_dirs()
    if swept:
        print(f"[uvd-helper] removed {swept} abandoned temp dir(s)", file=sys.stderr)
    bin_path = find_ytdlp()
    print(f"UVD yt-dlp helper  http://{HOST}:{PORT}")
    print(f"  output: {OUT_DIR}")
    origin_desc = ALLOWED_ORIGIN_EXACT or "chrome-extension://* (웹페이지 차단)"
    print(f"  origin: {origin_desc}" + ("  · token 필요" if AUTH_TOKEN else ""))
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
