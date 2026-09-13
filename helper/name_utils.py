"""Pure filename helpers shared by the local helper and tests."""
from __future__ import annotations

import re
from pathlib import Path


MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".m4a", ".mp3", ".aac"}
CODE_STOP_WORDS = {
    "top", "best", "the", "episode", "ep", "part", "vol", "volume", "season",
    "chapter", "lesson", "day", "week", "month", "year", "page", "post", "item",
    "video", "clip", "photo", "image", "news", "article", "id", "no", "number",
    "iphone", "galaxy", "windows", "android", "ios", "mac", "pixel", "model",
    "version", "release", "update", "test", "demo", "sample", "track", "series",
    "set", "pack", "rank", "ranking", "new", "full", "hd", "sd", "fhd", "uhd",
    "watch", "play", "player", "embed", "channel", "short", "trailer", "review",
    "guide", "tutorial", "download", "source", "chunk", "segment", "manifest",
}


def is_instagram_identity_title(raw: str) -> bool:
    """Uploader-only Instagram names that should not lock a download filename."""
    stem = Path(str(raw or "").replace("\\", "/")).stem.strip()
    if not stem:
        return True
    if is_generic_name(stem):
        return True
    if re.fullmatch(r"@[\w.]{1,30}", stem):
        return True
    if re.fullmatch(r".+\s*\(@[\w.]{1,30}\)", stem):
        return True
    if re.fullmatch(r"(?:video|reel|reels|post)\s+by\s+@?[\w.]+", stem, flags=re.I):
        return True
    return bool(re.fullmatch(r"instagram[_-][A-Za-z0-9_-]+", stem, flags=re.I))


def first_meaningful_instagram_caption(raw: str) -> str:
    """First usable caption line, skipping identity / auto-alt text."""
    text = str(raw or "").replace("\r", "\n").replace("\\n", "\n").strip()
    quoted = re.search(r'\bon\s+instagram:\s*[“"\'](.+?)[”"\']\s*$', text, flags=re.I)
    if quoted:
        text = quoted.group(1).strip()
    else:
        dated = re.search(r':\s*[“"\'](.+?)[”"\']\s*$', text)
        if dated and re.search(r"likes?|comments?", text, flags=re.I):
            text = dated.group(1).strip()
    for line in text.split("\n"):
        line = line.strip().strip('"“”')
        if not line:
            continue
        if is_instagram_identity_title(line):
            continue
        if re.match(r"^(?:photo|video|image)\s+by\s+", line, flags=re.I):
            continue
        if re.match(r"^may be (?:an image|a video|a cartoon)", line, flags=re.I):
            continue
        if re.fullmatch(r"(?:[#@][\w.]+(?:\s+[#@][\w.]+)*)", line) and len(line) < 24:
            continue
        return line
    return ""


def instagram_author_handle(url: str) -> str:
    match = re.search(
        r"(?:instagram\.com|instagr\.am)/([A-Za-z0-9._]{1,30})/(?:reel|reels|p|tv)/",
        url or "",
        flags=re.I,
    )
    if not match:
        return ""
    handle = match.group(1)
    if handle.lower() in {"share", "p", "reel", "reels", "tv", "stories", "explore", "accounts"}:
        return ""
    return f"@{handle}"


def instagram_readable_title(
    title: str = "",
    description: str = "",
    caption: str = "",
    page_url: str = "",
    display_id: str = "",
) -> str:
    """Prefer a real caption over Video-by / Name(@handle) / Instagram_<id>."""
    for candidate in (caption, description, title):
        line = first_meaningful_instagram_caption(candidate)
        if line and not is_instagram_identity_title(line):
            return clean_name(line)
    handle = instagram_author_handle(page_url)
    if handle:
        return clean_name(handle)
    if display_id and not is_generic_name(display_id):
        return ""
    return ""


