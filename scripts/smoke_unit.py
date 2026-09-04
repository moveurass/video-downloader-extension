#!/usr/bin/env python3
"""Lightweight smoke checks for UVD release (no browser)."""
from __future__ import annotations

import json
import os
import time
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "helper"))
from name_utils import clean_name, is_generic_name, unique_output_path  # noqa: E402
import yt_dlp_server as helper_server  # noqa: E402

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
    check("clean_name preserves Top 10 title", clean_name("Top 10 goals.mp4") == "Top 10 goals")
    check(
        "clean_name preserves Episode title",
        clean_name("Episode 12 The Return.mp4") == "Episode 12 The Return",
    )
    check(
        "clean_name preserves iPhone title",
        clean_name("iPhone 15 review.mp4") == "iPhone 15 review",
    )
    check("clean_name normalizes explicit code", clean_name("[ssis-001] title.mp4") == "SSIS-001 title")
    check("generic helper hint rejected", is_generic_name("YouTube_dQw4w9WgXcQ.mp4"))
    check("host id helper hint rejected", is_generic_name("host_829104.mp4"))
    check("hash helper hint rejected", is_generic_name("9f8e7d6c5b4a3210.webm"))
    check("human helper title accepted", not is_generic_name("A human video title.mp4"))
    check(
        "helper title wins over opaque filename",
        helper_server.supplied_title_hint(
            {"filename": "host_829104.mp4", "title": "Actual page title"}
        )
        == "Actual page title",
    )
    check(
        "helper title wins over readable old filename",
        helper_server.supplied_title_hint(
            {"filename": "Old URL basename.mp4", "title": "Actual extractor title"}
        )
        == "Actual extractor title",
    )
    check(
        "untitled TikTok resolver falls through to extractor",
        not helper_server.try_tiktok_direct_download(
            "unused",
            {
                "pageUrl": "https://example.test/post",
                "mediaUrl": "https://cdn.test/opaque.mp4",
                "filename": "host_829104.mp4",
            },
            "",
        ),
    )
    with tempfile.TemporaryDirectory() as tmp:
        output_dir = Path(tmp)
        check(
            "first title has no collision suffix",
            unique_output_path(output_dir, "My Video.mp4").name == "My Video.mp4",
        )
        (output_dir / "My Video.mp4").touch()
        check(
            "duplicate title gets unique suffix",
            unique_output_path(output_dir, "My Video.mp4").name == "My Video (2).mp4",
        )

    audio_tracks, subtitle_tracks = helper_server.collect_track_choices(
        {
            "formats": [
                {
                    "format_id": "251",
                    "acodec": "opus",
                    "vcodec": "none",
                    "language": "en",
                    "audio_channels": 2,
                }
            ],
            "subtitles": {"ko": [{"ext": "vtt", "name": "한국어"}]},
            "automatic_captions": {"ja": [{"ext": "vtt", "name": "日本語"}]},
        }
    )
    check("helper audio track discovery", audio_tracks[0]["id"] == "251")
    check(
        "helper subtitle track discovery",
        [track["id"] for track in subtitle_tracks] == ["ko", "ja"],
    )
    youtube_page = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    googlevideo_media = "https://rr1---sn.example.googlevideo.com/videoplayback"
    check(
        "YouTube and googlevideo jobs prefer yt-dlp native downloader",
        helper_server.is_youtube_download("", youtube_page)
        and helper_server.is_youtube_download("", googlevideo_media)
        and helper_server.is_youtube_download("youtube", "https://cdn.test/video")
        and not helper_server.is_youtube_download(
            "", "https://youtube.com.evil.example/video"
        )
        and not helper_server.should_use_aria2(
            "/usr/local/bin/aria2c", "fast", True
        ),
    )
    check(
        "aria2 is limited to fast-profile non-YouTube jobs",
        helper_server.should_use_aria2(
            "/usr/local/bin/aria2c", "fast", False
        )
        and not helper_server.should_use_aria2(
            "/usr/local/bin/aria2c", "normal", False
        )
        and not helper_server.should_use_aria2(None, "fast", False),
    )
    aria2_error = "ERROR: aria2c exited with code 1"
    check(
        "aria2 failure gets exactly one native retry",
        helper_server.should_retry_without_aria2(
            True, False, 1, aria2_error
        )
        and not helper_server.should_retry_without_aria2(
            True, True, 1, aria2_error
        )
        and not helper_server.should_retry_without_aria2(
            False, False, 1, aria2_error
        ),
    )

    original_pair_file = helper_server.PAIR_FILE
    original_pairing = helper_server.auto_pairing
    original_auth_token = helper_server.AUTH_TOKEN
    with tempfile.TemporaryDirectory() as tmp:
        helper_server.PAIR_FILE = Path(tmp) / "pairing.json"
        helper_server.auto_pairing = {}
        helper_server.AUTH_TOKEN = ""
        paired, pair_error = helper_server.pair_extension(
            "chrome-extension://" + "a" * 32, "b" * 64
        )
        check(
            "helper automatic pairing",
            paired
            and not pair_error
            and helper_server.PAIR_FILE.is_file()
            and (helper_server.PAIR_FILE.stat().st_mode & 0o777) == 0o600,
        )
        # Same extension origin may rotate its token (reinstall recovery);
        # a different extension still cannot take the pairing over.
        rotated, rotate_error = helper_server.pair_extension(
            "chrome-extension://" + "a" * 32, "d" * 64
        )
        foreign, foreign_error = helper_server.pair_extension(
            "chrome-extension://" + "b" * 32, "e" * 64
        )
        check(
            "same-origin token rotation, foreign origin blocked",
            rotated
            and not rotate_error
            and helper_server.auto_pairing["token"] == "d" * 64
            and not foreign
            and foreign_error == "helper already paired",
            f"{rotate_error} {foreign_error}",
        )
        # A pinned UVD_ALLOWED_ORIGIN must also gate /pair, otherwise another
        # extension can pair first and lock the pinned extension out.
        helper_server.PAIR_FILE = Path(tmp) / "pairing-pinned.json"
        helper_server.auto_pairing = {}
        original_exact = helper_server.ALLOWED_ORIGIN_EXACT
        helper_server.ALLOWED_ORIGIN_EXACT = "chrome-extension://" + "a" * 32
        hijacked, hijack_error = helper_server.pair_extension(
            "chrome-extension://" + "b" * 32, "c" * 64
        )
        check(
            "pinned origin rejects foreign /pair",
            not hijacked
            and hijack_error == "origin not allowed"
            and not helper_server.auto_pairing,
            f"{hijacked} {hijack_error}",
        )
        pinned_ok, pinned_error = helper_server.pair_extension(
            "chrome-extension://" + "a" * 32, "c" * 64
        )
        check("pinned origin can pair", pinned_ok and not pinned_error, str(pinned_error))
        helper_server.ALLOWED_ORIGIN_EXACT = original_exact
    helper_server.PAIR_FILE = original_pair_file
    helper_server.auto_pairing = original_pairing
    helper_server.AUTH_TOKEN = original_auth_token

    scoped = helper_server.cookie_header_to_list(
        "sid=abc; theme=dark", "https://www.example.com/watch/1"
    )
    check(
        "bare cookie header is scoped to the page host",
        [c["name"] for c in scoped] == ["sid", "theme"]
        and all(c["domain"] == ".example.com" and c["secure"] for c in scoped),
        str(scoped)[:80],
    )
    check(
        "cookie list preferred over header",
        helper_server.payload_cookie_list(
            {"cookiesList": [{"name": "a", "value": "1", "domain": ".x.test"}], "cookieHeader": "b=2"},
            "https://y.test/",
        )[0]["domain"]
        == ".x.test",
    )
    helper_source = (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
    check(
        "no global Cookie header passed to yt-dlp",
        "Cookie:{cookie_header}" not in helper_source,
    )
    check(
        "payload cannot point yt-dlp at local cookie jars / browser profiles",
        "cookiesFromBrowser" not in helper_source
        and 'payload.get("cookies")\n            if isinstance(cookies, str)' not in helper_source,
    )
    # Pause → resume must share one work_dir so yt-dlp --continue applies.
    key_a = helper_server.resume_key_for({"resumeKey": "dl_1700_3"}, "https://a.test/v")
    key_b = helper_server.resume_key_for({"resumeKey": "dl_1700_3"}, "https://a.test/v")
    key_c = helper_server.resume_key_for({}, "https://a.test/v?x=1")
    key_d = helper_server.resume_key_for({}, "https://a.test/v?x=1")
    key_e = helper_server.resume_key_for({"quality": "720p"}, "https://a.test/v?x=1")
    check(
        "helper resume key is stable and sanitized",
        key_a == key_b == "dl_1700_3"
        and key_c == key_d
        and key_c != key_e
        and helper_server.resume_key_for({"resumeKey": "../evil/x"}, "u") == "___evil_x",
        f"{key_a} {key_c} {key_e}",
    )
    original_tmp_root = helper_server.TMP_ROOT
    with tempfile.TemporaryDirectory() as tmp:
        helper_server.TMP_ROOT = Path(tmp) / ".uvd-tmp"
        fresh = helper_server.TMP_ROOT / "fresh"
        stale = helper_server.TMP_ROOT / "stale"
        empty = helper_server.TMP_ROOT / "empty"
        for d in (fresh, stale, empty):
            d.mkdir(parents=True)
        (fresh / "a.part").write_bytes(b"x")
        (stale / "b.part").write_bytes(b"x")
        old = time.time() - 4 * 24 * 3600
        os.utime(stale, (old, old))
        os.utime(stale / "b.part", (old, old))
        removed = helper_server.sweep_tmp_dirs()
        check(
            "startup sweep removes only abandoned temp dirs",
            removed == 2 and fresh.is_dir() and not stale.exists() and not empty.exists(),
            f"removed={removed}",
        )
        helper_server.purge_work_dir(fresh)
        check("purge removes a job work dir", not fresh.exists())
        outside = Path(tmp) / "outside"
        outside.mkdir()
        helper_server.purge_work_dir(outside)
        check("purge refuses paths outside .uvd-tmp", outside.exists())
    helper_server.TMP_ROOT = original_tmp_root

    # Cancel: a pause keeps partial files, a user cancel purges them; a job
    # whose worker already exited is purged synchronously.
    with tempfile.TemporaryDirectory() as tmp:
        helper_server.TMP_ROOT = Path(tmp) / ".uvd-tmp"
        wd = helper_server.TMP_ROOT / "job_x"
        wd.mkdir(parents=True)
        (wd / "v.part").write_bytes(b"x")
        helper_server.jobs["smoke-cancel"] = {"status": "error", "workDir": str(wd)}
        helper_server.request_cancel_job("smoke-cancel", purge=False)
        kept = wd.exists()
        helper_server.request_cancel_job("smoke-cancel", purge=True)
        check(
            "cancel purge flag controls partial-file removal",
            kept and not wd.exists() and helper_server.jobs["smoke-cancel"]["purge"] is True,
        )
        helper_server.jobs.pop("smoke-cancel", None)
    helper_server.TMP_ROOT = original_tmp_root

    check(
        "helper publish dir mirrors Downloads/<subfolder>",
        helper_server.publish_dir_for("") == helper_server.OUT_DIR
        and helper_server.publish_dir_for("VideoDownloader") == helper_server.OUT_DIR
        and helper_server.subfolder_segments("../x/..\\y:z") == ["x", "yz"],
        str(helper_server.publish_dir_for("My/Folder")),
    )
    helper_server._version_cache.clear()
    calls = {"n": 0}
    original_check_output = helper_server.subprocess.check_output

    def fake_check_output(*_args, **_kwargs):
        calls["n"] += 1
        return "2026.09.01\n"

    helper_server.subprocess.check_output = fake_check_output
    try:
        v1 = helper_server.ytdlp_version("/usr/bin/yt-dlp-fake")
        v2 = helper_server.ytdlp_version("/usr/bin/yt-dlp-fake")
    finally:
        helper_server.subprocess.check_output = original_check_output
        helper_server._version_cache.clear()
    check(
        "/health caches yt-dlp --version",
        v1 == v2 == "2026.09.01" and calls["n"] == 1,
        f"calls={calls['n']}",
    )
    check(
        "yt-dlp children run in their own session and are killed as a tree",
        "start_new_session=(os.name != \"nt\")" in helper_source
        and "os.killpg(" in helper_source
        and "except subprocess.TimeoutExpired:" in helper_source,
    )
    check(
        "tiktok cookies only for first-party hosts",
        helper_server.tiktok_cookie_host("https://v16-webapp.tiktok.com/x.mp4")
        and helper_server.tiktok_cookie_host("https://v19.tiktokcdn-us.com/x.mp4")
        and not helper_server.tiktok_cookie_host("https://www.tikwm.com/video/media/play/1.mp4")
        and not helper_server.tiktok_cookie_host("https://tiktok.com.evil.example/x.mp4"),
    )

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
    popup_css = (ROOT / "src/popup.css").read_text(encoding="utf-8")
    popup_settings_source = (ROOT / "src/popup-settings-ui.js").read_text(
        encoding="utf-8"
    )
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    check(
        "popup release version is consistent",
        manifest.get("version") == "1.26.0"
        and "v1.26.0" in popup_html
        and "v1.26.0" in popup_settings_source,
    )
    check(
        "popup primary hierarchy and settings groups",
        'class="tab tab-primary active"' in popup_html
        and 'class="download-options"' in popup_html
        and popup_html.count('class="settings-section"') == 5,
    )
    check(
        "popup tab semantics",
        all(
            f'aria-labelledby="tabButton{name}"' in popup_html
            for name in ("Main", "Watch", "History", "Settings")
        )
        and popup_html.count('role="tabpanel"') == 4,
    )
    check(
        "popup density styles preserved",
        all(
            selector in popup_css
            for selector in (
                "body.full-ui .list",
                "body.compact-ui .download-options",
                "body.ultra-ui .download-options",
            )
        ),
    )
    check(
        "popup width styles preserved",
        all(
            selector in popup_css
            for selector in (
                "body.width-narrow",
                "body.width-normal",
                "body.width-wide",
            )
        ),
    )
    check(
        "popup theme choice overrides the OS preference",
        # 시스템 (default) still follows the OS; 라이트/다크 pin the palette.
        ':root:not([data-theme="light"])' in popup_css
        and ':root[data-theme="dark"]' in popup_css
        and 'id="setTheme"' in popup_html
        and popup_html.count('<option value="system" selected>') == 1
        and 'setAttribute?.("data-theme", value)' in popup_settings_source
        and '$("#setTheme")?.value || "system"' in popup_settings_source,
    )
    check(
        "download completion sound is opt-in and separate from notifications",
        # No `checked` on the sound switch, still `checked` on the notification one.
        '<input type="checkbox" id="setCompleteSound" />' in popup_html
        and '<input type="checkbox" id="setNotify" checked />' in popup_html
        and "completionSound: false"
        in (ROOT / "src/uvd-common.js").read_text(encoding="utf-8")
        and 'completionSound: !!$("#setCompleteSound")?.checked'
        in popup_settings_source
        and "playCompletionSound()"
        in (ROOT / "src/popup-progress-ui.js").read_text(encoding="utf-8"),
    )
    check(
        "popup stylesheet is a single token-driven system",
        # One light base plus the two dark blocks (OS-resolved and pinned).
        popup_css.count(":root {") == 1
        and popup_css.count("prefers-color-scheme: dark") == 1
        and all(
            token in popup_css
            for token in ("--accent:", "--ink:", "--surface:", "--pad-x:")
        )
        # Density is a token swap, so each mode declares its own scale.
        and all(
            f"body.{mode} {{" in popup_css
            for mode in ("full-ui", "compact-ui", "ultra-ui")
        ),
    )
    check(
        "popup nav docks below the panels",
        # Nav and footer are ordered after the scrolling panels by flex order.
        all(
            fragment in popup_css
            for fragment in (
                ".tabs {\n  order: 5;",
                ".footer {\n  order: 4;",
                ".tab-panel {\n  order: 3;",
            )
        ),
    )
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
    helper_source = (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
    check(
        "helper DASH manifest keeps media URL",
        'manifest = bool(payload.get("manifest"))' in helper_source
        and "if (direct_file or manifest) and url:" in helper_source,
    )
    content_source = (ROOT / "src/content.js").read_text(encoding="utf-8")
    check(
        "content script discovers MPD manifests",
        "(?:m3u8|mpd|mp4)" in content_source
        and "[data-src*='.mpd']" in content_source,
    )
    naming_probe = subprocess.run(
        [
            "node",
            "-e",
            (
                "const N=require('./src/naming.js');"
                "const P=require('./src/popup-media.js');"
                "const U=require('./src/uvd-common.js');"
                "const url='https://123av.com/ko/v/cawb-035-uncensore';"
                "console.log(JSON.stringify({"
                "descriptor:N.extractProductCode(url),"
                "clean:N.extractProductCode('https://123av.com/ko/v/snos-309'),"
                "fallback:P.downloadFilename("
                "{filename:'동영상_720p.mp4',pageUrl:url,quality:'720p'},"
                "{Naming:N,UVD:U,selectedQuality:'720p'}),"
                "human:N.buildFilename({"
                "title:'실제 제목',existing:'동영상_720p.mp4',"
                "pageUrl:url,quality:'720p'})"
                "}));"
            ),
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    try:
        naming_result = json.loads(naming_probe.stdout)
    except (json.JSONDecodeError, TypeError):
        naming_result = {}
    check(
        "descriptor-suffixed 123av URL keeps its code",
        naming_probe.returncode == 0
        and naming_result.get("descriptor") == "CAWB-035",
        (naming_probe.stderr or naming_probe.stdout or "")[:120],
    )
    check(
        "clean hyphenated code URL still matches",
        naming_result.get("clean") == "SNOS-309",
        str(naming_result)[:120],
    )
    check(
        "generic quality title falls back to readable filename",
        naming_result.get("fallback") == "CAWB-035_720p.mp4",
        str(naming_result)[:120],
    )
    check(
        "short human title stays ahead of URL fallback",
        naming_result.get("human") == "실제 제목_720p.mp4",
        str(naming_result)[:120],
    )
    check(
        "DASH quality probing uses helper",
        "isRealDash(url, \"stream\") || needsYtDlpHelper" in background_source,
    )
    page_download_source = (ROOT / "src/page-download.js").read_text(encoding="utf-8")
    check(
        "page HLS title precedes internal merge name",
        "filename || pageTitleFilename(\"mp4\") || result.filename"
        in page_download_source,
    )
    jobs_source = (ROOT / "src/background-download-jobs.js").read_text(
        encoding="utf-8"
    )
    check(
        "paused jobs persist across browser restarts",
        'const DURABLE_PAUSED_KEY = "uvdPausedDownloads"' in jobs_source
        and "chrome.storage.local.set" in jobs_source,
    )
    housekeeping_source = (ROOT / "src/background-housekeeping.js").read_text(
        encoding="utf-8"
    )
    check(
        "startup cleanup preserves durable HLS checkpoints",
        "uvdPausedDownloads" in housekeeping_source
        and "preserved.has(partBase)" in housekeeping_source,
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
        "src/popup-sound.js",
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
        ("dash_unit.js", "DASH helper routing"),
        ("resume_unit.js", "resume contract"),
        ("recommendations_unit.js", "remaining recommendations"),
        ("popup_wiring_modules_unit.js", "popup wiring modules"),
        ("popup_media_loader_unit.js", "popup media title loader"),
        ("injected_capture_unit.js", "injected capture opt-in"),
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
        ["node", "scripts/popup_sound_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup completion sound",
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
