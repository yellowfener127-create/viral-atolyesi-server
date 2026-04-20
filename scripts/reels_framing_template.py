#!/usr/bin/env python3
"""
Instagram Reels "Framing + Caption" template (Terapi / Umut).

FFmpeg: fixed 1080x1920 canvas, premium PNG "zırh" background, video overlay,
top 120px hook band (emoji-capable font), optional speed + pitch via rubberband
(fallback: atempo only).

Examples:
  python reels_framing_template.py -i clip.mp4 -o out.mp4 --account terapi \\
    --caption "POV: This moment changed everything..."

  python reels_framing_template.py -i ./incoming/ -o ./out/ --account umut \\
    --caption-file hook.txt --speed 1.08 --pitch-semitones -0.3

Folder -i: processes .mp4/.mov/.mkv/.webm in that folder.
"""

from __future__ import annotations

import argparse
import os
import random
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Iterable


CANVAS_W = 1080
CANVAS_H = 1920
TITLE_BAND_PX = 120
VIDEO_H_PX = 1800
VIDEO_Y_PX = 120
# Premium frame overlay PNG (with transparent video window)
DEFAULT_FRAME_PNG = Path("public") / "terapi_zrh_arka_plan.png"
FONT_SIZE = 44
TEXT_WRAP_CHARS = 34
DEFAULT_OLD_HOOK_END_FRAC = 0.15

ACCOUNT_BG = {
    "terapi": "0xF0F8FF",
    "umut": "0xF5F5F5",
}


def find_exe(name: str) -> str:
    exe = shutil.which(name) or shutil.which(f"{name}.exe")
    if not exe:
        sys.exit(f"{name} not found on PATH.")
    return exe


def has_audio_stream(ffprobe: str, path: Path) -> bool:
    r = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    return bool((r.stdout or "").strip())

def probe_video_size(ffprobe: str, path: Path) -> tuple[int, int] | None:
    r = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    s = (r.stdout or "").strip()
    if "x" not in s:
        return None
    try:
        w, h = s.split("x", 1)
        return int(float(w)), int(float(h))
    except Exception:
        return None

def extract_frame_png(ffmpeg: str, inp: Path, out_png: Path, t_sec: float = 0.8) -> None:
    args = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-ss",
        f"{max(0.0, float(t_sec)):.3f}",
        "-i",
        str(inp),
        "-frames:v",
        "1",
        "-vf",
        "scale=720:-2",
        "-an",
        str(out_png),
    ]
    subprocess.run(args, capture_output=True, text=True, check=False)

def detect_old_hook_end_y(frame_png: Path) -> float:
    """
    Heuristic: detect where the original burned-in top hook ends (in a single frame).
    Returns fraction of frame height (0..1). 0 means “no hook detected”.
    Works for both black-band and no-band text by looking at edge density + dark band.
    """
    try:
        from PIL import Image
        import numpy as np

        im = Image.open(frame_png).convert("RGB")
        a = np.asarray(im).astype("float32")
        h, w = a.shape[0], a.shape[1]
        if h < 64 or w < 64:
            return 0.0
        # Luma
        y = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
        # Edge density by row (abs diff)
        gx = np.abs(np.diff(y, axis=1))
        gy = np.abs(np.diff(y, axis=0))
        edge = 0.65 * gx[:, :-1] + 0.35 * gy[:-1, :]
        row_edge = edge.mean(axis=1)
        row_luma = y.mean(axis=1)

        topN = int(h * 0.38)
        topN = max(48, min(topN, h - 2))
        re = row_edge[:topN]
        rl = row_luma[:topN]

        # Detect dark band (black bar) region
        dark = rl < 55
        # Text tends to create high edges; pick rows above a percentile
        thr = float(np.percentile(re, 82))
        active = re > thr
        # Combine: either dark band with edges OR just edges (no band)
        signal = active | (dark & (re > float(np.percentile(re, 70))))
        idx = np.where(signal)[0]
        if idx.size < 6:
            return 0.0
        end = int(idx.max())
        # Pad a bit downward to fully clear descenders/shadows
        end = min(topN - 1, end + int(h * 0.012))
        return max(0.0, min(1.0, end / float(h)))
    except Exception:
        return 0.0


