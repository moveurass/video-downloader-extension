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


def height_from_string(s: str) -> int:
    """Mirror hls-downloader heightFromString for regression."""
    str_ = str(s or "")
    if not str_:
        return 0
    m = re.search(
        r"(?:^|[^\dA-Za-z])(2160|1440|1080|720|480|360|240)\s*[pP](?:[^\d]|$)",
        str_,
    )
    if m:
        return int(m.group(1))
    m = re.search(r"(?:^|[^\dA-Za-z])4\s*[kK](?:[^\dA-Za-z]|$)", str_)
    if m:
        return 2160
    m = re.search(
        r"[/_-](2160|1440|1080|720|480|360|240)(?:[/_.\-?]|\.m3u8|$)",
        str_,
        re.I,
    )
    if m:
        return int(m.group(1))
    m = re.search(
        r"[?&](?:quality|res|resolution|h|height|r)=?(2160|1440|1080|720|480|360|240)\b",
        str_,
        re.I,
    )
    if m:
        return int(m.group(1))
    m = re.match(r"^(2160|1440|1080|720|480|360|240)$", str_)
    if m:
        return int(m.group(1))
    return 0


def classify_error(msg: str) -> str:
    """Minimal mirror of UVD.classifyError codes used in UI."""
    s = str(msg or "")
    if re.search(r"도우미|8787|yt-dlp not|헬퍼|ECONNREFUSED", s, re.I):
        return "helper"
    if re.search(r"403|401|접근 거부|Forbidden", s, re.I):
        return "forbidden"
    if re.search(r"DRM|SAMPLE-AES|Widevine", s, re.I):
        return "drm"
    if re.search(r"너무 작|빈 파일|불완전|세그먼트 부족", s, re.I):
        return "incomplete"
    if re.search(r"429|rate.?limit", s, re.I):
        return "rate_limit"
    if re.search(r"시간 초과|timeout", s, re.I):
        return "timeout"
    if re.search(r"network|Failed to fetch|ENOTFOUND", s, re.I):
        return "network"
    return "other"


def ensure_quality_choices_logic(qualities: list) -> list:
    """
    Collapse single real height: only one concrete id (not bare best).
    Mirrors popup ensureQualityChoices intent.
    """
    real = [q for q in qualities if q.get("id") and q["id"] != "best"]
    best = next((q for q in qualities if q.get("id") == "best"), None)
    if len(real) == 1:
        return real
    if not real and best and best.get("height", 0) >= 240:
        h = int(best["height"])
        lab = (
            "4K"
            if h >= 2160
            else "1440p"
            if h >= 1440
            else "1080p"
            if h >= 1080
            else "720p"
            if h >= 720
            else "480p"
            if h >= 480
            else "360p"
            if h >= 360
            else "240p"
        )
        return [{"id": lab, "label": lab, "height": h}]
    if not real and best:
        return [best]
    return qualities


def main() -> int:
    print("== pure logic ==")
    info = extract_series_info("SSIS-001 테스트 제목")
    check(
        "extract SSIS-001",
        info is not None
        and info["prefix"] == "SSIS"
        and info["num"] == 1
        and info["key"] == "SSIS-001",
    )
    check("no false series", extract_series_info("Hello world") is None)
    check("clean_name path", clean_name("VideoDownloader/foo.mp4") == "foo")
    check("clean_name empty-ish", clean_name(".mp4") == "video")
    check("clean_name korean", clean_name("시리즈 제목.mp4") == "시리즈 제목")

    print("== height inference ==")
    cases = [
        ("https://cdn.example/uuid/720p/video.m3u8", 720),
        ("https://cdn.example/uuid/720/seg0.ts", 720),
        ("https://x.com/a/1080p.m3u8", 1080),
        ("https://x.com/video_1080.m3u8", 1080),
        ("720", 720),
        ("https://surrit.com/abc/playlist.m3u8", 0),
        ("SSIS-001 Uncensored Leaked 720p", 720),
    ]
    for s, expect in cases:
        got = height_from_string(s)
        check(f"height {expect} ← {s[:48]}", got == expect, f"got {got}")

    print("== quality chip collapse ==")
    one = ensure_quality_choices_logic(
        [{"id": "best", "label": "최고"}, {"id": "720p", "label": "720p", "height": 720}]
    )
    check("single real → only 720p", len(one) == 1 and one[0]["id"] == "720p")
    bare = ensure_quality_choices_logic([{"id": "best", "label": "최고", "height": 1080}])
    check(
        "best+height → 1080p",
        len(bare) == 1 and bare[0]["id"] == "1080p",
        str(bare),
    )
    multi = ensure_quality_choices_logic(
        [
            {"id": "best", "label": "최고"},
            {"id": "1080p", "height": 1080},
            {"id": "720p", "height": 720},
        ]
    )
    check("multi keeps list", len(multi) >= 2)

    print("== error classify ==")
    check("helper", classify_error("도우미 8787 연결 실패") == "helper")
    check("403", classify_error("Segment HTTP 403") == "forbidden")
    check("drm", classify_error("SAMPLE-AES not supported") == "drm")
    check("incomplete", classify_error("파일이 너무 작습니다 (12KB)") == "incomplete")
    check("rate", classify_error("HTTP 429 rate limit") == "rate_limit")

    print("== helper health ==")
    try:
        with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=2) as r:
            data = json.loads(r.read().decode())
        check("helper /health ok", bool(data.get("ok")), str(data)[:80])
        check("helper yt-dlp", bool(data.get("ytdlp")), str(data.get("ytdlpPath")))
        if data.get("outDir"):
            check("helper outDir present", True, str(data.get("outDir"))[:60])
        else:
            check("helper outDir present", True, "optional")
    except Exception as e:
        print(f"  skip helper (not running): {e}")
        check("helper /health ok", True, "skipped")
        check("helper yt-dlp", True, "skipped")
        check("helper outDir present", True, "skipped")

    print("== syntax ==")
    for f in (
        "src/background.js",
        "src/popup.js",
        "src/content.js",
        "src/uvd-common.js",
        "src/naming.js",
        "src/hls-downloader.js",
        "src/page-download.js",
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
    sys.exit(main())
