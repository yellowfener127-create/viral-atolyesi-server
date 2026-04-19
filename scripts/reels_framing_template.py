#!/usr/bin/env python3
"""
Instagram Reels "Framing + Caption" template (Terapi / Umut).

Uses FFmpeg: scaled-down clip on 1080x1920 canvas, account background, top hook text,
optional speed + pitch via rubberband (fallback: atempo only).

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
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path


CANVAS_W = 1080
CANVAS_H = 1920
CAPTION_BAND_TOP = 52
FONT_SIZE = 42
TEXT_WRAP_CHARS = 34
VIDEO_START_Y = 480
VIDEO_AREA_EXTRA_BIAS = 96

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


def default_fontfile() -> str | None:
    windir = Path(os.environ.get("WINDIR", "C:\\Windows"))
    for name in (
        "arialbd.ttf",
        "Montserrat-Bold.ttf",
        "montserrat-bold.ttf",
        "calibrib.ttf",
        "segoeuib.ttf",
    ):
        p = windir / "Fonts" / name
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


def build_video_filter_complex_fixed(
    bg_hex: str,
    lines: list[str],
    fontfile: str | None,
    video_fit_h: int,
    scale_ratio: float,
) -> str:
    vf_vid = (
        f"[0:v]scale={CANVAS_W}:{video_fit_h}:force_original_aspect_ratio=decrease,"
        f"setsar=1,scale=iw*{scale_ratio}:ih*{scale_ratio}[vid]"
    )
    color = f"color=c={bg_hex}:s={CANVAS_W}x{CANVAS_H}:d=99999[bg]"
    oy = f"{VIDEO_START_Y}+(H-{VIDEO_START_Y}-h)/2+{VIDEO_AREA_EXTRA_BIAS}"
    base = f"{vf_vid};{color};[bg][vid]overlay=x=(W-w)/2:y={oy}:shortest=1[vt]"
    if not lines:
        return f"{base};[vt]format=yuv420p[vout]"

    line_h = int(FONT_SIZE * 1.35)
    chain: list[str] = [base]
    cur_label = "vt"
    out_i = 0
    for i, line in enumerate(lines):
        esc = escape_drawtext(line.strip())
        if not esc:
            continue
        ff = f":fontfile='{fontfile}'" if fontfile else ""
        y = CAPTION_BAND_TOP + i * line_h
        nxt = f"vtxt{out_i}"
        chain.append(
            f"[{cur_label}]drawtext=text='{esc}'{ff}:fontsize={FONT_SIZE}:fontcolor=0x1a1a1a"
            f":x=(w-text_w)/2:y={y}[{nxt}]"
        )
        cur_label = nxt
        out_i += 1
    chain.append(f"[{cur_label}]format=yuv420p[vout]")
    return ";".join(chain)


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
    caption: str,
    speed: float,
    pitch_semitones: float,
    scale_ratio: float,
    video_fit_h: int,
) -> None:
    bg = ACCOUNT_BG.get(account.lower(), ACCOUNT_BG["terapi"])
    fontfile = default_fontfile()
    wrapped = textwrap.wrap(
        (caption.strip() or "A moment worth watching - with context that matters."),
        width=TEXT_WRAP_CHARS,
    )[:5]

    vfc = build_video_filter_complex_fixed(bg, wrapped, fontfile, video_fit_h, scale_ratio)
    audio_ok = has_audio_stream(ffprobe, inp)

    if audio_ok:
        pr = 2.0 ** (float(pitch_semitones) / 12.0)
        # rubberband: pitch = scale factor, tempo = speed scale (see ffmpeg-doc rubberband)
        af_rb = f"rubberband=pitch={pr}:tempo={float(speed):.6f}"
        fc = f"{vfc};[0:a]{af_rb}[aout]"
    else:
        fc = vfc

    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-i",
        str(inp),
        "-filter_complex",
        fc,
        "-map",
        "[vout]",
    ]
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
        fc2 = f"{vfc};[0:a]{af}[aout]"
        cmd2 = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-i",
            str(inp),
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
        description="Reels framing + caption template (Terapi / Umut, FFmpeg)"
    )
    ap.add_argument("-i", "--input", required=True, help="Input video or folder of videos")
    ap.add_argument("-o", "--output", required=True, help="Output file or folder")
    ap.add_argument(
        "--account",
        choices=("terapi", "umut"),
        required=True,
        help="Terapi: Alice Blue #F0F8FF | Umut: White Smoke #F5F5F5",
    )
    ap.add_argument("--caption", default="", help="English hook (wrapped to ~34 chars/line)")
    ap.add_argument("--caption-file", type=Path, help="UTF-8 caption file (overrides --caption)")
    ap.add_argument("--speed", type=float, default=1.05, help="Playback speed (rubberband tempo)")
    ap.add_argument(
        "--pitch-semitones",
        type=float,
        default=-0.5,
        help="Pitch shift in semitones (rubberband). Ignored if rubberband unavailable.",
    )
    ap.add_argument(
        "--scale-ratio",
        type=float,
        default=0.8,
        help="After fit-to-box, scale by this factor (0.8 ~ 20 percent smaller)",
    )
    ap.add_argument(
        "--video-fit-height",
        type=int,
        default=1350,
        help="Max height (px) to fit source before scale-ratio",
    )
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    caption = args.caption
    if args.caption_file:
        caption = args.caption_file.read_text(encoding="utf-8")

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
                caption,
                args.speed,
                args.pitch_semitones,
                args.scale_ratio,
                args.video_fit_height,
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
        caption,
        args.speed,
        args.pitch_semitones,
        args.scale_ratio,
        args.video_fit_height,
    )
    print(f"Wrote {outp}")


if __name__ == "__main__":
    main()