def default_fontfile() -> str | None:
    windir = Path(os.environ.get("WINDIR", "C:\\Windows"))
    if windir.is_dir():
        for name in (
            "seguiemj.ttf",
            "arialbd.ttf",
            "Montserrat-Bold.ttf",
            "montserrat-bold.ttf",
            "calibrib.ttf",
            "segoeuib.ttf",
        ):
            p = windir / "Fonts" / name
            if p.is_file():
                return str(p).replace("\\", "/")
    for p in (
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"),
    ):
        if p.is_file():
            return str(p).replace("\\", "/")
    return None


def escape_drawtext(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
        .replace("\n", " ")
    )

def read_emoji_pool(path: Path) -> list[str]:
    """
    Reads emojis from a pool file (like public/crush-emoji-pool.txt).
    Lines starting with # are comments. Returns unique emojis (keeps order).
    """
    fallback = ["😮", "🔥", "❤️", "✨", "👀", "🙌", "💯", "😊", "🥹", "💪", "😅", "👏", "🫶", "💫", "🤯"]
    try:
        if not path.is_file():
            return fallback
        raw = path.read_text(encoding="utf-8", errors="ignore")
        seen: set[str] = set()
        out: list[str] = []
        for line in raw.splitlines():
            ln = line.strip()
            if not ln or ln.startswith("#"):
                continue
            # Pool format: emojis are typically space-separated tokens.
            # Keep short non-ascii tokens (covers most emoji + emoji+VS16 combos).
            for tok in ln.split():
                t = tok.strip()
                if not t:
                    continue
                if any(ord(ch) > 127 for ch in t) and len(t) <= 8:
                    if t not in seen:
                        seen.add(t)
                        out.append(t)
        return out or fallback
    except Exception:
        return fallback

def strip_trailing_non_text(s: str) -> str:
    # English hooks only: trim off trailing emoji-like symbols/whitespace.
    # Keep ending punctuation if present.
    t = s.rstrip()
    while t:
        ch = t[-1]
        if ch.isspace():
            t = t.rstrip()
            continue
        if ch in ".)!?,'\"-–—":
            break
        # Remove any non-ascii tail (emoji or other symbols)
        if ord(ch) > 127:
            t = t[:-1].rstrip()
            continue
        break
    return t.strip()

def ensure_hook_ends_with_pool_emoji(hook: str, pool: Iterable[str]) -> str:
    pool_list = list(dict.fromkeys([p for p in pool if p]))
    s = str(hook or "").strip()
    if not s:
        return s
    for e in sorted(pool_list, key=len, reverse=True):
        if e and s.endswith(e):
            return s
    s = strip_trailing_non_text(s)
    if not pool_list:
        return s
    return f"{s} {random.choice(pool_list)}".strip()


def detect_transparent_window(frame_png: Path) -> tuple[int, int, int, int] | None:
    """
    Returns (x, y, w, h) bbox for the transparent “video window” inside the frame PNG.
    The frame PNG should be 1080×1920 with alpha=0 in the window area.
    """
    try:
        from PIL import Image

        im = Image.open(frame_png).convert("RGBA")
        if im.size != (CANVAS_W, CANVAS_H):
            im = im.resize((CANVAS_W, CANVAS_H), Image.LANCZOS)
        a = im.getchannel("A")
        # Mask very-transparent pixels (<=8)
        bbox = a.point(lambda x: 255 if x <= 8 else 0, mode="1").getbbox()
        if not bbox:
            return None
        x0, y0, x1, y1 = bbox
        w = max(1, x1 - x0)
        h = max(1, y1 - y0)
        if w < 200 or h < 400:
            return None
        return int(x0), int(y0), int(w), int(h)
    except Exception:
        return None

