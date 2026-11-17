"""Strip square-bracket stage directions before ElevenLabs reads the line."""
import re
import sys

TAG = re.compile(r"\[[^\[\]]*\]", re.DOTALL)
LOOSE = re.compile(r"[\[\]]")
SPACE = re.compile(r"\s+")


def clean_narration(text):
    cleaned = "" if text is None else str(text)
    for _ in range(4):
        nxt = re.sub(TAG, " ", cleaned)
        if nxt == cleaned:
            break
        cleaned = nxt
    cleaned = re.sub(LOOSE, " ", cleaned)
    return re.sub(SPACE, " ", cleaned).strip()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(clean_narration(sys.stdin.read()))


if __name__ == "__main__":
    main()
