"""Meter modes (Chaos / Therapy / Hope) with palettes and routing from filenames."""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from enum import Enum
from typing import Tuple


class MeterKind(str, Enum):
    CHAOS = "chaos"
    THERAPY = "therapy"
    HOPE = "hope"


@dataclass(frozen=True)
class MeterTheme:
    """Visual + copy for one Lab meter."""

    kind: MeterKind
    bar_primary: str  # ffmpeg drawbox color name or 0xRRGGBB
    bar_glow: str
    accent_text: str
    hook_template: str
    engine_tag_suffix: str  # e.g. ChaosEngine_v2.1


_THEMES: dict[MeterKind, MeterTheme] = {
    MeterKind.CHAOS: MeterTheme(
        kind=MeterKind.CHAOS,
        bar_primary="0xff4422",
        bar_glow="0xff8844",
        accent_text="0xffeedd",
        hook_template="Wait for the Chaos Level…",
        engine_tag_suffix="ChaosEngine_v2.1",
    ),
    MeterKind.THERAPY: MeterTheme(
        kind=MeterKind.THERAPY,
        bar_primary="0x2288aa",
        bar_glow="0x44ccdd",
        accent_text="0xeeffff",
        hook_template="Feel the Therapy Rise…",
        engine_tag_suffix="TherapyEngine_v2.1",
    ),
    MeterKind.HOPE: MeterTheme(
        kind=MeterKind.HOPE,
        bar_primary="0xe6b422",
        bar_glow="0xffee88",
        accent_text="0x1a1408",
        hook_template="Hope Meter Loading…",
        engine_tag_suffix="HopeEngine_v2.1",
    ),
}


def theme_for(kind: MeterKind) -> MeterTheme:
    return _THEMES[kind]


def detect_meter_from_filename(name: str) -> MeterKind:
    lower = name.lower()
    if re.search(r"(^|[^a-z])chaos([^a-z]|$)|chaos_", lower):
        return MeterKind.CHAOS
    if re.search(r"(^|[^a-z])(therapy|terapi)([^a-z]|$)|therapy_|terapi_", lower):
        return MeterKind.THERAPY
    if re.search(r"(^|[^a-z])(hope|umut)([^a-z]|$)|hope_|umut_", lower):
        return MeterKind.HOPE
    return random.choice([MeterKind.CHAOS, MeterKind.THERAPY, MeterKind.HOPE])


def sample_meter_range(rng: random.Random) -> Tuple[int, int]:
    """random_start_percent in [10,30], target_percent in [85,100]."""
    start = rng.randint(10, 30)
    target = rng.randint(85, 100)
    if target <= start:
        target = min(100, start + rng.randint(55, 75))
    return start, target


def sample_speed_factor(rng: random.Random) -> float:
    """Global speed-up factor in [1.05, 1.10]."""
    return round(rng.uniform(1.05, 1.10), 4)


def sample_micro_zoom(rng: random.Random) -> float:
    """1–2% center zoom (crop)."""
    return round(rng.uniform(1.01, 1.02), 5)


class MeterEngine:
    """
    Flexible meter configuration: palette, sampled ranges, and theme metadata
    for downstream FFmpeg / metadata injection.
    """

    def __init__(self, kind: MeterKind, rng: random.Random | None = None):
        self._rng = rng or random.Random()
        self.kind = kind
        self.theme = theme_for(kind)
        self.random_start_percent, self.target_percent = sample_meter_range(self._rng)
        self.speed_factor = sample_speed_factor(self._rng)
        self.micro_zoom = sample_micro_zoom(self._rng)

    @property
    def hook_line(self) -> str:
        return self.theme.hook_template
