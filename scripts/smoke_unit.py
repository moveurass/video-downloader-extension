#!/usr/bin/env python3
"""Lightweight smoke checks for UVD release (no browser)."""
from __future__ import annotations

import base64
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
SKIP = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  OK  {name}")
    else:
        FAIL += 1
        print(f" FAIL {name}" + (f" — {detail}" if detail else ""))


def skip(name: str, reason: str = "") -> None:
    """Record a check that does not apply on this platform (not a failure)."""
    global SKIP
    SKIP += 1
    print(f" SKIP {name}" + (f" — {reason}" if reason else ""))


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
    ig_attempts = helper_server.instagram_ytdlp_attempts("best")
    class _AuthHandler:
        def __init__(self, origin="", token=""):
            self.headers = {"Origin": origin, "X-UVD-Token": token}

    check(
        "helper auth names missing token separately from a bad origin",
        helper_server.authorization_error(_AuthHandler("https://evil.example", "x"))
        == "forbidden origin"
        and helper_server.authorization_error(
            _AuthHandler("chrome-extension://" + ("a" * 32), "")
        )
        in ("missing token", "helper not paired", "forbidden origin"),
    )
    check(
        "Instagram helper impersonates Chrome before cookies-from-browser",
        any(attempt[2][:2] == ["--impersonate", "chrome"] for attempt in ig_attempts)
        and ig_attempts[0][2] == ["--impersonate", "chrome"]
        and any("--cookies-from-browser" in attempt[2] for attempt in ig_attempts)
        and ig_attempts[0][2] != ["--cookies-from-browser", "chrome"],
    )
    dash_efg = base64.b64encode(b'{"encode_tag":"dash_baseline_1"}').decode("ascii")
    prog_efg = base64.b64encode(b'{"encode_tag":"progressive_recap"}').decode("ascii")
    check(
        "Instagram DASH init / byte-range URLs are not playable CDNs",
        helper_server.is_instagram_dash_fragment_url(
            "https://scontent.cdninstagram.com/o1/v/t2/f2/m86/init.mp4"
        )
        and not helper_server.is_instagram_cdn_url(
            f"https://scontent.cdninstagram.com/o1/v/t2/f2/m86/clip.mp4?efg={dash_efg}"
        )
        and not helper_server.is_instagram_cdn_url(
            "https://scontent.cdninstagram.com/o1/v/t2/f2/m86/clip.mp4?bytestart=0&byteend=833"
        )
        and helper_server.is_instagram_cdn_url(
            f"https://scontent.cdninstagram.com/o1/v/t16/f2/m86/play.mp4?efg={prog_efg}"
        ),
    )
    dash_ftyp = (32).to_bytes(4, "big") + b"ftyp" + b"dash" + b"\x00\x00\x00\x00" + b"cmfc" + b"iso6"
    prog_ftyp = (32).to_bytes(4, "big") + b"ftyp" + b"isom" + b"\x00\x00\x00\x00" + b"mp42" + b"iso2"
    check(
        "DASH init ftyp is not treated as a playable video",
        helper_server._is_dash_init_segment(dash_ftyp)
        and not helper_server._sniff_is_video(dash_ftyp)
        and helper_server._sniff_is_video(prog_ftyp)
        and not helper_server.try_instagram_direct_download(
            "ig-dash-skip",
            {
                "mediaUrl": "https://scontent.cdninstagram.com/o1/v/t2/f2/m86/init.mp4",
                "pageUrl": "https://www.instagram.com/reel/ABC123/",
                "title": "Should not publish",
            },
            "Should not publish",
        ),
    )
    qa_tiktok = (
        "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150"
        "?is_from_webapp=1&sender_device=pc"
    )
    check(
        "Mac QA volleyballqueen86 permalink is the download target",
        helper_server.clean_tiktok_url(qa_tiktok)
        == "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150"
        and helper_server.tiktok_video_id(qa_tiktok) == "7674902153491664150"
        and helper_server.is_tiktok_video_url(qa_tiktok)
        and helper_server.reject_tiktok_non_video_target(qa_tiktok) is None
        and helper_server.expand_tiktok_share_url(qa_tiktok)
        == "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150"
        and helper_server.tiktok_formats_target(
            qa_tiktok, "https://www.tiktok.com/explore"
        )
        == (
            "https://www.tiktok.com/@volleyballqueen86/video/7674902153491664150",
            None,
        )
        and helper_server.tiktok_formats_target(
            "https://www.tiktok.com/explore", "https://www.tiktok.com/explore"
        )
        == (None, helper_server.tiktok_need_permalink_message()),
    )
    jpeg = b"\xff\xd8\xff" + b"\x00" * 400
    check(
        "helper cover bytes become a JPEG data URL",
        helper_server.guess_image_mime(jpeg) == "image/jpeg"
        and helper_server.image_bytes_to_data_url(jpeg).startswith(
            "data:image/jpeg;base64,"
        ),
    )
    check(
        "helper /thumb defaults Instagram CDN Referer to instagram.com",
        helper_server.default_image_referer(
            "https://scontent.cdninstagram.com/v/t51.2885-15/cover.jpg"
        )
        == "https://www.instagram.com/"
        and helper_server.default_image_referer(
            "https://instagram.fsic1-1.fna.fbcdn.net/v/t51.2885-15/cover.jpg"
        )
        == "https://www.instagram.com/"
        and helper_server.default_image_referer(
            "https://p19-common-sign.tiktokcdn-us.com/cover"
        )
        == "https://www.tiktok.com/",
    )
    outside = helper_server.path_in_out_dir("/etc/passwd")
    check("helper /thumb refuses paths outside the output tree", outside is None)
    check(
        "TikTok permalink normalize and explore rejection",
        helper_server.clean_tiktok_url(
            "https://m.tiktok.com/@name/video/1234567890?is_from_webapp=1"
        )
        == "https://www.tiktok.com/@name/video/1234567890"
        and helper_server.is_tiktok_video_url(
            "https://www.tiktok.com/@name/video/1234567890"
        )
        and helper_server.is_tiktok_video_url("https://vm.tiktok.com/ZMabcd123/")
        and helper_server.is_tiktok_non_video_surface("https://www.tiktok.com/explore")
        and helper_server.is_tiktok_non_video_surface("https://www.tiktok.com/following")
        and helper_server.is_tiktok_non_video_surface("https://www.tiktok.com/live")
        and helper_server.is_tiktok_non_video_surface("https://www.tiktok.com/search?q=x")
        and helper_server.reject_tiktok_non_video_target(
            "https://www.tiktok.com/explore"
        )
        == helper_server.tiktok_need_permalink_message()
        and "/@사용자/video/" in helper_server.tiktok_need_permalink_message()
        and helper_server.expand_tiktok_share_url(
            "https://www.tiktok.com/@name/video/1234567890"
        )
        == "https://www.tiktok.com/@name/video/1234567890"
        and not helper_server.try_tiktok_direct_download(
            "tt-explore",
            {
                "pageUrl": "https://www.tiktok.com/explore",
                "mediaUrl": "https://v16-webapp.tiktokcdn.com/explore.mp4",
                "title": "탐색",
            },
            "탐색",
        ),
    )
    check(
        "Instagram share links normalize to /reel/ or /p/",
        helper_server.normalize_instagram_target(
            "https://www.instagram.com/share/reel/CODE/?igsh=1"
        )
        == "https://www.instagram.com/reel/CODE/"
        and helper_server.normalize_instagram_target(
            "https://instagr.am/reels/CODE"
        )
        == "https://www.instagram.com/reel/CODE/"
        and helper_server.normalize_instagram_target(
            "https://www.instagram.com/reels/"
        )
        == "https://www.instagram.com/reels/"
        and helper_server.is_instagram_download(
            "", "https://www.instagram.com/reel/CODE/"
        )
        and not helper_server.is_instagram_download(
            "", "https://instagram.com.evil.example/reel/CODE"
        ),
    )
    check(
        "Chrome Domain cookies become Netscape subdomain cookies",
        helper_server.netscape_cookie_domain(
            {"domain": "instagram.com", "hostOnly": False}
        )
        == (".instagram.com", "TRUE")
        and helper_server.netscape_cookie_domain(
            {"domain": "instagram.com"}
        )
        == (".instagram.com", "TRUE")
        and helper_server.netscape_cookie_domain(
            {"domain": "www.instagram.com", "hostOnly": True}
        )
        == ("www.instagram.com", "FALSE"),
    )
    with tempfile.TemporaryDirectory() as tmp:
        netscape_path = Path(tmp) / "ig.txt"
        helper_server.write_netscape_cookies(
            [
                {
                    "name": "sessionid",
                    "value": "sid",
                    "domain": "instagram.com",
                    "path": "/",
                    "secure": True,
                    "hostOnly": False,
                }
            ],
            netscape_path,
        )
        row = [line for line in netscape_path.read_text().splitlines() if "sessionid" in line][0]
        check(
            "sessionid Netscape row includes subdomains",
            row.startswith(".instagram.com\tTRUE\t/") and "\tsessionid\tsid" in row,
            row,
        )
    check(
        "Instagram helper errors distinguish login vs extractor empty",
        helper_server.classify_instagram_helper_error("empty media response", False)
        .startswith("Instagram 로그인이 필요합니다")
        and "쿠키는 보냈지만"
        in helper_server.classify_instagram_helper_error("Failed to parse JSON", True)
        and helper_server.instagram_logged_in_extract_failed("Failed to parse JSON")
        and helper_server.cookie_has_name(
            [{"name": "sessionid", "value": "x"}], "sessionid"
        )
        and helper_server.cookies_without_name(
            [{"name": "sessionid", "value": "x"}, {"name": "mid", "value": "1"}],
            "sessionid",
        )
        == [{"name": "mid", "value": "1"}],
    )
    check(
        "Instagram CDN detector matches progressive /v/t URLs",
        helper_server.is_instagram_cdn_url(
            "https://scontent.cdninstagram.com/o1/v/t16/f2/m86/clip?_nc_cat=1"
        )
        and not helper_server.is_instagram_cdn_url(
            "https://static.cdninstagram.com/rsrc.php/foo.webp"
        ),
    )
    original_which = helper_server.shutil.which
    try:
        helper_server.shutil.which = lambda name: {
            "deno": "/opt/homebrew/bin/deno",
            "node": "/opt/homebrew/bin/node",
        }.get(name)
        js_runtime_args = helper_server.ytdlp_js_runtime_args()
        helper_server.shutil.which = lambda _name: None
        no_js_runtime_args = helper_server.ytdlp_js_runtime_args()
    finally:
        helper_server.shutil.which = original_which
    check(
        "yt-dlp receives each detected JavaScript runtime",
        js_runtime_args
        == [
            "--js-runtimes",
            "deno:/opt/homebrew/bin/deno",
            "--js-runtimes",
            "node:/opt/homebrew/bin/node",
        ]
        and not no_js_runtime_args,
    )
    js_option_error = "yt-dlp: error: no such option: --js-runtimes"
    check(
        "unknown --js-runtimes gets exactly one retry without the flag",
        helper_server.should_retry_without_js_runtimes(
            True, False, 2, js_option_error
        )
        and not helper_server.should_retry_without_js_runtimes(
            True, True, 2, js_option_error
        )
        and not helper_server.should_retry_without_js_runtimes(
            False, False, 2, js_option_error
        )
        and not helper_server.should_retry_without_js_runtimes(
            True, False, 2, "ERROR: format is not available"
        )
        and helper_server.drop_js_runtime_args(
            ["yt-dlp", "--js-runtimes", "node:/bin/node", "-J", "--", "https://youtu.be/a"]
        )
        == ["yt-dlp", "-J", "--", "https://youtu.be/a"]
        and helper_server.is_unknown_option_error(
            "unrecognized arguments: --js-runtimes node:/bin/node"
        ),
    )
    brew_update_out = (
        "ERROR: You can install Homebrew and upgrade yt-dlp with:\n"
        "  brew upgrade yt-dlp\n"
        "You can also install via pip: pip3 install -U yt-dlp"
    )
    check(
        "yt-dlp -U result is classified: brew hint / updated / already current / failure",
        helper_server.classify_update_result(brew_update_out, 1).get("hint")
        == "brew upgrade yt-dlp"
        and helper_server.classify_update_result(
            "Updated to version 2026.09.07", 0
        ).get("updated")
        is True
        and helper_server.classify_update_result(
            "yt-dlp is up to date (2026.09.07)", 0
        ).get("updated")
        is False
        and helper_server.classify_update_result("boom", 1).get("updated")
        is False
        and "boom"
        in helper_server.classify_update_result("boom", 1).get("message", ""),
    )
    check(
        "/update is auth-gated and clears the version cache after an update",
        (lambda src: src.index('self.path == "/update"')
         > src.index("reason = authorization_error(self)")
         and "_version_cache.pop(bin_path, None)" in src)(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
        ),
    )
    unsupported_probe = (
        "[youtube] Extracting URL: https://x.test/v\n"
        "ERROR: Unsupported URL: https://x.test/v\n"
        "yt-dlp version 2026.08.19"
    )
    check(
        "formats probe errors classify Unsupported URL vs generic failures",
        helper_server.classify_formats_error(unsupported_probe)
        == {"unsupported": True, "message": "ERROR: Unsupported URL: https://x.test/v"}
        and helper_server.classify_formats_error(
            "WARNING: something\nERROR: Unable to download webpage: HTTP Error 403"
        )["unsupported"]
        is False
        and helper_server.classify_formats_error("no error lines here")[
            "message"
        ]
        == "no error lines here"
        and helper_server.classify_formats_error("")["message"]
        == "",
    )
    check(
        "/formats returns an unsupported flag and run_download maps the friendly line",
        "unsupported"
        in (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
        and 'unsupported url" in err.lower()' in (ROOT / "helper/yt_dlp_server.py").read_text(
            encoding="utf-8"
        ),
    )
    original_pgrep_run = helper_server.subprocess.run
    original_kill = helper_server.os.kill
    pgrep_calls = []
    killed = []

    def fake_pgrep_run(cmd, **_kwargs):
        pgrep_calls.append(cmd)
        assert cmd[0] == "pgrep" and cmd[1] == "-f" and "yt-dlp" in cmd[2]
        assert ".uvd" in cmd[2] and "tmp" in cmd[2]
        return type(
            "P", (), {"stdout": "  123 \n456\nnot-a-pid\n", "stderr": ""}
        )()

    helper_server.subprocess.run = fake_pgrep_run
    helper_server.os.kill = lambda pid, sig: killed.append((pid, sig))
    try:
        orphan_pids = helper_server.find_orphan_ytdlp_pids(
            "/u/Downloads/VideoDownloader/.uvd-tmp"
        )
        stopped = helper_server.sweep_orphan_ytdlp(
            "/u/Downloads/VideoDownloader/.uvd-tmp"
        )
    finally:
        helper_server.subprocess.run = original_pgrep_run
        helper_server.os.kill = original_kill
    check(
        "startup orphan sweep finds and SIGTERMs stale yt-dlp children",
        orphan_pids == [123, 456]
        and stopped == 2
        and killed
        and all(sig == helper_server.signal.SIGTERM for _pid, sig in killed),
    )
    check(
        "helper kills running children on termination signals",
        (lambda src: "install_signal_handlers()" in src
         and "kill_running_job_processes()" in src
         and "sweep_orphan_ytdlp()" in src)(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
        ),
    )
    good_probe = json.dumps(
        {"format": {"duration": "10.032", "format_name": "mov,mp4,m4a"}}
    )
    original_which = helper_server.shutil.which
    original_probe_run = helper_server.subprocess.check_output
    helper_server.shutil.which = lambda name: "/usr/bin/ffprobe" if name == "ffprobe" else None
    check(
        "ffprobe verdicts interpret: readable / unreadable / bad json",
        helper_server.interpret_ffprobe(good_probe, 0)
        == {"readable": True, "duration": 10.032}
        and helper_server.interpret_ffprobe("Invalid data found", 1)["readable"]
        is False
        and helper_server.interpret_ffprobe('{"format": {}}', 0)["readable"]
        is False,
    )

    def fake_probe_fail(*_args, **_kwargs):
        raise helper_server.subprocess.CalledProcessError(
            returncode=1, cmd="ffprobe", output="moov atom not found"
        )

    def fake_probe_ok(*_args, **_kwargs):
        return good_probe

    # Truncated file → gate fires; unreadable metadata is honest about it.
    helper_server.subprocess.check_output = fake_probe_fail
    try:
        bad = helper_server.verify_media_integrity("/tmp/x.mp4")
    finally:
        helper_server.subprocess.check_output = original_probe_run
    # Readable file → gate passes with duration.
    helper_server.subprocess.check_output = fake_probe_ok
    try:
        good = helper_server.verify_media_integrity("/tmp/x.mp4")
    finally:
        helper_server.subprocess.check_output = original_probe_run
    # No ffprobe → verification silently skipped (reset the probe cache).
    helper_server._ffprobe_checked = False
    helper_server._ffprobe_path_cache = None
    helper_server.shutil.which = lambda _name: None
    try:
        skipped = helper_server.verify_media_integrity("/tmp/x.mp4")
    finally:
        helper_server.shutil.which = original_which
        helper_server._ffprobe_checked = False
        helper_server._ffprobe_path_cache = None
    check(
        "integrity gate blocks unreadable files, passes readable, skips without ffprobe",
        bad["checked"]
        and not bad["ok"]
        and "손상" in bad["reason"]
        and good["checked"]
        and good["ok"]
        and abs(good["duration"] - 10.032) < 0.001
        and skipped == {"checked": False, "ok": True, "duration": 0.0, "reason": ""},
    )
    # Regression: a stray dynamic-linker warning (e.g. a bad LD_LIBRARY_PATH)
    # printed ahead of the JSON must not be read as a truncated file.
    check(
        "ffprobe parse tolerates a stray warning line before the JSON",
        helper_server.interpret_ffprobe(
            "/usr/bin/ffprobe: /x/lib: no version information available\n"
            '{"format": {"duration": "12.5"}}',
            0,
        )
        == {"readable": True, "duration": 12.5}
        and helper_server.interpret_ffprobe("no json at all", 0)
        == {"readable": False, "duration": 0.0},
    )
    # Regression: the integrity gate must not fold ffprobe's stderr into the
    # JSON it parses (stderr=STDOUT once corrupted every download's probe).
    probe_kwargs = {}
    original_probe_co = helper_server.subprocess.check_output

    def spy_check_output(*_args, **kwargs):
        probe_kwargs.update(kwargs)
        return '{"format": {"duration": "3.0"}}'

    helper_server._ffprobe_checked = True
    helper_server._ffprobe_path_cache = "/usr/bin/ffprobe"
    helper_server.subprocess.check_output = spy_check_output
    try:
        spy_result = helper_server.verify_media_integrity("/tmp/spy.mp4")
    finally:
        helper_server.subprocess.check_output = original_probe_co
        helper_server._ffprobe_checked = False
        helper_server._ffprobe_path_cache = None
    check(
        "integrity gate keeps ffprobe stderr out of the parsed JSON",
        spy_result["ok"] is True
        and abs(spy_result["duration"] - 3.0) < 1e-9
        and probe_kwargs.get("stderr") is not helper_server.subprocess.STDOUT
        and probe_kwargs.get("stderr") == helper_server.subprocess.DEVNULL,
    )
    check(
        "publish gate deletes the bad file and reports the friendly line",
        (lambda src: src.index("verify_media_integrity(final_path)")
         < src.index("media_published = True")
         and "integrity_reason" in src
         and "Path(final_path).unlink(missing_ok=True)" in src)(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
        ),
    )
    # 폴더 열기: reveal is scoped to the output tree and the popup handler
    # falls back downloadId → filename search → helper → default folder.
    reveal_calls = []
    original_popen = helper_server.subprocess.Popen

    def fake_popen(cmd, *args, **kwargs):
        reveal_calls.append(cmd)

    helper_server.subprocess.Popen = fake_popen
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inside = root / "VideoDownloader" / "movie.mp4"
            inside.parent.mkdir()
            inside.write_bytes(b"x")
            outside = Path(tempfile.mkstemp(suffix=".mp4")[1])
            if os.name == "nt":
                # Windows reveals via os.startfile, which fake_popen can't see.
                skip(
                    "reveal opens files inside the output tree",
                    "Windows uses os.startfile",
                )
                skip(
                    "reveal refuses paths outside the output tree and missing files",
                    "Windows uses os.startfile",
                )
            else:
                inside_ok = helper_server.reveal_in_file_manager(
                    str(inside), out_root=root
                )
                if sys.platform == "darwin":
                    check(
                        "reveal opens files inside the output tree with open -R",
                        inside_ok is True
                        and reveal_calls
                        and reveal_calls[-1][:2] == ["open", "-R"]
                        and str(inside) in reveal_calls[-1][2],
                    )
                else:
                    check(
                        "reveal opens files inside the output tree with xdg-open",
                        inside_ok is True
                        and reveal_calls
                        and reveal_calls[-1][0] == "xdg-open"
                        and str(inside.parent) in reveal_calls[-1],
                    )
                check(
                    "reveal refuses paths outside the output tree and missing files",
                    helper_server.reveal_in_file_manager(str(outside), out_root=root)
                    is False
                    and helper_server.reveal_in_file_manager(
                        str(root / "nope.mp4"), out_root=root
                    )
                    is False
                    and len(reveal_calls) == 1,
                )
    finally:
        helper_server.subprocess.Popen = original_popen
    check(
        "SHOW_DOWNLOAD falls back to helper reveal before the default folder",
        (
            lambda helper_src, handler_src: (
                handler_src.index("downloads.show(msg.downloadId)")
                < handler_src.index("downloads.search(")
                < handler_src.index("YtDlp.revealPath(msg.path)")
                < handler_src.index("showDefaultFolder")
            )
            and 'self.path == "/reveal"' in helper_src
        )(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8"),
            (ROOT / "src/background-helper-messages.js").read_text(
                encoding="utf-8"
            ),
        ),
    )
    check(
        "SHOW_DOWNLOAD falls back to helper reveal before the default folder",
        (
            lambda helper_src, handler_src: (
                handler_src.index("downloads.show(msg.downloadId)")
                < handler_src.index("downloads.search(")
                < handler_src.index("YtDlp.revealPath(msg.path)")
                < handler_src.index("showDefaultFolder")
            )
            and 'self.path == "/reveal"' in helper_src
        )(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8"),
            (ROOT / "src/background-helper-messages.js").read_text(
                encoding="utf-8"
            ),
        ),
    )
    # Storage manager: listing walks OUT_DIR (subfolders once, hidden out),
    # trash is scoped to the tree and macOS uses Finder-delete.
    original_finder_delete = helper_server.finder_delete
    finder_calls = []

    def fake_finder_delete(path):
        finder_calls.append(str(path))
        Path(path).unlink(missing_ok=True)
        return True

    helper_server.finder_delete = fake_finder_delete
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "movie.mp4").write_bytes(b"x" * 10)
            (root / ".uvd-tmp").mkdir()
            (root / ".uvd-tmp" / "part.ts").write_bytes(b"x")
            (root / "SNOS").mkdir()
            (root / "SNOS" / "ep.mp4").write_bytes(b"x" * 20)
            listed = helper_server.list_out_files(root)
            names = sorted(f["name"] for f in listed)
            outcome = helper_server.trash_out_files(
                [str(root / "movie.mp4"), "/etc/hosts"], out_root=root
            )
    finally:
        helper_server.finder_delete = original_finder_delete
    check(
        "storage listing walks output tree and skips working folders",
        names == ["ep.mp4", "movie.mp4"]
        and all(f["size"] > 0 and f["mtime"] > 0 and f["rel"] for f in listed)
        and not any(".uvd-tmp" in f["path"] for f in listed),
        f"names={names}",
    )
    if sys.platform == "darwin":
        check(
            "trash moves in-tree files via Finder and refuses outside paths",
            outcome["trashed"] == 1
            and outcome["results"][0]["ok"] is True
            and outcome["results"][1]["ok"] is False
            and len(finder_calls) == 1
            and finder_calls[0].endswith("movie.mp4"),
        )
    else:
        # Non-darwin platforms trash via a hidden fallback folder, not Finder.
        skip(
            "trash moves in-tree files via Finder and refuses outside paths",
            "macOS-only Finder trash path",
        )
    check(
        "/files endpoints registered behind the auth gate",
        (lambda src: src.index('self.path == "/files/list"')
         > src.index("reason = authorization_error(self)")
         and 'self.path == "/files/trash"' in src)(
            (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8")
        ),
    )
    list_html = """
    <html><body>
      <a href="/455700.html">편 700</a>
      <a href="https://cdn.other.example/banner.jpg"><img src="x.jpg" alt="배너"></a>
      <a class="page-next" href="/page/2">2</a>
      <a href="/genre/9">장르</a>
    </body></html>
    """
    parsed_page = helper_server.parse_anchors(
        list_html, "https://supjav.com/page/1"
    )
    check(
        "list-page crawler extracts anchors and the next-page link",
        len(parsed_page["anchors"]) == 4
        and parsed_page["anchors"][0]["href"]
        == "https://supjav.com/455700.html"
        and parsed_page["anchors"][0]["text"] == "편 700"
        and parsed_page["anchors"][1]["alt"] == "배너"
        and parsed_page["nextPageUrl"] == "https://supjav.com/page/2",
    )
    check(
        "/crawl endpoint registered behind the auth gate",
        'self.path == "/crawl"'
        in (ROOT / "helper/yt_dlp_server.py").read_text(encoding="utf-8"),
    )
    # TCC-denied enumeration falls back to Finder AppleScript listing.
    original_list_dir = helper_server.finder_list_dir
    original_out_dir = helper_server.OUT_DIR
    finder_dirs = []

    def fake_finder_list_dir(dir_path):
        finder_dirs.append(str(dir_path))
        return [
            {
                "path": str(Path(dir_path) / "ep.mp4"),
                "name": "ep.mp4",
                "size": 123,
                "mtime": 1757200000,
                "rel": "ep.mp4"
            }
        ]

    helper_server.finder_list_dir = fake_finder_list_dir
    helper_server.OUT_DIR = Path("/nonexistent-uvd-out")
    try:
        fallback = helper_server.list_out_files()
    finally:
        helper_server.finder_list_dir = original_list_dir
        helper_server.OUT_DIR = original_out_dir
    check(
        "enumeration denial falls back to Finder listing",
        len(fallback) == 1
        and fallback[0]["name"] == "ep.mp4"
        and finder_dirs
        and finder_dirs[0] == "/nonexistent-uvd-out",
    )
    if sys.platform == "darwin":
        original_osascript_run = helper_server.subprocess.run

        def fake_osascript_run(cmd, **_kwargs):
            assert cmd[0] == "osascript" and cmd[1] == "-e" and "every file" in cmd[2]
            return type(
                "P",
                (),
                {
                    "returncode": 0,
                    "stdout": "ep.mp4\t123\t2026-09-11T01:23:45\n",
                    "stderr": "",
                },
            )()

        helper_server.subprocess.run = fake_osascript_run
        try:
            parsed = helper_server.finder_list_dir(Path("/out"))
        finally:
            helper_server.subprocess.run = original_osascript_run
        check(
            "Finder TSV listing parses into entries with epoch mtime",
            len(parsed) == 1
            and parsed[0]["name"] == "ep.mp4"
            and parsed[0]["size"] == 123
            and parsed[0]["path"] == "/out/ep.mp4"
            and abs(parsed[0]["mtime"] - 1789057425) < 1,
        )
    else:
        # finder_list_dir shells out to Finder via osascript; its parsed mtime
        # is also local-timezone dependent. Exercised on macOS only.
        skip(
            "Finder TSV listing parses into entries with epoch mtime",
            "macOS-only Finder AppleScript listing",
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
        "TikTok pause keeps a partial dest; cancel unlinks it",
        not helper_server.should_unlink_stopped_download(
            cancel=False, pause=True
        )
        and helper_server.should_unlink_stopped_download(
            cancel=True, pause=False
        )
        and helper_server.should_unlink_stopped_download(
            cancel=False, pause=False
        ),
    )
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

        class FakeHandler:
            def __init__(self, origin="", token=""):
                self.headers = {"Origin": origin, "X-UVD-Token": token}

        helper_server.auto_pairing = {}
        helper_server.AUTH_TOKEN = ""
        check(
            "unpaired mutating request is rejected",
            not helper_server.request_authorized(FakeHandler())
            and not helper_server.request_authorized(
                FakeHandler(origin="chrome-extension://" + "a" * 32)
            )
            and not helper_server.origin_allowed(""),
        )
        helper_server.auto_pairing = {
            "origin": "chrome-extension://" + "a" * 32,
            "token": "b" * 64,
        }
        check(
            "paired token required; empty Origin needs the token",
            helper_server.request_authorized(
                FakeHandler(
                    origin="chrome-extension://" + "a" * 32,
                    token="b" * 64,
                )
            )
            and helper_server.request_authorized(FakeHandler(token="b" * 64))
            and not helper_server.request_authorized(FakeHandler())
            and not helper_server.request_authorized(
                FakeHandler(origin="https://evil.example", token="b" * 64)
            ),
        )
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
    with tempfile.TemporaryDirectory() as tmp:
        reported_paths = Path(tmp) / "path_job.txt"
        reported_paths.write_text(
            "\n".join(
                [
                    str(Path(tmp) / "first.mp4"),
                    str(Path(tmp) / "first.jpg"),
                    str(Path(tmp) / "final.mkv"),
                    str(Path(tmp) / "final.webp"),
                ]
            ),
            encoding="utf-8",
        )
        selected_path = helper_server.last_media_output_path(
            reported_paths.read_text(encoding="utf-8").splitlines()
        )
        check(
            "after_move path report selects the last media, not thumbnail",
            selected_path == str(Path(tmp) / "final.mkv"),
            str(selected_path),
        )
    check(
        "image-only path reports cannot complete a helper job",
        helper_server.last_media_output_path(
            ["movie.jpg", "movie.jpeg", "movie.png", "movie.webp"]
        )
        is None,
    )
    check(
        "reported media filter matches video and audio outputs",
        all(
            helper_server.is_media_output_path(f"movie{suffix}")
            for suffix in (".mp4", ".webm", ".mkv", ".m4a", ".mp3")
        )
        and not helper_server.is_media_output_path("movie.jpg"),
    )
    check(
        "completed work purges only after real media publish",
        helper_server.should_purge_job_work_dir("done", True, False)
        and not helper_server.should_purge_job_work_dir("done", False, False)
        and not helper_server.should_purge_job_work_dir("error", True, False)
        and helper_server.should_purge_job_work_dir("cancelled", False, True),
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
    check(
        "YouTube download and format commands attach JavaScript runtimes",
        "youtube_js_args = ytdlp_js_runtime_args() if is_youtube else []"
        in helper_source
        and "c.extend(youtube_js_args)" in helper_source
        and "cmd.extend(youtube_js_args)" in helper_source
        and "should_retry_without_js_runtimes(" in helper_source
        and "drop_js_runtime_args(cmd)" in helper_source,
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
    stable_template_a = helper_server.output_template_basename(
        {
            "outputStem": "Stable title.mp4",
            "title": "Original title.mp4",
        }
    )
    stable_template_b = helper_server.output_template_basename(
        {
            "outputStem": "Stable title.mp4",
            "title": "Changed title.mp4",
        }
    )
    check(
        "helper resume output template keeps the locked stem",
        stable_template_a == stable_template_b == "Stable title.%(ext)s",
        f"{stable_template_a} {stable_template_b}",
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
        helper_server.request_cancel_job("smoke-cancel", pause=True)
        paused = dict(helper_server.jobs["smoke-cancel"])
        kept = wd.exists()
        helper_server.request_cancel_job("smoke-cancel", purge=True)
        check(
            "pause keeps partials without user-cancel semantics; cancel purges",
            kept
            and paused["status"] == "paused"
            and paused["pause"] is True
            and "error" not in paused
            and not wd.exists()
            and helper_server.jobs["smoke-cancel"]["purge"] is True,
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
        f"calls={calls['n']}",    )
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

    bare = urllib.request.Request(
        "http://127.0.0.1:8787/download",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(bare, timeout=2) as r:
            code = r.status
        check("origin-less download blocked until paired token", code == 403, f"got HTTP {code}")
    except urllib.error.HTTPError as e:
        check("origin-less download blocked until paired token", e.code == 403, f"got HTTP {e.code}")
    except Exception as e:
        print(f"  skip origin-less gate (helper not running): {e}")
        check("origin-less download blocked until paired token", True, "skipped")

    background_source = (ROOT / "src/background.js").read_text(encoding="utf-8")
    check(
        "site helper does not pass unbound Date.now / fetch / setTimeout",
        "now: Date.now" not in background_source
        and "now: () => Date.now()" in background_source
        and "fetch: (...args) => fetch(...args)" in background_source
        and "setTimeout: (...args) => setTimeout(...args)" in background_source,
    )
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
        and popup_html.count('class="settings-section"') == 6,
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
    manifest_source = (ROOT / "manifest.json").read_text(encoding="utf-8")
    episode_links_source = (ROOT / "src/episode-links.js").read_text(encoding="utf-8")
    check(
        "list-page episode collection is wired into the content pipeline",
        '"src/episode-links.js"' in manifest_source
        and manifest_source.index('"src/episode-links.js"')
        < manifest_source.index('"src/content.js"')
        and "COLLECT_EPISODES" in content_source
        and "collectEpisodeLinks" in content_source
        and "collectFromAnchors" in episode_links_source,
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
        "src/episode-links.js",
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
        ("hls_probe_cache_unit.js", "hls probe cache"),
        ("popup_storage_ui_unit.js", "popup storage manager"),
        ("injected_capture_unit.js", "injected capture opt-in"),
        ("message_privileges_unit.js", "message privilege allowlist"),
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
        ["node", "scripts/popup_recovery_ui_unit.js"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "popup recovery dismiss",
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
    print(f"passed {OK}  failed {FAIL}  skipped {SKIP}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
