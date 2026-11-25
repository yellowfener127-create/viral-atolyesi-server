"""Download one vertical Pollinations still. Python standard library only."""
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STYLE_MARKS = (
    "cinematic dark horror/mystery documentary still",
    "cinematic dark historical documentary still",
    "surreal psychological thriller cinematography",
    "period documentary photograph",
    "restrained documentary photograph",
    "cinematic documentary photograph",
)
STYLE_LOCK = (
    ", cinematic dark horror/mystery documentary still, moody chiaroscuro lighting, "
    "dramatic shadows, desaturated cold color palette, hyper-realistic, 8k resolution, "
    "film grain, grim atmosphere, no bright colors"
)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def locked_prompt(prompt):
    text = " ".join(str(prompt or "").split()).strip()
    lower = text.lower()
    for mark in STYLE_MARKS:
        if mark in lower:
            return text
    return text.rstrip(" ,.;:-") + STYLE_LOCK


def is_image(data):
    if data.startswith(b"\xff\xd8\xff"):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return False


def error_text(err):
    try:
        raw = err.read()
    except Exception:
        raw = b""
    return raw.decode("utf-8", "replace").replace("\n", " ").strip()


def retry_wait(code, body, headers, attempt):
    text = body or ""
    limited = code in (402, 429) or "FREE_LIMIT" in text or "free limit" in text.lower()
    busy = code in (500, 502, 503, 504)
    if not limited and not busy:
        return None
    wait = 46 if limited or attempt else 8
    retry_after = headers.get("Retry-After") if headers else None
    if retry_after and str(retry_after).isdigit():
        wait = max(wait, int(retry_after))
    found = re.search(r"retry after\s+(\d+)\s*s", text, re.I)
    if found:
        wait = max(wait, int(found.group(1)))
    return min(wait, 60)


def download(prompt, dest, seed=None):
    text = locked_prompt(prompt)
    if len(text) < 20:
        raise ValueError("Gorsel promptu bos.")
    encoded = urllib.parse.quote(text, safe="")
    provider = os.environ.get("IMAGE_PROVIDER", "classic").strip().lower()
    key = os.environ.get("POLLINATIONS_API_KEY", "").strip()
    headers = {"User-Agent": USER_AGENT}
    if provider == "enter" and key:
        url = "https://gen.pollinations.ai/image/" + encoded + "?model=flux&width=1080&height=1920"
        headers["Authorization"] = "Bearer " + key
    else:
        # Classic docs: every JPEG includes the corner logo. nologo was removed and is ignored.
        url = "https://image.pollinations.ai/prompt/" + encoded + "?width=1080&height=1920"
    if seed not in (None, ""):
        url += "&seed=" + str(int(seed))
    request = urllib.request.Request(url, headers=headers)
    target = Path(dest)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = b""
    last_detail = "Pollinations gorsel vermedi."
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                data = response.read()
            last_detail = ""
            break
        except urllib.error.HTTPError as err:
            body = error_text(err)
            snippet = " ".join(body.split())[:160]
            last_detail = f"Pollinations {err.code}" + (f": {snippet}" if snippet else "")
            wait = retry_wait(err.code, body, err.headers, attempt)
            if wait is None or attempt == 3:
                raise RuntimeError(last_detail) from err
            time.sleep(wait)
        except urllib.error.URLError as err:
            last_detail = f"Pollinations baglantisi kurulamadi: {err.reason}"
            if attempt == 3:
                raise RuntimeError(last_detail) from err
            time.sleep(8)
    if not data:
        raise RuntimeError(last_detail)
    if len(data) < 2048 or not is_image(data):
        raise RuntimeError("Pollinations gorsel yerine bos veya hatali yanit verdi.")
    target.write_bytes(data)


def main():
    if len(sys.argv) not in (3, 4):
        print("usage: pollinations_image.py PROMPT_FILE DEST [SEED]", file=sys.stderr)
        return 2
    prompt = Path(sys.argv[1]).read_text(encoding="utf-8")
    seed = sys.argv[3] if len(sys.argv) == 4 else None
    try:
        download(prompt, sys.argv[2], seed)
    except Exception as err:
        print(str(err), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
