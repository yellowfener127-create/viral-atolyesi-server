"""Watch a folder for new .mp4 files and render optimized outputs."""

from __future__ import annotations

import logging
import random
import threading
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .processor import process_file

log = logging.getLogger(__name__)


def _looks_stable(path: Path, settle: float = 0.45) -> bool:
    try:
        if not path.is_file():
            return False
        s1 = path.stat().st_size
        if s1 < 4096:
            return False
        time.sleep(settle)
        s2 = path.stat().st_size
        return s1 == s2
    except OSError:
        return False


class _Handler(FileSystemEventHandler):
    def __init__(
        self,
        inbox: Path,
        out_dir: Path,
        ffmpeg: str,
        ffprobe: str,
        rng: random.Random,
        debounce_sec: float,
    ):
        self.inbox = inbox
        self.out_dir = out_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.rng = rng
        self.debounce_sec = debounce_sec
        self._locks: dict[str, threading.Lock] = {}

    def _lock_for(self, key: str) -> threading.Lock:
        if key not in self._locks:
            self._locks[key] = threading.Lock()
        return self._locks[key]

    def on_created(self, event):  # type: ignore[override]
        if event.is_directory:
            return
        p = Path(str(event.src_path))
        if p.suffix.lower() != ".mp4":
            return
        if not str(p.resolve()).startswith(str(self.inbox.resolve())):
            return

        def job():
            key = str(p.resolve())
            lk = self._lock_for(key)
            if not lk.acquire(blocking=False):
                return
            try:
                time.sleep(self.debounce_sec)
                if not p.is_file():
                    return
                if not _looks_stable(p):
                    log.warning("Skip (still copying?): %s", p)
                    return
                log.info("Processing %s", p.name)
                out = process_file(p, self.out_dir, self.ffmpeg, self.ffprobe, self.rng)
                log.info("Done -> %s", out)
            except Exception as e:
                log.exception("Failed %s: %s", p, e)
            finally:
                lk.release()

        threading.Thread(target=job, daemon=True).start()


def watch_folder(
    inbox: Path,
    out_dir: Path,
    *,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
    debounce_sec: float = 1.25,
) -> None:
    inbox = inbox.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random()

    handler = _Handler(inbox, out_dir, ffmpeg, ffprobe, rng, debounce_sec)
    obs = Observer()
    obs.schedule(handler, str(inbox), recursive=False)
    obs.start()
    log.info("Watching %s -> %s", inbox, out_dir)
    try:
        while obs.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        obs.stop()
        obs.join(timeout=5)
