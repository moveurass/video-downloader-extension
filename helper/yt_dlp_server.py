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
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("UVD_PORT", "8787"))
HOME = Path.home()
OUT_DIR = Path(os.environ.get("UVD_OUT", HOME / "Downloads" / "VideoDownloader"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


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
                "message": "yt-dlp 시작…",
                "startedAt": time.time(),
            }
        )

    if not bin_path:
        with jobs_lock:
            jobs[job_id].update(
                {
                    "status": "error",
                    "percent": 0,
                    "message": "yt-dlp가 설치되어 있지 않습니다. pip install -U yt-dlp",
                    "error": "yt-dlp not found",
                }
            )
        return

    if not url:
        with jobs_lock:
            jobs[job_id].update(
                {"status": "error", "message": "URL 없음", "error": "no url"}
            )
        return

    # Prefer page URL when both given (site extractors work on watch pages)
    target = page_url if page_url and page_url.startswith("http") else url
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
        outtmpl = str(OUT_DIR / f"{safe}.%(ext)s")
    else:
        # yt-dlp title; still strip leading (N) via output template filter is limited,
        # so use plain title and rely on post-rename if needed
        outtmpl = str(OUT_DIR / "%(title).80B.%(ext)s")

    site = (payload.get("site") or "").lower()
    host = ""
    try:
        host = urlparse(target).hostname or ""
    except Exception:
        host = ""

    is_youtube = site == "youtube" or "youtube" in host or "youtu.be" in target
    is_tiktok = site == "tiktok" or "tiktok" in host

    # ── format selection (maximize quality; never re-encode) ──
    # YouTube serves separate video/audio streams. Must pick best of each + merge.
    # Avoid forcing android client — it often caps at 360p/720p.
    merge_fmt = "mp4"
    sort_args: list[str] = []

    if is_tiktok:
        if quality in ("best", "all", ""):
            fmt = "b"
        elif quality.endswith("p") and quality[:-1].isdigit():
            h = quality[:-1]
            fmt = f"b[height<=?{h}]/b"
        else:
            fmt = "b"
    elif is_youtube:
        # Max resolution + best audio, with broad fallbacks so "format not available" is rare.
        # (Do not force player_client=web/tv/ios — some sessions mark those DRM-only.)
        if quality in ("best", "all", "", "4K", "2160p", "max", "highest"):
            fmt = "bv*+ba/b"
        elif quality == "1440p":
            fmt = "bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/b"
        elif quality == "1080p":
            fmt = "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b"
        elif quality == "720p":
            fmt = "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b"
        elif quality.endswith("p") and quality[:-1].isdigit():
            h = quality[:-1]
            fmt = f"bv*[height<=?{h}]+ba/b[height<=?{h}]/bv*+ba/b"
        else:
            fmt = "bv*+ba/b"
        # Highest resolution first (4K > 1080)
        sort_args = ["-S", "res,fps,hdr:12,vbr,tbr,abr,asr"]
        # mkv accepts VP9/AV1+Opus without re-encode; mp4 fallback after merge if needed
        merge_fmt = "mkv"
    else:
        if quality in ("best", "all", ""):
            fmt = "bv*+ba/b"
        elif quality.endswith("p") and quality[:-1].isdigit():
            h = quality[:-1]
            fmt = f"bv*[height<=?{h}]+ba/b[height<=?{h}]/b"
        else:
            fmt = "bv*+ba/b"

    # Concurrent DASH/HLS fragments (4K has many fragments — parallel is essential)
    concurrent = "16" if is_youtube else "4"
    referer = page_url or payload.get("referer") or ""

    def build_cmd(format_str: str, merge: str, extra: list[str] | None = None) -> list[str]:
        c = [
            bin_path,
            "--no-playlist",
            "--newline",
            "-f",
            format_str,
            "--merge-output-format",
            merge,
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
        c.extend(sort_args)
        if not title_hint:
            c.append("--restrict-filenames")
        if referer:
            c.extend(["--add-header", f"Referer:{referer}"])
            try:
                origin = f"{urlparse(referer).scheme}://{urlparse(referer).netloc}"
                c.extend(["--add-header", f"Origin:{origin}"])
            except Exception:
                pass
        cookies = payload.get("cookies")
        if cookies and Path(cookies).is_file():
            c.extend(["--cookies", cookies])
        if payload.get("cookiesFromBrowser"):
            c.extend(["--cookies-from-browser", str(payload["cookiesFromBrowser"])])
        # Do NOT force youtube player_client — default clients get 4K and avoid DRM traps
        if extra:
            c.extend(extra)
        c.append(target)
        return c

    # Attempt chain: best quality → progressive best → any video
    attempts: list[tuple[str, str, list[str]]] = [
        (fmt, merge_fmt if is_youtube else "mp4", []),
        ("bv*+ba/b", "mkv", []),
        ("bestvideo+bestaudio/best", "mkv", []),
        ("best", "mp4", []),
    ]
    # de-dupe identical format strings
    seen_fmt = set()
    uniq_attempts = []
    for a in attempts:
        if a[0] in seen_fmt:
            continue
        seen_fmt.add(a[0])
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
                    jobs[job_id]["message"] = line[-200:]
                    if percent is not None:
                        jobs[job_id]["percent"] = max(2, min(99, percent))
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
            try:
                out = subprocess.check_output(
                    [
                        bin_path,
                        "--skip-download",
                        "--no-playlist",
                        "--ignore-config",
                        "-J",
                        url,
                    ],
                    text=True,
                    timeout=90,
                    stderr=subprocess.DEVNULL,
                )
                info = json.loads(out)
            except subprocess.TimeoutExpired:
                send_json(self, 504, {"ok": False, "error": "포맷 조회 시간 초과"})
                return
            except Exception as e:
                send_json(
                    self,
                    500,
                    {"ok": False, "error": f"포맷 조회 실패: {e}"},
                )
                return

            # Collect video heights from formats (and nested entries for playlists)
            entries = info.get("entries") or [info]
            heights: set[int] = set()
            for ent in entries:
                if not ent:
                    continue
                for f in ent.get("formats") or []:
                    if not f:
                        continue
                    # video-only or combined with video
                    h = f.get("height")
                    vcodec = (f.get("vcodec") or "none").lower()
                    if h and vcodec != "none":
                        try:
                            heights.add(int(h))
                        except (TypeError, ValueError):
                            pass
                # top-level height
                if ent.get("height"):
                    try:
                        heights.add(int(ent["height"]))
                    except (TypeError, ValueError):
                        pass

            # Map to UI labels (only buckets that exist). Skip tiny storyboard-like sizes.
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

            # Prefer one chip per bucket (highest height in that bucket kept for sorting)
            bucket_max: dict[str, int] = {}
            for h in heights:
                lab = label_for(h)
                if not lab:
                    continue
                bucket_max[lab] = max(bucket_max.get(lab, 0), h)

            order = ["4K", "1440p", "1080p", "720p", "480p", "360p", "240p"]
            qualities = []
            # "best" always first — means max available
            if bucket_max:
                qualities.append(
                    {
                        "id": "best",
                        "label": "최고",
                        "height": max(bucket_max.values()),
                    }
                )
            for lab in order:
                if lab in bucket_max:
                    qualities.append(
                        {"id": lab, "label": lab, "height": bucket_max[lab]}
                    )
            # any odd heights not in buckets
            for lab, h in sorted(bucket_max.items(), key=lambda x: -x[1]):
                if lab not in order and lab != "best":
                    qualities.append({"id": lab, "label": lab, "height": h})

            send_json(
                self,
                200,
                {
                    "ok": True,
                    "url": url,
                    "title": info.get("title") or "",
                    "heights": sorted(heights, reverse=True),
                    "qualities": qualities,
                },
            )
            return

        if self.path == "/download" or self.path.startswith("/download?"):
            payload = read_json(self)
            bin_path = find_ytdlp()
            if not bin_path:
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

            url = (payload.get("url") or payload.get("pageUrl") or "").strip()
            if not url:
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