def build_filter_complex_zirh(
    frame_png: Path | None,
    account: str,
    hook_text: str,
    fontfile: str | None,
    crop_y_offset_px: int = 0,
) -> str:
    """
    White canvas -> video placed into frame "window" -> frame PNG overlaid -> hook text above window.
    Single filter_complex chain.

    Inputs:
      - if frame_png exists: [0:v] is frame (RGBA), [1:v] is video
      - else: [0:v] is video only (solid bg fallback)
    Output: [vout]
    """
    ff = f":fontfile='{fontfile}'" if fontfile else ""
    pad_x = 56
    hook_x = f"max({pad_x},min((w-text_w)/2,w-text_w-{pad_x}))"
    hook_esc = escape_drawtext(hook_text)

    if frame_png and frame_png.is_file():
        win = detect_transparent_window(frame_png)
        if win:
            wx, wy, ww, wh = win
        else:
            wx, wy, ww, wh = 113, 412, 853, 1229

        # White hook area = top region above the video window. Center text inside it.
        hook_area_top = 18
        hook_area_bottom = max(hook_area_top + 1, int(wy - 10))
        hook_y = f"({hook_area_top}+{hook_area_bottom}-text_h)/2"

        base = f"color=c=white:s={CANVAS_W}x{CANVAS_H}:d=99999[base]"
        frame = f"[0:v]scale={CANVAS_W}:{CANVAS_H},format=rgba,setsar=1[frame]"
        cy = max(0, int(crop_y_offset_px))
        vid = (
            f"[1:v]scale={ww}:{wh}:force_original_aspect_ratio=increase,"
            f"crop={ww}:{wh}:(iw-ow)/2:{cy},setsar=1[vid]"
        )
        over_vid = f"[base][vid]overlay=x={wx}:y={wy}:shortest=1[v0]"
        over_frame = f"[v0][frame]overlay=x=0:y=0:format=auto[v1]"
        text = (
            f"[v1]drawtext=text='{hook_esc}'{ff}:fontsize={FONT_SIZE}:"
            f"fontcolor=0x111111:fix_bounds=1:text_shaping=1:x='{hook_x}':y={hook_y}[vout]"
        )
        return ";".join([base, frame, vid, over_vid, over_frame, text])

    # Solid color fallback if frame PNG not found
    bg_hex = ACCOUNT_BG.get(account.lower(), ACCOUNT_BG["terapi"])
    bg = f"color=c={bg_hex}:s={CANVAS_W}x{CANVAS_H}:d=99999[bg]"
    vid = (
        f"[0:v]scale={CANVAS_W}:{VIDEO_H_PX}:force_original_aspect_ratio=decrease,"
        f"pad={CANVAS_W}:{VIDEO_H_PX}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1[vid]"
    )
    over = f"[bg][vid]overlay=x=(W-w)/2:y={VIDEO_Y_PX}:shortest=1[v0]"
    hook_y = f"({VIDEO_Y_PX}-text_h)/2"
    text = (
        f"[v0]drawtext=text='{hook_esc}'{ff}:fontsize={FONT_SIZE}:"
        f"fontcolor=0x111111:fix_bounds=1:text_shaping=1:x='{hook_x}':y={hook_y}[vout]"
    )
    return ";".join([bg, vid, over, text])


def chain_atempo(speed: float) -> str:
    """Chain atempo filters (each must be 0.5–2.0 on typical FFmpeg)."""
    parts: list[str] = []
    t = float(speed)
    if t <= 0:
        t = 1.0
    while t > 2.0 + 1e-9:
        parts.append("atempo=2.0")
        t /= 2.0
    while t < 0.5 - 1e-9:
        parts.append("atempo=0.5")
        t /= 0.5
    parts.append(f"atempo={t:.6f}".rstrip("0").rstrip("."))
    return ",".join(parts)


