from __future__ import annotations

import base64
import io
from pathlib import Path

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

    # Background -> transparent by chroma-key against sampled corner colors.
    # This preserves the exact look of the arc/ticks (no HSV heuristics).
    bg_samples = [
        px[2, 2][:3],
        px[w - 3, 2][:3],
        px[2, h - 3][:3],
        px[w - 3, h - 3][:3],
    ]
    bg_thr = 52  # sum abs distance; tuned for the screenshot background gradient
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # If this pixel is close to ANY background sample, drop it.
            for br, bg, bb in bg_samples:
                if abs(r - br) + abs(g - bg) + abs(b - bb) <= bg_thr:
                    px[x, y] = (r, g, b, 0)
                    break

    d = ImageDraw.Draw(im)
    # Remove texts/number areas (user wants dynamic number elsewhere)
    # NOTE: Keep the arc; only clear the text blocks.
    d.rectangle([0, 0, w, 62], fill=(0, 0, 0, 0))  # "Upload" header
    # Clear a wider center region to remove any residual digits/labels.
    d.rectangle([18, 72, w - 18, 200], fill=(0, 0, 0, 0))

    # Remove the static needle (approx wedge on right)
    cx, cy = w // 2, int(h * 0.52)
    d.polygon([(cx, cy), (w, cy - 35), (w, cy + 25)], fill=(0, 0, 0, 0))

    # Final cleanup: remove near-background pixels again after text erases.
    px = im.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            for br, bg, bb in bg_samples:
                if abs(r - br) + abs(g - bg) + abs(b - bb) <= bg_thr:
                    px[x, y] = (r, g, b, 0)
                    break

    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    OUT.write_text(b64, encoding="utf-8")
    print("wrote", OUT, "chars", len(b64), "img", (w, h))


if __name__ == "__main__":
    main()