def is_generic_name(raw: str) -> bool:
    """Whether a supplied name is an ID/placeholder rather than a video title."""
    stem = Path(str(raw or "").replace("\\", "/")).stem.strip()
    return bool(
        not stem
        or re.fullmatch(
            r"(?:video|media|download|file|untitled|영상|동영상|"
            r"(?:youtube|youtu(?:be)?|tiktok|instagram|facebook|bilibili|"
            r"vimeo|dailymotion|twitch|naver|twitter|x)"
            r"(?:[_-][A-Za-z0-9_-]+|\s*(?:영상|video))?)",
            stem,
            flags=re.I,
        )
        or re.fullmatch(
            r"(?:chunk|segment|seg|init|index|master|manifest|stream|"
            r"source|src|host|cdn|asset)[_-]?[A-Za-z0-9_-]*",
            stem,
            flags=re.I,
        )
        or bool(re.fullmatch(r"[0-9a-f]{16,}", stem, flags=re.I))
        or bool(
            re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                r"[0-9a-f]{4}-[0-9a-f]{12}",
                stem,
                flags=re.I,
            )
        )
        or (
            len(stem) == 11
            and bool(re.fullmatch(r"[A-Za-z0-9_-]+", stem))
            and not bool(re.search(r"[A-Za-z]{2,}-\d{2,}", stem))
        )
    )


def clean_name(raw: str) -> str:
    """Return a safe, readable filename stem for yt-dlp output templates."""
    name = (raw or "").strip()
    name = name.replace("\\", "/").split("/")[-1]
    for _ in range(3):
        for ext in (".mp4", ".ts", ".webm", ".mkv", ".m4a", ".mp3"):
            if name.lower().endswith(ext):
                name = name[: -len(ext)]
                break
        else:
            break
    name = re.sub(r"\s*\(\d{1,3}\)\s*$", "", name)
    name = re.sub(r"^\(\d{1,4}\)\s*", "", name)
    name = re.sub(r"^\[\d{1,4}\]\s*", "", name)
    name = re.sub(
        r"[-–—|·•:_\s]*Uncensored(?:[-–—_\s]*Leaked)?",
        " ",
        name,
        flags=re.I,
    )
    name = re.sub(
        r"[-–—|·•:_\s]*Leaked(?=[_\s\-–—.]|$|\d)", " ", name, flags=re.I
    )
    name = re.sub(
        r"[-–—|·•:_\s]*(No\s*Mosaic|Demosaic|Uncut|Raw)(?=[_\s\-–—.]|$)",
        " ",
        name,
        flags=re.I,
    )
    match = re.match(
        r"^\[?\s*([A-Za-z]{2,12})([-_ ]?)(\d{2,5})\s*\]?\s*(.*)$", name
    )
    if match:
        prefix, separator, number, rest = match.groups()
        explicit_code = (
            prefix.lower() not in CODE_STOP_WORDS
            and (
                separator in {"-", "_"}
                or (not separator and len(prefix) >= 3 and len(number) >= 3)
                or (separator == " " and prefix.isupper() and len(number) >= 3)
            )
        )
        if explicit_code:
            name = f"{prefix.upper()}-{number} {rest}".strip()
    name = re.sub(r"[\u2010-\u2015\u2212|·•]+", " ", name)
    name = re.sub(r"\s+-\s+", " ", name)
    name = re.sub(
        r"(?:(?<=[\s_-])|(?<=^))(?:best|all|unknown)$",
        "",
        name,
        flags=re.I,
    )
    name = re.sub(r"[\s_-]+(?:best|all)[\s_-]+", " ", name, flags=re.I)
    name = "".join(char if char not in '<>:"/\\|?*' else " " for char in name)
    name = " ".join(name.split()).strip(" ._-")[:72]
    if not name or len(name) < 2 or name in {".", ".."}:
        return "video"
    return name


def unique_output_path(directory: Path, filename: str) -> Path:
    """Choose a readable final path, adding a suffix only on a real collision."""
    directory = Path(directory)
    source = Path(filename)
    suffix = source.suffix.lower() if source.suffix.lower() in MEDIA_SUFFIXES else ".mp4"
    stem = clean_name(source.stem)
    candidate = directory / f"{stem}{suffix}"
    number = 2
    while candidate.exists():
        candidate = directory / f"{stem} ({number}){suffix}"
        number += 1
    return candidate