def run_ffmpeg(
    ffmpeg: str,
    ffprobe: str,
    inp: Path,
    outp: Path,
    account: str,
    hook_text: str,
    speed: float,
    pitch_semitones: float,
    bg_png: Path | None,
    emoji_pool_file: Path | None,
) -> None:
    fontfile = default_fontfile()
    pool = read_emoji_pool(emoji_pool_file) if emoji_pool_file else []
    hook_final = ensure_hook_ends_with_pool_emoji(
        (hook_text.strip() or "A moment worth watching - with context that matters."),
        pool,
    )
    hook_final = " ".join(hook_final.split())
    hook_final = (
        "".join(list(hook_final)[:96]).strip() if len(hook_final) > 96 else hook_final
    )

    crop_y_px = 0
    if bg_png and bg_png.is_file():
        # Determine how much to shift the crop window down to fully hide burned-in old hooks.
        sz = probe_video_size(ffprobe, inp) or (0, 0)
        with tempfile.TemporaryDirectory(prefix="va_hook_") as td:
            fp = Path(td) / "frame.png"
            extract_frame_png(ffmpeg, inp, fp, t_sec=0.8)
            frac = detect_old_hook_end_y(fp)
        # Fallback: if detection fails or returns nonsense, keep system stable.
        if not isinstance(frac, (int, float)) or not (0.0 <= float(frac) <= 0.8):
            frac = DEFAULT_OLD_HOOK_END_FRAC
        if sz[0] > 0 and sz[1] > 0 and frac > 0:
            # Compute scaled size when covering ww×wh
            win = detect_transparent_window(bg_png) or (113, 412, 853, 1229)
            ww, wh = int(win[2]), int(win[3])
            in_w, in_h = int(sz[0]), int(sz[1])
            r = max(ww / max(1, in_w), wh / max(1, in_h))
            scaled_h = in_h * r
            excess = max(0.0, scaled_h - wh)
            desired = scaled_h * frac
            crop_y_px = int(max(0.0, min(excess, desired)))
        print(f"[hook-crop] {inp.name} frac={float(frac):.3f} crop_y_offset_px={crop_y_px}")

    vfc = build_filter_complex_zirh(bg_png, account, hook_final, fontfile, crop_y_offset_px=crop_y_px)
    audio_ok = has_audio_stream(ffprobe, inp)

    if audio_ok:
        pr = 2.0 ** (float(pitch_semitones) / 12.0)
        # rubberband: pitch = scale factor, tempo = speed scale (see ffmpeg-doc rubberband)
        af_rb = f"rubberband=pitch={pr}:tempo={float(speed):.6f}"
        fc = f"{vfc};[1:a]{af_rb}[aout]" if (bg_png and bg_png.is_file()) else f"{vfc};[0:a]{af_rb}[aout]"
    else:
        fc = vfc

    cmd = [ffmpeg, "-y", "-hide_banner"]
    if bg_png and bg_png.is_file():
        cmd.extend(["-loop", "1", "-i", str(bg_png), "-i", str(inp)])
    else:
        cmd.extend(["-i", str(inp)])
    cmd.extend(["-filter_complex", fc, "-map", "[vout]"])
    if audio_ok:
        cmd.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"])
    else:
        cmd.append("-an")

    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-shortest",
            str(outp),
        ]
    )

    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode == 0:
        return

    err = (p.stderr or "") + (p.stdout or "")
    if audio_ok and "rubberband" in err.lower():
        sys.stderr.write("rubberband failed; retrying with atempo-only (no pitch shift)...\n")
        af = chain_atempo(speed)
        fc2 = f"{vfc};[1:a]{af}[aout]" if (bg_png and bg_png.is_file()) else f"{vfc};[0:a]{af}[aout]"
        cmd2 = [ffmpeg, "-y", "-hide_banner"]
        if bg_png and bg_png.is_file():
            cmd2.extend(["-loop", "1", "-i", str(bg_png), "-i", str(inp)])
        else:
            cmd2.extend(["-i", str(inp)])
        cmd2.extend(
            [
                "-filter_complex",
                fc2,
                "-map",
                "[vout]",
                "-map",
                "[aout]",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-shortest",
                str(outp),
            ]
        )
        p2 = subprocess.run(cmd2, capture_output=True, text=True)
        if p2.returncode != 0:
            sys.stderr.write(p2.stderr or p2.stdout or "")
            sys.exit(p2.returncode or 1)
        return

    sys.stderr.write(err)
    sys.exit(p.returncode or 1)


