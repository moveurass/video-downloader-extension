"""Pure filename helpers shared by the local helper and tests."""
from __future__ import annotations

import re
from pathlib import Path


MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".m4a", ".mp3", ".aac"}


def is_generic_name(raw: str) -> bool:
    """Whether a supplied name is an ID/placeholder rather than a video title."""
    stem = Path(str(raw or "").replace("\\", "/")).stem.strip()
    return bool(
        not stem
        or re.fullmatch(
            r"(?:video|media|download|file|untitled|영상|동영상|"
            r"(?:youtube|tiktok|instagram|facebook|bilibili|x)[_-]?"
            r"[A-Za-z0-9_-]*)",
            stem,
            flags=re.I,
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
        r"^\[?\s*([A-Za-z]{2,12})[-_ ]?(\d{2,5})\s*\]?\s*(.*)$", name
    )
    if match:
        name = f"{match.group(1).upper()}-{match.group(2)} {match.group(3)}".strip()
    name = re.sub(r"[\u2010-\u2015\u2212|·•]+", " ", name)
    name = re.sub(r"\s+-\s+", " ", name)
    name = re.sub(r"[_\s-]*(best|all|unknown)$", "", name, flags=re.I)
    name = re.sub(r"[_\s-]*(best|all)[_\s-]*", " ", name, flags=re.I)
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
