"""Download one vertical Pollinations still. Python standard library only."""
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STYLE_MARK = "cinematic dark historical documentary still"
STYLE_LOCK = (
    ", cinematic dark historical documentary still, moody chiaroscuro lighting, "
    "dramatic shadows, desaturated cold color palette, hyper-realistic, 8k resolution, "
    "film grain, grim atmosphere, no bright colors"
)


def locked_prompt(prompt):
    text = " ".join(str(prompt or "").split()).strip()
    if STYLE_MARK not in text.lower():
        text = text.rstrip(" ,.") + STYLE_LOCK
    return text


def is_image(data):
    if data.startswith(b"\xff\xd8\xff"):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return False


def download(prompt, dest):
    text = locked_prompt(prompt)
    if len(text) < 20:
        raise ValueError("Gorsel promptu bos.")
    encoded = urllib.parse.quote(text, safe="")
    url = (
        "https://image.pollinations.ai/prompt/"
        + encoded
        + "?width=1080&height=1920&nologo=true"
    )
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ViralAtolyesiDocumentary/1.0"},
    )
    target = Path(dest)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = b""
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                data = response.read()
            last_error = None
            break
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code not in (402, 429, 503) or attempt == 3:
                raise RuntimeError(f"Pollinations {err.code}") from err
            retry_after = err.headers.get("Retry-After") if err.headers else None
            wait = 46 if err.code in (402, 429) else 8
            if retry_after and str(retry_after).isdigit():
                wait = max(wait, int(retry_after))
            time.sleep(min(wait, 60))
        except urllib.error.URLError as err:
            last_error = err
            if attempt == 3:
                raise RuntimeError(f"Pollinations baglantisi kurulamadi: {err.reason}") from err
            time.sleep(8)
    if last_error is not None and not data:
        raise RuntimeError("Pollinations gorsel vermedi.")
    if len(data) < 2048 or not is_image(data):
        raise RuntimeError("Pollinations gorsel yerine bos veya hatali yanit verdi.")
    target.write_bytes(data)


def main():
    if len(sys.argv) != 3:
        print("usage: pollinations_image.py PROMPT_FILE DEST", file=sys.stderr)
        return 2
    prompt = Path(sys.argv[1]).read_text(encoding="utf-8")
    try:
        download(prompt, sys.argv[2])
    except Exception as err:
        print(str(err), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
