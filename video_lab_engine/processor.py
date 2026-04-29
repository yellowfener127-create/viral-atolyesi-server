"""
FFmpeg pipeline: 9:16 blur-bg framing, micro zoom, grain/colorbalance,
animated meter bar + hook + stepped percent text, speed-up + pitch-safe audio when possible.
"""

from __future__ import annotations

import os
import random
import re
import shutil
import subprocess
from pathlib import Path

from .encoder import pick_hw_video_encoder
from .meter_modes import MeterEngine, detect_meter_from_filename
from .metadata_tags import build_metadata_args
from .probe import ffmpeg_has_filter, has_audio_stream, probe_duration_sec

OUT_W = 1080
OUT_H = 1920


def _posix_path(path: Path | str) -> str:
    """Forward slashes only."""
    return str(Path(path).resolve()).replace("\\", "/")


def _find_font_file() -> str | None:
    windir = os.environ.get("WINDIR", r"C:\Windows")
    fonts = os.path.join(windir, "Fonts")
    for name in (
        "Montserrat-Bold.ttf",
        "Montserrat ExtraBold.ttf",
        "Montserrat-SemiBold.ttf",
        "arialbd.ttf",
        "arial.ttf",
    ):
        p = os.path.join(fonts, name)
        if os.path.isfile(p):
            return _posix_path(p)
    return None


def _mirror_font_for_work_dir(work_dir: Path) -> str | None:
    """Copy system font into work_dir/fonts/lab.ttf — relative path safe for FFmpeg drawtext."""
    src = _find_font_file()
    if not src:
        return None
    fd = work_dir / "fonts"
    fd.mkdir(parents=True, exist_ok=True)
    dest = fd / "lab.ttf"
    shutil.copy2(src, dest)
    return "fonts/lab.ttf"


def _sanitize_hook(s: str) -> str:
    return (
        re.sub(r"[:'\\]", " ", s)
        .replace("%", "")
        .strip()[:180]
        or "Wait for it"
    )


def _bar_width_expr(s_pct: int, t_pct: int, dur: float) -> str:
    d = f"{dur:.6f}".rstrip("0").rstrip(".")
    return (
        "max(4\\,floor(iw*0.83*min("
        f"{t_pct}/100\\,"
        f"({s_pct}/100+({t_pct}-{s_pct})/100*min(t/{d}\\,1))"
        ")))"
    )


def _glow_width_expr(s_pct: int, t_pct: int, dur: float) -> str:
    inner = _bar_width_expr(s_pct, t_pct, dur)
    return f"min(floor(iw*0.92)\\,{inner}+14)"


def _percent_curve(s: int, t: int, steps: int, i: float) -> int:
    u = (i + 0.45) / steps
    v = min(1.0, max(0.0, u))
    p = s + (t - s) * (v**1.12)
    return int(max(s, min(t, round(p))))


def build_filter_complex(
    dur: float,
    engine: MeterEngine,
    hook_textfile_rel: str,
    font_file_rel: str | None,
    bar_glow_hex: str,
    bar_main_hex: str,
    rng: random.Random,
) -> str:
    z = engine.micro_zoom
    s_pct = engine.random_start_percent
    t_pct = engine.target_percent
    sp = engine.speed_factor

    rs = rng.uniform(-0.045, 0.045)
    gs = rng.uniform(-0.03, 0.03)
    bs = rng.uniform(-0.03, 0.03)
    grain = rng.randint(6, 13)

    wbar = _bar_width_expr(s_pct, t_pct, dur)
    wglow = _glow_width_expr(s_pct, t_pct, dur)
    bx = "floor(iw*0.085)-5"
    by_main = "ih-132"
    by_glow = "ih-137"

    font_opt = ""
    if font_file_rel:
        font_opt = f":fontfile={font_file_rel}"

    hook_seg = (
        f"drawtext=textfile={hook_textfile_rel}:reload=0{font_opt}"
        ":fontcolor=0xf0f4ff:borderw=4:bordercolor=0x101014@0.9"
        ":shadowcolor=0x4400aa@0.5:shadowx=5:shadowy=5"
        ":x=(w-text_w)/2:y=92:fontsize=54:line_spacing=8"
    )

    steps = min(16, max(8, int(dur * 2)))
    segments: list[str] = []
    cur_in = "lv5"
    for i in range(steps):
        t0 = dur * i / steps
        t1 = dur * (i + 1) / steps
        pct = _percent_curve(s_pct, t_pct, steps, float(i))
        next_out = f"pct{i}"
        enable = f"enable='between(t\\,{t0:.6f}\\,{t1:.6f})'"
        pct_esc = str(pct)
        segments.append(
            f"[{cur_in}]drawtext=text='{pct_esc}'{font_opt}"
            ":fontcolor=0xfff7f2:borderw=3:bordercolor=0x201010@0.85"
            ":shadowcolor=0xaa4400@0.45:shadowx=4:shadowy=4"
            ":x=w-text_w-floor(w*0.09):y=h-210"
            ":fontsize=46"
            f":{enable}[{next_out}]"
        )
        cur_in = next_out

    prem = cur_in

    fc_core = (
        f"[0:v]split=2[lv_a][lv_b];"
        f"[lv_a]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},"
        f"boxblur=luma_radius=24:luma_power=3[lv_bg];"
        f"[lv_b]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease[lv_fg];"
        f"[lv_bg][lv_fg]overlay=(W-w)/2:(H-h)/2[lv0];"
        f"[lv0]scale=iw*{z}:ih*{z},crop={OUT_W}:{OUT_H}[lv1];"
        f"[lv1]noise=alls={grain}:allf=t+u,colorbalance="
        f"rs={rs:.5f}:gs={gs:.5f}:bs={bs:.5f}[lv2];"
        f"[lv2]drawbox=x={bx}:y={by_glow}:w={wglow}:h=38:color={bar_glow_hex}@0.42:t=fill[lv3];"
        f"[lv3]drawbox=x={bx}:y={by_main}:w={wbar}:h=28:color={bar_main_hex}@0.94:t=fill[lv4];"
        f"[lv4]{hook_seg}[lv5]"
    )

    joined_pct = ";".join(segments)
    sp_lit = f"{sp:.6f}".rstrip("0").rstrip(".")
    if joined_pct:
        fc_rest = f";{joined_pct};[{prem}]setpts=PTS/{sp_lit}[vout]"
    else:
        fc_rest = f";[lv5]setpts=PTS/{sp_lit}[vout]"

    return fc_core + fc_rest


