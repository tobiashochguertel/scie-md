from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AUTHORITATIVE_DIR = ROOT / "public" / "fonts" / "scie-sans"
MIRROR_DIR = (
    ROOT
    / "scie-md-vscode-extension"
    / "src"
    / "scie-md"
    / "styles"
    / "fonts"
    / "scie-sans"
)
MANIFEST_NAME = "manifest.json"

FACES = (
    {"family": "Scie Sans", "weight": 300, "style": "normal", "file": "ScieSans-Light.woff2"},
    {"family": "Scie Sans", "weight": 300, "style": "italic", "file": "ScieSans-LightItalic.woff2"},
    {"family": "Scie Sans", "weight": 400, "style": "normal", "file": "ScieSans-Regular.woff2"},
    {"family": "Scie Sans", "weight": 400, "style": "italic", "file": "ScieSans-Italic.woff2"},
    {"family": "Scie Sans", "weight": 500, "style": "normal", "file": "ScieSans-Medium.woff2"},
    {"family": "Scie Sans", "weight": 500, "style": "italic", "file": "ScieSans-MediumItalic.woff2"},
    {"family": "Scie Sans", "weight": 700, "style": "normal", "file": "ScieSans-Bold.woff2"},
    {"family": "Scie Sans", "weight": 700, "style": "italic", "file": "ScieSans-BoldItalic.woff2"},
    {
        "family": "Scie Sans Compact",
        "weight": 300,
        "style": "normal",
        "file": "compact-v1.320/ScieSansCompact-Light.woff2",
    },
    {
        "family": "Scie Sans Compact",
        "weight": 400,
        "style": "normal",
        "file": "compact-v1.320/ScieSansCompact-Regular.woff2",
    },
    {
        "family": "Scie Sans Compact",
        "weight": 500,
        "style": "normal",
        "file": "compact-v1.320/ScieSansCompact-Medium.woff2",
    },
    {"family": "Scie Sans Text", "weight": 400, "style": "normal", "file": "ScieSansText-Regular.woff2"},
    {"family": "Scie Sans Text", "weight": 400, "style": "italic", "file": "ScieSansText-Italic.woff2"},
    {"family": "Scie Sans Text", "weight": 500, "style": "normal", "file": "ScieSansText-Medium.woff2"},
    {"family": "Scie Sans Text", "weight": 700, "style": "normal", "file": "ScieSansText-Bold.woff2"},
    {"family": "Scie Sans Text", "weight": 700, "style": "italic", "file": "ScieSansText-BoldItalic.woff2"},
    {
        "family": "Scie Sans Text Compact",
        "weight": 400,
        "style": "normal",
        "file": "ScieSansTextCompact-Regular.woff2",
    },
    {
        "family": "Scie Sans Text Compact",
        "weight": 500,
        "style": "normal",
        "file": "ScieSansTextCompact-Medium.woff2",
    },
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    missing = [face["file"] for face in FACES if not (AUTHORITATIVE_DIR / str(face["file"])).is_file()]
    if missing:
        raise FileNotFoundError(f"Authoritative Scie Sans bundle is incomplete: {', '.join(missing)}")

    files = []
    for path in sorted(AUTHORITATIVE_DIR.rglob("*")):
        if not path.is_file() or path.name == MANIFEST_NAME:
            continue
        relative = path.relative_to(AUTHORITATIVE_DIR).as_posix()
        files.append({"name": relative, "bytes": path.stat().st_size, "sha256": sha256(path)})

    manifest = {
        "schemaVersion": 1,
        "families": ["Scie Sans", "Scie Sans Compact", "Scie Sans Text", "Scie Sans Text Compact"],
        "source": "Scienfy/scie-sans-tuning",
        "sourceState": "2026-07-14 tuned Scie Sans v1.320 and ship-ready Scie Sans Text v1.1/Text Compact v1.2",
        "license": "OFL-1.1",
        "authoritativeDirectory": "public/fonts/scie-sans",
        "generatedMirror": "scie-md-vscode-extension/src/scie-md/styles/fonts/scie-sans",
        "generatedBy": "scripts/fonts/build-scie-sans.py",
        "faces": FACES,
        "files": files,
    }
    (AUTHORITATIVE_DIR / MANIFEST_NAME).write_text(
        f"{json.dumps(manifest, indent=2)}\n",
        encoding="utf-8",
    )

    if MIRROR_DIR.exists():
        shutil.rmtree(MIRROR_DIR)
    shutil.copytree(AUTHORITATIVE_DIR, MIRROR_DIR)
    print(f"[fonts:scie-sans] Projected {len(FACES)} faces and {len(files)} hashed files.")


if __name__ == "__main__":
    main()
