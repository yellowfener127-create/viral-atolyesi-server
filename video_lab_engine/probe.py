"""ffprobe helpers."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any


def probe_duration_sec(ffprobe_exe: str, video_path: Path) -> float:
    p = subprocess.run(
        [
            ffprobe_exe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip() or "ffprobe failed")
    try:
        return max(0.01, float((p.stdout or "").strip()))
    except ValueError as e:
        raise RuntimeError(f"Bad duration output: {p.stdout!r}") from e


def probe_streams(ffprobe_exe: str, video_path: Path) -> dict[str, Any]:
    p = subprocess.run(
        [
            ffprobe_exe,
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip() or "ffprobe failed")
    return json.loads(p.stdout or "{}")


def has_audio_stream(ffprobe_exe: str, video_path: Path) -> bool:
    data = probe_streams(ffprobe_exe, video_path)
    for s in data.get("streams") or []:
        if (s.get("codec_type") or "").lower() == "audio":
            return True
    return False


def ffmpeg_has_filter(ffmpeg_exe: str, filter_name: str) -> bool:
    p = subprocess.run(
        [ffmpeg_exe, "-hide_banner", "-filters"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    blob = (p.stdout or "") + (p.stderr or "")
    return filter_name in blob
