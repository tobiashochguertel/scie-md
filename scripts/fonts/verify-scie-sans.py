from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont


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
MANIFEST_PATH = AUTHORITATIVE_DIR / "manifest.json"
REQUIRED_FEATURES = {"zero", "tnum", "pnum", "sups", "subs", "sinf", "numr", "dnom", "frac"}
REQUIRED_CODEPOINTS = {
    0x00B5: "micro sign",
    0x00C5: "A with ring",
    0x03BC: "Greek mu",
    0x03D1: "theta symbol",
    0x03D5: "phi symbol",
    0x03D6: "varpi",
    0x03F0: "kappa symbol",
    0x03F1: "rho symbol",
    0x03F5: "epsilon symbol",
    0x202F: "narrow no-break space",
    0x212B: "angstrom sign",
    0x2212: "minus sign",
    0x2032: "prime",
    0x2033: "double prime",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest["authoritativeDirectory"] != "public/fonts/scie-sans":
        raise AssertionError("Scie Sans manifest authority drifted")
    if manifest["generatedMirror"] != "scie-md-vscode-extension/src/scie-md/styles/fonts/scie-sans":
        raise AssertionError("Scie Sans manifest mirror drifted")

    for record in manifest["files"]:
        verify_projection(record)
    for face in manifest["faces"]:
        verify_face(face)

    authoritative_files = relative_files(AUTHORITATIVE_DIR)
    mirror_files = relative_files(MIRROR_DIR)
    if authoritative_files != mirror_files:
        raise AssertionError(
            f"Scie Sans projection file set drifted: authoritative={authoritative_files}, mirror={mirror_files}"
        )
    if MANIFEST_PATH.read_bytes() != (MIRROR_DIR / "manifest.json").read_bytes():
        raise AssertionError("Scie Sans projection manifest is not byte-identical")
    print(f"Scie Sans font verification OK ({len(manifest['faces'])} faces, hash-identical projection)")


def relative_files(root: Path) -> list[str]:
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())


def verify_projection(record: dict[str, str | int]) -> None:
    relative = str(record["name"])
    authoritative = AUTHORITATIVE_DIR / relative
    mirror = MIRROR_DIR / relative
    for label, path in (("authoritative", authoritative), ("mirror", mirror)):
        if not path.is_file():
            raise AssertionError(f"Missing {label} Scie Sans file: {path}")
        if path.stat().st_size != int(record["bytes"]):
            raise AssertionError(f"{label} size drift for {relative}")
        if sha256(path) != record["sha256"]:
            raise AssertionError(f"{label} hash drift for {relative}")


def verify_face(face: dict[str, str | int]) -> None:
    relative = str(face["file"])
    path = AUTHORITATIVE_DIR / relative
    font = TTFont(path)
    family = str(face["family"])
    label = f"{family} {face['weight']} {face['style']}"
    typographic_family = font["name"].getDebugName(16) or font["name"].getDebugName(1)
    if typographic_family != family:
        raise AssertionError(f"{label}: family metadata is {typographic_family!r}")
    if font["OS/2"].usWeightClass != int(face["weight"]):
        raise AssertionError(f"{label}: unexpected weight class {font['OS/2'].usWeightClass}")
    expected_width = 4 if family.endswith("Compact") else 5
    if font["OS/2"].usWidthClass != expected_width:
        raise AssertionError(f"{label}: unexpected width class {font['OS/2'].usWidthClass}")
    expected_italic = str(face["style"]) == "italic"
    if is_italic(font) != expected_italic:
        raise AssertionError(f"{label}: italic metadata does not match")
    if font["OS/2"].fsType != 0:
        raise AssertionError(f"{label}: embedding must be unrestricted")
    verify_features(font, label)
    verify_coverage(font, label)
    verify_scientific_metrics(font, label)


def verify_features(font: TTFont, label: str) -> None:
    if "GSUB" not in font or not font["GSUB"].table.FeatureList:
        raise AssertionError(f"{label}: missing GSUB feature list")
    tags = {record.FeatureTag for record in font["GSUB"].table.FeatureList.FeatureRecord}
    missing = REQUIRED_FEATURES - tags
    if missing:
        raise AssertionError(f"{label}: missing GSUB features {sorted(missing)}")


def verify_coverage(font: TTFont, label: str) -> None:
    cmap = font.getBestCmap()
    missing = [
        f"U+{codepoint:04X} {name}"
        for codepoint, name in REQUIRED_CODEPOINTS.items()
        if codepoint not in cmap
    ]
    if missing:
        raise AssertionError(f"{label}: missing required codepoints: {', '.join(missing)}")


def verify_scientific_metrics(font: TTFont, label: str) -> None:
    cmap = font.getBestCmap()
    minus = cmap[0x2212]
    if font["hmtx"][minus][0] <= 0:
        raise AssertionError(f"{label}: minus sign has no usable advance")
    if font["hmtx"][cmap[0x202F]][0] >= font["hmtx"][cmap[0x20]][0]:
        raise AssertionError(f"{label}: narrow no-break space must remain narrower than word space")


def is_italic(font: TTFont) -> bool:
    return bool(font["OS/2"].fsSelection & 0x01) or font["post"].italicAngle != 0


if __name__ == "__main__":
    main()