def process_file(
    input_mp4: Path,
    output_dir: Path,
    ffmpeg_exe: str = "ffmpeg",
    ffprobe_exe: str = "ffprobe",
    rng: random.Random | None = None,
) -> Path:
    rng = rng or random.Random()
    input_mp4 = input_mp4.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    kind = detect_meter_from_filename(input_mp4.name)
    engine = MeterEngine(kind, rng=rng)
    dur = probe_duration_sec(ffprobe_exe, input_mp4)
    audio_ok = has_audio_stream(ffprobe_exe, input_mp4)

    work_dir = output_dir / "_lab_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    hook_rel = "_hook_lab.txt"
    hook_path = work_dir / hook_rel
    hook_path.write_text(_sanitize_hook(engine.hook_line), encoding="utf-8")
    font_rel = _mirror_font_for_work_dir(work_dir)

    try:
        enc = pick_hw_video_encoder(ffmpeg_exe)

        fc_video = build_filter_complex(
            dur,
            engine,
            hook_rel,
            font_rel,
            engine.theme.bar_glow,
            engine.theme.bar_primary,
            rng,
        )

        use_rubber = os.environ.get("VIDEO_LAB_RUBBERBAND", "").strip().lower() in ("1", "true", "yes")
        rubber_ok = (
            audio_ok
            and use_rubber
            and ffmpeg_has_filter(ffmpeg_exe, "rubberband")
        )

        outsuffix = engine.kind.value
        out_path = output_dir / f"{input_mp4.stem}_lab_{outsuffix}_{rng.randint(1000, 9999)}.mp4"

        meta_extra = build_metadata_args(rng, engine.theme.engine_tag_suffix)

        if audio_ok and rubber_ok:
            full_fc = f"[0:a]rubberband=tempo={engine.speed_factor}:pitch=1[aout];{fc_video}"
        elif audio_ok:
            full_fc = f"{fc_video};[0:a]atempo={engine.speed_factor}[aout]"
        else:
            full_fc = fc_video

        cmd: list[str] = [ffmpeg_exe, "-hide_banner", "-y", "-i", str(input_mp4)]

        cmd += ["-filter_complex", full_fc, "-map", "[vout]"]
        if audio_ok:
            cmd += ["-map", "[aout]"]
        else:
            cmd += ["-an"]

        cmd += ["-map_metadata", "-1", *meta_extra]

        cmd += [
            "-c:v",
            enc.codec,
            *enc.preset_or_quality,
            "-pix_fmt",
            "yuv420p",
        ]
        if audio_ok:
            cmd += ["-c:a", "aac", "-b:a", "160k"]

        cmd += ["-shortest", "-movflags", "+faststart", str(out_path.resolve())]

        err_log = work_dir / "ffmpeg_stderr.txt"
        with open(err_log, "w", encoding="utf-8", errors="replace") as ef:
            p = subprocess.run(
                cmd,
                timeout=3600,
                cwd=str(work_dir),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=ef,
            )
        if p.returncode != 0:
            tail = ""
            try:
                raw = err_log.read_text(encoding="utf-8", errors="replace")
                tail = raw.strip()[-12000:] if raw else ""
            except OSError:
                pass
            raise RuntimeError(
                f"ffmpeg exited with code {p.returncode}"
                + (f"\n--- stderr (tail) ---\n{tail}" if tail else "")
            )

        return out_path
    finally:
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except OSError:
            pass


__all__ = ["process_file", "build_filter_complex", "OUT_W", "OUT_H"]
