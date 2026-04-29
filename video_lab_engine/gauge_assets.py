"""
Generate high-end semi-circular "speedometer" gauge assets (PNG with alpha).

We pre-render the static arc + dots + numbers into a single PNG to minimize
FFmpeg draw operations. Only the needle rotation + the central digital number
are dynamic in FFmpeg.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
from typing import Tuple


@dataclass(frozen=True)
class GaugePalette:
    # RGBA tuples
    arc: Tuple[int, int, int, int]
    arc_glow: Tuple[int, int, int, int]
    needle: Tuple[int, int, int, int]
    needle_tip: Tuple[int, int, int, int]
    text: Tuple[int, int, int, int]


def palette_for(kind: str) -> GaugePalette:
    k = (kind or "").lower()
    if k in ("therapy", "terapi"):
        return GaugePalette(
            arc=(90, 230, 238, 210),
            arc_glow=(110, 255, 255, 140),
            needle=(210, 255, 255, 235),
            needle_tip=(255, 255, 255, 245),
            text=(255, 255, 255, 230),
        )
    if k in ("hope", "umut"):
        return GaugePalette(
            arc=(255, 210, 80, 215),
            arc_glow=(255, 245, 210, 150),
            needle=(255, 240, 210, 235),
            needle_tip=(255, 255, 255, 245),
            text=(255, 255, 255, 230),
        )
    # chaos default
    return GaugePalette(
        arc=(255, 120, 60, 220),
        arc_glow=(255, 210, 140, 145),
        needle=(255, 210, 180, 235),
        needle_tip=(255, 255, 255, 245),
        text=(255, 255, 255, 230),
    )


def _try_import_pil():
    try:
        from PIL import Image, ImageDraw, ImageFilter, ImageFont  # type: ignore

        return Image, ImageDraw, ImageFilter, ImageFont
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "Pillow is required for speedometer gauge assets. "
            "Install with: pip install -r requirements-video-lab.txt"
        ) from e


def _load_font(ImageFont, font_abs: str | None, size: int):
    if font_abs:
        try:
            return ImageFont.truetype(font_abs, size=size)
        except Exception:
            pass
    # Fallback: PIL default bitmap font (less pretty but safe)
    return ImageFont.load_default()


def render_speedometer_assets(
    out_dir: Path,
    *,
    kind: str,
    size: int = 780,
    margin_bottom: int = 26,
    font_abs: str | None = None,
) -> dict[str, str]:
    """
    Create:
      - gauge_base.png : arc + dots + numbers
      - gauge_glow.png : blurred glow-only layer (arc + dots)
      - needle.png     : needle + hub, centered pivot at image center

    Returns dict of relative paths (filenames) to use from FFmpeg cwd=out_dir.
    """
    Image, ImageDraw, ImageFilter, ImageFont = _try_import_pil()

    out_dir.mkdir(parents=True, exist_ok=True)

    pal = palette_for(kind)
    w = h = int(size)
    cx = cy = w // 2

    # Gauge geometry: semi-circle above the pivot (speedometer)
    r = int(w * 0.41)
    arc_bbox = (cx - r, cy - r, cx + r, cy + r)
    arc_width = max(10, int(w * 0.016))

    # Static base
    base = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)

    # Arc (upper half)
    draw.arc(arc_bbox, start=180, end=0, fill=pal.arc, width=arc_width)

    # Dots + numbers 0..100 step 10
    font = _load_font(ImageFont, font_abs, size=max(16, int(w * 0.040)))
    dot_r = max(3, int(w * 0.007))

    for i in range(0, 101, 10):
        t = i / 100.0
        # theta: pi (left) -> 0 (right)
        theta = math.pi * (1.0 - t)
        _x = int(cx + (r) * math.cos(theta))
        _y = int(cy - (r) * math.sin(theta))

        # dot slightly inside the arc
        xd = int(cx + (r - arc_width * 0.8) * math.cos(theta))
        yd = int(cy - (r - arc_width * 0.8) * math.sin(theta))
        draw.ellipse((xd - dot_r, yd - dot_r, xd + dot_r, yd + dot_r), fill=(255, 255, 255, 210))

        # number further inside
        xn = int(cx + (r - arc_width * 3.0) * math.cos(theta))
        yn = int(cy - (r - arc_width * 3.0) * math.sin(theta))
        label = str(i)
        tw, th = draw.textbbox((0, 0), label, font=font)[2:]
        draw.text((xn - tw / 2, yn - th / 2), label, font=font, fill=pal.text)

    base_path = out_dir / "gauge_base.png"
    base.save(base_path)

    # Glow-only layer: arc + dots, blurred
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.arc(arc_bbox, start=180, end=0, fill=pal.arc_glow, width=max(arc_width + 4, int(arc_width * 1.5)))
    for i in range(0, 101, 10):
        t = i / 100.0
        theta = math.pi * (1.0 - t)
        xd = int(cx + (r - arc_width * 0.8) * math.cos(theta))
        yd = int(cy - (r - arc_width * 0.8) * math.sin(theta))
        gd.ellipse((xd - dot_r, yd - dot_r, xd + dot_r, yd + dot_r), fill=pal.arc_glow)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(3, int(w * 0.010))))
    glow_path = out_dir / "gauge_glow.png"
    glow.save(glow_path)

    # Needle layer: draw a needle originating from pivot to arc
    needle = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    nd = ImageDraw.Draw(needle)
    needle_len = int(r * 0.92)
    needle_w = max(4, int(w * 0.010))
    # default points straight up (0 deg), rotate in FFmpeg
    x0, y0 = cx, cy
    x1, y1 = cx, cy - needle_len
    nd.line((x0, y0, x1, y1), fill=pal.needle, width=needle_w, joint="curve")
    # tip
    tip_r = max(4, int(w * 0.010))
    nd.ellipse((x1 - tip_r, y1 - tip_r, x1 + tip_r, y1 + tip_r), fill=pal.needle_tip)
    # hub
    hub_r = max(10, int(w * 0.022))
    nd.ellipse((cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r), fill=(15, 15, 20, 220))
    nd.ellipse((cx - int(hub_r * 0.55), cy - int(hub_r * 0.55), cx + int(hub_r * 0.55), cy + int(hub_r * 0.55)), fill=pal.needle_tip)
    needle_path = out_dir / "needle.png"
    needle.save(needle_path)

    return {
        "base": "gauge_base.png",
        "glow": "gauge_glow.png",
        "needle": "needle.png",
    }

