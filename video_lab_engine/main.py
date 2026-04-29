"""CLI: watch inbox or process one file."""

from __future__ import annotations

import argparse
import logging
import os
import random
import sys
from pathlib import Path

from .processor import process_file


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    epilog = """Environment (optional):
  VIDEO_LAB_IN / VIDEO_LAB_OUT - default inbox and output dirs
  FFMPEG_BIN / FFPROBE_BIN - ffmpeg/ffprobe executable names
  VIDEO_LAB_NVENC=1 - use NVENC when available (default is CPU libx264)
  VIDEO_LAB_RUBBERBAND=1 - pitch-preserving speed-up via rubberband (default: atempo)
"""
    ap = argparse.ArgumentParser(
        description="Lab meter viral clip processor",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=epilog,
    )
    ap.add_argument(
        "--watch",
        action="store_true",
        help="Watch VIDEO_LAB_IN (or --inbox) for new .mp4 files",
    )
    ap.add_argument(
        "--once",
        metavar="FILE",
        help="Process a single mp4 and exit",
    )
    ap.add_argument(
        "--inbox",
        default=os.environ.get("VIDEO_LAB_IN", "lab_inbox"),
        help="Watch folder (default: lab_inbox or VIDEO_LAB_IN)",
    )
    ap.add_argument(
        "--out",
        dest="out_dir",
        default=os.environ.get("VIDEO_LAB_OUT", "optimized"),
        help="Output folder (default: optimized or VIDEO_LAB_OUT)",
    )
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "ffmpeg"))
    ap.add_argument("--ffprobe", default=os.environ.get("FFPROBE_BIN", "ffprobe"))
    ns = ap.parse_args(argv)

    out = Path(ns.out_dir)

    if ns.once:
        p = Path(ns.once).resolve()
        if not p.is_file():
            logging.error("Not a file: %s", p)
            return 2
        try:
            done = process_file(p, out, ns.ffmpeg, ns.ffprobe, random.Random())
            print(done)
            return 0
        except Exception as e:
            logging.exception("%s", e)
            return 1

    if ns.watch:
        from .watcher import watch_folder

        watch_folder(Path(ns.inbox), out, ffmpeg=ns.ffmpeg, ffprobe=ns.ffprobe)
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
