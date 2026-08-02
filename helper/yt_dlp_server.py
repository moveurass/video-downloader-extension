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

    # output template
    if title_hint:
        safe = "".join(c if c not in '<>:"/\\|?*' else " " for c in title_hint)
        safe = " ".join(safe.split())[:80] or "video"
        # strip extension from hint
        for ext in (".mp4", ".ts", ".webm", ".mkv", ".m4a"):
            if safe.lower().endswith(ext):
                safe = safe[: -len(ext)]
        outtmpl = str(OUT_DIR / f"{safe}.%(ext)s")
    else:
        outtmpl = str(OUT_DIR / "%(title).80B [%(id)s].%(ext)s")

    # format selection
    if quality in ("best", "all", ""):
        fmt = "bv*+ba/b"
    elif quality == "4K":
        fmt = "bv*[height<=2160]+ba/b[height<=2160]/b"
    elif quality.endswith("p") and quality[:-1].isdigit():
        h = quality[:-1]
        fmt = f"bv*[height<=?{h}]+ba/b[height<=?{h}]/b"
    else:
        fmt = "bv*+ba/b"

    cmd = [
        bin_path,
        "--no-playlist",
        "--newline",
        "-f",
        fmt,
        "--merge-output-format",
        "mp4",
        "-o",
        outtmpl,
        "--restrict-filenames",
        "--no-overwrites",
        "--ignore-config",
    ]

    referer = page_url or payload.get("referer") or ""
    if referer:
        cmd.extend(["--add-header", f"Referer:{referer}"])
        try:
            origin = f"{urlparse(referer).scheme}://{urlparse(referer).netloc}"
            cmd.extend(["--add-header", f"Origin:{origin}"])
        except Exception:
            pass

    cookies = payload.get("cookies")  # optional Netscape string path later
    if cookies and Path(cookies).is_file():
        cmd.extend(["--cookies", cookies])

    cmd.append(target)

    with jobs_lock:
        jobs[job_id]["cmd"] = " ".join(cmd[:6]) + " …"
        jobs[job_id]["target"] = target
        jobs[job_id]["outDir"] = str(OUT_DIR)

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        last_line = ""
        for line in proc.stdout:
            line = line.rstrip()
            last_line = line
            percent = None
            # [download]  45.2% of ...
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
                elif "Destination" in line or "Merging" in line:
                    jobs[job_id]["percent"] = max(jobs[job_id].get("percent", 50), 90)
                    jobs[job_id]["message"] = "파일 합치는 중…"

        code = proc.wait(timeout=3600)
        with jobs_lock:
            if code == 0:
                jobs[job_id].update(
                    {
                        "status": "done",
                        "percent": 100,
                        "message": f"저장 완료 → {OUT_DIR}",
                        "finishedAt": time.time(),
                    }
                )
            else:
                jobs[job_id].update(
                    {
                        "status": "error",
                        "percent": 0,
                        "message": last_line or f"yt-dlp 종료 코드 {code}",
                        "error": last_line or f"exit {code}",
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