def collect_inputs(inp: Path) -> list[Path]:
    if inp.is_file():
        return [inp]
    exts = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
    return sorted([p for p in inp.iterdir() if p.suffix.lower() in exts])


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Reels framing template (Terapi Zırhı PNG + dynamic hook, FFmpeg)"
    )
    ap.add_argument("-i", "--input", required=True, help="Input video or folder of videos")
    ap.add_argument("-o", "--output", required=True, help="Output file or folder")
    ap.add_argument(
        "--account",
        choices=("terapi", "umut"),
        required=True,
        help="Terapi: Alice Blue #F0F8FF | Umut: White Smoke #F5F5F5",
    )
    ap.add_argument("--hook-text", "-t", default="", help="English hook (should end with one emoji from pool)")
    ap.add_argument("--caption", default="", help="(deprecated) alias of --hook-text")
    ap.add_argument("--caption-file", type=Path, help="UTF-8 hook file (overrides --hook-text)")
    ap.add_argument(
        "--background-png",
        type=Path,
        default=DEFAULT_FRAME_PNG,
        help="Premium zırh frame PNG (1080x1920, with transparent video window).",
    )
    ap.add_argument(
        "--emoji-pool-file",
        type=Path,
        default=Path("public") / "crush-emoji-pool.txt",
        help="Emoji pool text file used to ensure hook ends with one pool emoji.",
    )
    ap.add_argument("--speed", type=float, default=1.05, help="Playback speed (rubberband tempo)")
    ap.add_argument(
        "--pitch-semitones",
        type=float,
        default=-0.5,
        help="Pitch shift in semitones (rubberband). Ignored if rubberband unavailable.",
    )
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    hook_text = args.hook_text or args.caption or ""
    if args.caption_file:
        hook_text = args.caption_file.read_text(encoding="utf-8")

    bg_png = Path(args.background_png).resolve()
    emoji_pool_file = Path(args.emoji_pool_file).resolve()

    ffmpeg = find_exe("ffmpeg")
    ffprobe = find_exe("ffprobe")
    inputs = collect_inputs(inp)
    if not inputs:
        sys.exit(f"No video files found: {inp}")

    if inp.is_dir():
        out.mkdir(parents=True, exist_ok=True)
        for f in inputs:
            outp = out / f"framed_{args.account}_{f.stem}.mp4"
            print(f"{f.name} -> {outp.name}")
            run_ffmpeg(
                ffmpeg,
                ffprobe,
                f,
                outp,
                args.account,
                hook_text,
                args.speed,
                args.pitch_semitones,
                bg_png,
                emoji_pool_file,
            )
        print("Done.")
        return

    if out.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"):
        outp = out
    else:
        out.mkdir(parents=True, exist_ok=True)
        outp = out / f"framed_{args.account}_{inp.stem}.mp4"

    run_ffmpeg(
        ffmpeg,
        ffprobe,
        inp,
        outp,
        args.account,
        hook_text,
        args.speed,
        args.pitch_semitones,
        bg_png,
        emoji_pool_file,
    )
    print(f"Wrote {outp}")


if __name__ == "__main__":
    main()
