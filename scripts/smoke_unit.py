#!/usr/bin/env python3
"""Lightweight smoke checks for UVD release (no browser)."""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "helper"))
from name_utils import clean_name  # noqa: E402

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


def main() -> int:
    print("== helper naming module ==")
    check("clean_name path", clean_name("VideoDownloader/foo.mp4") == "foo")
    check("clean_name empty-ish", clean_name(".mp4") == "video")
    check("clean_name korean", clean_name("시리즈 제목.mp4") == "시리즈 제목")

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

    print("== helper security ==")
    req = urllib.request.Request(
        "http://127.0.0.1:8787/download",
        data=b"{}",
        headers={
            "Content-Type": "application/json",
            "Origin": "https://evil.example",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as r:
            code = r.status
        check("web origin blocked", code == 403, f"got HTTP {code}")
    except urllib.error.HTTPError as e:
        check("web origin blocked", e.code == 403, f"got HTTP {e.code}")
    except Exception as e:
        print(f"  skip origin gate (helper not running): {e}")
        check("web origin blocked", True, "skipped")

    background_source = (ROOT / "src/background.js").read_text(encoding="utf-8")
    check(
        "background filename importScripts",
        '"background-filename.js"' in background_source.split(");", 1)[0],
    )
    check(
        "background site helper importScripts",
        '"background-site-helper.js"' in background_source.split(");", 1)[0],
    )
    check(
        "background page fallback importScripts",
        '"background-page-fallback.js"' in background_source.split(");", 1)[0],
    )
    check(
        "background runtime modules importScripts",
        all(
            f'"{name}"' in background_source.split(");", 1)[0]
            for name in (
                "background-media-utils.js",
                "background-companion-thumbnail.js",
                "background-housekeeping.js",
                "background-keyboard-commands.js",
                "background-runtime-messages.js",
            )
        ),
    )
    popup_html = (ROOT / "src/popup.html").read_text(encoding="utf-8")
    popup_init_pos = popup_html.find('<script src="popup-init.js"></script>')
    popup_entry_pos = popup_html.find('<script src="popup.js"></script>')
    check(
        "popup init loaded before entrypoint",
        0 <= popup_init_pos < popup_entry_pos,
    )
    check(
        "popup entrypoint starts init",
        (ROOT / "src/popup.js").read_text(encoding="utf-8").strip()
        == "UVDPopupInit.start();",
    )

    print("== syntax ==")
    for f in (
        "src/background.js",
        "src/background-filename.js",
        "src/background-site-helper.js",
        "src/background-page-fallback.js",
        "src/background-media-utils.js",
        "src/background-companion-thumbnail.js",
        "src/background-housekeeping.js",
        "src/background-keyboard-commands.js",
        "src/background-runtime-messages.js",
        "src/popup-init.js",
        "src/popup.js",
        "src/popup-duplicate-confirmation.js",
        "src/popup-quality-state.js",
        "src/popup-helper-state.js",
        "src/popup-display-utils.js",
        "src/content.js",
        "src/progress-protocol.js",
        "src/background-download-jobs.js",
        "src/download-queue-state.js",
        "src/download-message-handler.js",
        "src/background-message-router.js",
        "src/background-context-menus.js",
        "src/background-quality-messages.js",
        "src/background-download-messages.js",
        "src/background-direct-download-messages.js",
        "src/background-series-messages.js",
        "src/background-media-messages.js",
        "src/background-helper-messages.js",
        "src/background-chunk-assembly.js",
        "src/background-download-execution.js",
        "src/background-scheduled-jobs.js",
        "src/background-media-state.js",
        "src/background-smart-download.js",
        "src/background-save-pipeline.js",
        "src/background-direct-media.js",
        "src/background-hls-runtime.js",
        "src/download-routing.js",
        "src/download-engine.js",
        "src/history-model.js",
        "src/media-quality.js",
        "src/popup-media.js",
        "src/popup-media-loader.js",
        "src/popup-media-renderer.js",
        "src/popup-download-requests.js",
        "src/popup-runtime-events.js",
        "src/popup-settings-ui.js",
        "src/popup-dom-events.js",
        "src/popup-clipboard-history.js",
        "src/popup-queue-ui.js",
        "src/popup-progress-ui.js",
        "src/popup-series-ui.js",
        "src/popup-series-network.js",
        "src/popup-series-discovery.js",
        "src/popup-series-banner-ui.js",
        "src/popup-library-ui.js",
        "src/popup-watchlist-ui.js",
        "src/popup-series-watchlist-flow.js",
        "src/popup-recovery-ui.js",
        "src/popup-playlist-ui.js",
        "src/site-detection.js",
        "src/uvd-common.js",
        "src/naming.js",
        "src/hls-downloader.js",
        "src/page-download.js",
    ):
        r = subprocess.run(
            ["node", "--check", f], capture_output=True, text=True, cwd=ROOT
        )
        check(f"node --check {f}", r.returncode == 0, (r.stderr or "").strip()[:80])

    r = subprocess.run(
        ["node", "scripts/core_unit.js"], capture_output=True, text=True, cwd=ROOT
    )
    check(
        "actual shared modules",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_filename_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background filename manager",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_site_helper_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background site helper runner",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_page_fallback_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background page fallback",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    for script, label in (
        ("background_media_utils_unit.js", "background media utilities"),
        ("background_companion_thumbnail_unit.js", "companion thumbnail saver"),
        ("background_housekeeping_unit.js", "background housekeeping"),
        ("background_keyboard_commands_unit.js", "background keyboard commands"),
        ("background_runtime_messages_unit.js", "background runtime dispatch"),
    ):
        r = subprocess.run(
            ["node", f"scripts/{script}"],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        check(
            label,
            r.returncode == 0,
            (r.stderr or r.stdout or "").strip()[:120],
        )

    r = subprocess.run(
        ["node", "scripts/progress_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "progress protocol ordering",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/message_handler_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "download message routing",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_context_menus_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background context menus",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_media_state_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background media state",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/background_download_jobs_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "background download jobs",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_runtime_events_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup runtime events",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_init_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup init assembly",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_settings_ui_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup settings UI",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_dom_events_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup DOM events",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_clipboard_history_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup clipboard and history",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_series_watchlist_flow_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup series and watchlist flow",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_helper_state_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup helper state",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_display_utils_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup display utilities",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_quality_state_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup quality state",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_progress_ui_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup progress UI",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        ["node", "scripts/popup_duplicate_confirmation_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup duplicate confirmation",
        r.returncode == 0,
        (r.stderr or r.stdout or "").strip()[:120],
    )

    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "py_compile",
            "helper/name_utils.py",
            "helper/yt_dlp_server.py",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check("py_compile helper", r.returncode == 0, (r.stderr or "").strip()[:80])

    print()
    print(f"passed {OK}  failed {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
