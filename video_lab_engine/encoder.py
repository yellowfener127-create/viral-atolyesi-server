"""Pick NVENC / VideoToolbox / libx264 based on FFmpeg capabilities."""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class VideoEncoderChoice:
    codec: str  # e.g. h264_nvenc, h264_videotoolbox, libx264
    preset_or_quality: list[str]  # extra args after -c:v codec


_cached: str | None = None


def _ffmpeg_encoders_text(ffmpeg_exe: str) -> str:
    try:
        p = subprocess.run(
            [ffmpeg_exe, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return (p.stdout or "") + (p.stderr or "")
    except OSError:
        return ""


def pick_hw_video_encoder(ffmpeg_exe: str = "ffmpeg") -> VideoEncoderChoice:
    """
    Default: libx264 (CPU). Set VIDEO_LAB_NVENC=1 to use NVENC when listed by ffmpeg -encoders.
    On macOS, VideoToolbox is used when available (unless overridden).
    """
    global _cached
    if _cached is None:
        _cached = _ffmpeg_encoders_text(ffmpeg_exe)
    blob = _cached
    nvenc_ok = os.environ.get("VIDEO_LAB_NVENC", "").strip().lower() in ("1", "true", "yes")
    if nvenc_ok and "h264_nvenc" in blob:
        return VideoEncoderChoice("h264_nvenc", ["-preset", "p4", "-rc", "vbr", "-cq", "23"])
    if sys.platform == "darwin" and "h264_videotoolbox" in blob:
        return VideoEncoderChoice("h264_videotoolbox", ["-q:v", "65"])
    return VideoEncoderChoice("libx264", ["-preset", "faster", "-crf", "22"])
