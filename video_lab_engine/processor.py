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
from .gauge_assets import render_speedometer_assets
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


def _lit_float(x: float) -> str:
    return f"{x:.6f}".rstrip("0").rstrip(".")


def build_filter_complex(
    dur: float,
    engine: MeterEngine,
    hook_textfile_rel: str,
    font_file_rel: str | None,
    gauge_base_rel: str,
    gauge_glow_rel: str,
    needle_rel: str,
    rng: random.Random,
) -> str:
    z = engine.micro_zoom
    t_pct = engine.target_percent
    sp = engine.speed_factor

    rs = rng.uniform(-0.045, 0.045)
    gs = rng.uniform(-0.03, 0.03)
    bs = rng.uniform(-0.03, 0.03)
    grain = rng.randint(6, 13)

    font_opt = ""
    if font_file_rel:
        font_opt = f":fontfile={font_file_rel}"

    hook_base = (
        f"drawtext=textfile={hook_textfile_rel}:reload=0{font_opt}"
        ":fontcolor=0xf0f4ff:borderw=4:bordercolor=0x101014@0.9"
        ":shadowcolor=0x4400aa@0.5:shadowx=5:shadowy=5"
        ":x=(w-text_w)/2:y=92:fontsize=54:line_spacing=8"
    )

    # 5-second rule must be true in the OUTPUT timeline.
    # We apply setpts=PTS/speed_factor at the end, so output_time = input_time / speed_factor.
    # Want: output_time_hit = output_dur - 5  => input_time_hit = dur - 5*speed_factor.
    pd = max(0.10, float(dur) - 5.0 * float(sp))
    pd_lit = _lit_float(pd)

    # Smooth easing (smoothstep): p^2 * (3 - 2p)
    p_expr = f"min(t/{pd_lit}\\,1)"
    ease_expr = f"({p_expr})*({p_expr})*(3-2*({p_expr}))"
    score_expr = f"min({t_pct}\\,{t_pct}*({ease_expr}))"

    # Hook sync: subtle pulse while the needle is moving.
    hook_glow = (
        f"drawtext=textfile={hook_textfile_rel}:reload=0{font_opt}"
        ":fontcolor=0xffffff@0.30:borderw=0"
        ":shadowcolor=0x66ccff@0.35:shadowx=10:shadowy=10"
        f":alpha='if(lt(t\\,{pd_lit})\\,0.55+0.45*sin(2*PI*t*1.10)\\,0)'"
        ":x=(w-text_w)/2:y=92:fontsize=56:line_spacing=8"
    )

    # Gauge placement (bottom-center)
    gx = "(W-w)/2"
    gy = "H-h-80"

    # Needle rotation range (radians). The needle image points UP at angle=0.
    a0 = -2.20  # ~-126°
    a1 = 2.20   # ~+126°
    angle_expr = f"({a0})+({a1-a0})*(({score_expr})/100)"

    # Digital number (centered under the gauge)
    num_text = f"%{{eif\\:{score_expr}\\:d}}"
    num_seg = (
        f"drawtext=text='{num_text}'{font_opt}"
        ":fontcolor=0xfff7f2:borderw=3:bordercolor=0x201010@0.85"
        ":shadowcolor=0x000000@0.55:shadowx=4:shadowy=4"
        ":x=(w-text_w)/2:y=h-420:fontsize=72"
    )

    # Subtle checkpoint pulses (every 10 points) using glow overlay
    pulse_terms: list[str] = []
    for k in range(10, 101, 10):
        if k > t_pct:
            break
        tk = pd * (k / max(1, t_pct))
        pulse_terms.append(f"between(t\\,{_lit_float(tk - 0.07)}\\,{_lit_float(tk + 0.07)})")
    pulse_enable = "+".join(pulse_terms) if pulse_terms else "0"
    target_enable = f"between(t\\,{_lit_float(pd - 0.12)}\\,{_lit_float(pd + 0.22)})"

    fc_core = (
        f"[0:v]split=2[lv_a][lv_b];"
        f"[lv_a]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},"
        f"boxblur=luma_radius=24:luma_power=3[lv_bg];"
        f"[lv_b]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease[lv_fg];"
        f"[lv_bg][lv_fg]overlay=(W-w)/2:(H-h)/2[lv0];"
        f"[lv0]scale=iw*{z}:ih*{z},crop={OUT_W}:{OUT_H}[lv1];"
        f"[lv1]noise=alls={grain}:allf=t+u,colorbalance="
        f"rs={rs:.5f}:gs={gs:.5f}:bs={bs:.5f}[lv2];"
        f"[lv2]{hook_base}[lv3];"
        f"[lv3]{hook_glow}[lv4];"
        # Static gauge base (input 1)
        f"[lv4][1:v]overlay=x={gx}:y={gy}:format=auto[lv5];"
        # Prepare glow layers from input 2 (normal pulses + target-hit burst)
        f"[2:v]format=rgba,colorchannelmixer=aa=0.75[glo];"
        f"[glo]lutrgb=r='min(255,val*1.25)':g='min(255,val*1.25)':b='min(255,val*1.25)'[glo_p];"
        f"[glo]lutrgb=r='min(255,val*1.80)':g='min(255,val*1.80)':b='min(255,val*1.90)'[glo_t];"
        # Checkpoint glow pulses
        f"[lv5][glo_p]overlay=x={gx}:y={gy}:format=auto:enable='{pulse_enable}'[lv6];"
        # Target hit glow burst (slightly stronger / whiter)
        f"[lv6][glo_t]overlay=x={gx}:y={gy}:format=auto:enable='{target_enable}'[lv7];"
        # Rotating needle (input 3)
        f"[3:v]format=rgba,rotate=angle='{angle_expr}':ow=iw:oh=ih:c=none[ndl];"
        f"[lv7][ndl]overlay=x={gx}:y={gy}:format=auto[lv8];"
        f"[lv8]{num_seg}[lv9]"
    )

    sp_lit = f"{sp:.6f}".rstrip("0").rstrip(".")
    fc_rest = f";[lv9]setpts=PTS/{sp_lit}[vout]"

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

        # Pre-render gauge assets into work_dir (static base + glow + needle)
        # Use system font for nicer baked-in numbers when available.
        assets = render_speedometer_assets(
            work_dir,
            kind=engine.kind.value,
            font_abs=_find_font_file(),
        )

        fc_video = build_filter_complex(
            dur,
            engine,
            hook_rel,
            font_rel,
            assets["base"],
            assets["glow"],
            assets["needle"],
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

        cmd: list[str] = [
            ffmpeg_exe,
            "-hide_banner",
            "-y",
            "-i",
            str(input_mp4),
            # Static overlays (looped)
            "-loop",
            "1",
            "-i",
            assets["base"],
            "-loop",
            "1",
            "-i",
            assets["glow"],
            "-loop",
            "1",
            "-i",
            assets["needle"],
        ]

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
