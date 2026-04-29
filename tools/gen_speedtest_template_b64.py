from __future__ import annotations

import base64
import io
from pathlib import Path

import colorsys
from PIL import Image, ImageDraw


SRC = Path(
    r"C:\Users\DELL\.cursor\projects\c-Users-DELL-viral-atolyesi-server\assets"
    r"\c__Users_DELL_AppData_Roaming_Cursor_User_workspaceStorage_025855171f8bbc3d9c5628cbfbd89309_images_Ekran_g_r_nt_s__2026-04-29_174106-0e46cd84-1712-4664-b90a-505f1c82eec7.png"
)
OUT = Path(r"C:\Users\DELL\viral-atolyesi-server\_tmp_speedtest_template.b64")


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    px = im.load()

    # Background -> transparent via HSV mask:
    # Keep only "bright whites" (ticks) OR "colorful enough" pixels (arc).
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            rr, gg, bb = r / 255.0, g / 255.0, b / 255.0
            _, s, v = colorsys.rgb_to_hsv(rr, gg, bb)
            # Keep: near-white highlights OR saturated arc colors.
            keep = (v >= 0.80 and s <= 0.25) or (s >= 0.55 and v >= 0.22)
            if not keep:
                px[x, y] = (r, g, b, 0)

    d = ImageDraw.Draw(im)
    # Remove texts/number areas (user wants dynamic number elsewhere)
    d.rectangle([0, 0, w, 60], fill=(0, 0, 0, 0))  # "Upload" header
    d.rectangle([0, 92, w, 150], fill=(0, 0, 0, 0))  # big number
    d.rectangle([0, 145, w, h], fill=(0, 0, 0, 0))  # "Mbps" + any leftover bottom text

    # Remove the static needle (approx wedge on right)
    cx, cy = w // 2, int(h * 0.52)
    d.polygon([(cx, cy), (w, cy - 35), (w, cy + 25)], fill=(0, 0, 0, 0))

    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    OUT.write_text(b64, encoding="utf-8")
    print("wrote", OUT, "chars", len(b64), "img", (w, h))


if __name__ == "__main__":
    main()

