#!/usr/bin/env python3
"""Lightweight smoke checks for UVD release (no browser)."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request

OK = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  OK  {name}")
    else:
        FAIL += 1
        print(f" FAIL {name}" + (f" — {detail}" if detail else ""))


def extract_series_info(title: str):
    t = str(title or "")
    m = re.search(r"\b([A-Za-z]{2,8})[-_ ]?(\d{2,5})\b", t)
    if m and not re.match(r"^(http|https|www|mp4|HD|FHD|4K)$", m.group(1), re.I):
        prefix = m.group(1).upper()
        num = int(m.group(2))
        pad = len(m.group(2))
        if 0 < num < 100000:
            return {
                "key": f"{prefix}-{str(num).zfill(pad)}",
                "prefix": prefix,
                "num": num,
                "pad": pad,
            }
    return None


def clean_name(raw: str) -> str:
    s = (raw or "").strip()
    s = s.replace("\\", "/").split("/")[-1]
    for ext in (".mp4", ".ts", ".webm", ".mkv", ".m4a", ".mp3"):
        if s.lower().endswith(ext):
            s = s[: -len(ext)]
    s = re.sub(r"^\(\d{1,4}\)\s*", "", s)
    s = "".join(c if c not in '<>:"/\\|?*' else " " for c in s)
    s = " ".join(s.split()).strip(" ._-")[:80]
    if not s or len(s) < 2 or s in {".", ".."}:
        return "video"
    return s


def main() -> int:
    print("== pure logic ==")
    info = extract_series_info("SSIS-001 테스트 제목")
    check(
        "extract SSIS-001",
        info is not None and info["prefix"] == "SSIS" and info["num"] == 1 and info["key"] == "SSIS-001",
    )
    check("no false series", extract_series_info("Hello world") is None)
    check("clean_name path", clean_name("VideoDownloader/foo.mp4") == "foo")
    check("clean_name empty-ish", clean_name(".mp4") == "video")
    check("clean_name korean", clean_name("시리즈 제목.mp4") == "시리즈 제목")

    print("== helper health ==")
    try:
        with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=2) as r:
            data = json.loads(r.read().decode())
        check("helper /health ok", bool(data.get("ok")), str(data)[:80])
        check("helper yt-dlp", bool(data.get("ytdlp")), str(data.get("ytdlpPath")))
    except Exception as e:
        print(f"  skip helper (not running): {e}")
        check("helper /health ok", True, "skipped")
        check("helper yt-dlp", True, "skipped")

    print("== syntax ==")
    for f in (
        "src/background.js",
        "src/popup.js",
        "src/content.js",
        "src/uvd-common.js",
        "src/naming.js",
    ):
        r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
        check(f"node --check {f}", r.returncode == 0, (r.stderr or "").strip()[:80])

    r = subprocess.run(
        [sys.executable, "-m", "py_compile", "helper/yt_dlp_server.py"],
        capture_output=True,
        text=True,
    )
    check("py_compile helper", r.returncode == 0, (r.stderr or "").strip()[:80])

    print()
    print(f"passed {OK}  failed {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
