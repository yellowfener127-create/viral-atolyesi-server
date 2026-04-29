"""Randomized fake creator metadata + device/software tags."""

from __future__ import annotations

import random
import time
from datetime import datetime, timezone


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def random_device_model(rng: random.Random) -> str:
    return rng.choice(
        [
            "iPhone 15 Pro",
            "iPhone 15 Pro Max",
            "iPhone 14 Pro",
            "iPhone 16",
            "Pixel 8 Pro",
            "SM-S928B",
        ]
    )


def build_metadata_args(rng: random.Random, software_name: str) -> list[str]:
    """
    FFmpeg -metadata key=value pairs (strip originals with -map_metadata -1 on main encode).
    """
    device = random_device_model(rng)
    uid = rng.randbytes(8).hex()
    args: list[str] = [
        "-metadata",
        f"creation_time={iso_utc_now()}",
        "-metadata",
        "handler_name=VideoHandler",
        "-metadata",
        "com.apple.quicktime.make=Apple",
        "-metadata",
        f"com.apple.quicktime.model={device}",
        "-metadata",
        f"software={software_name}",
        "-metadata",
        f"comment=uid:{uid} t={int(time.time())}",
    ]
    return args
