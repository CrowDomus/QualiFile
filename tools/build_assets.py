"""Produce minified JS/CSS assets for the portable build."""

from __future__ import annotations

import sys
import re
import json
import hashlib
import shutil
from pathlib import Path

try:
    import rjsmin
except ImportError as exc:  # pragma: no cover - build-time dependency
    sys.stderr.write("rjsmin is required to minify JavaScript. Install it with `pip install rjsmin`.\n")
    raise

try:
    from csscompressor import compress
except ImportError as exc:  # pragma: no cover - build-time dependency
    sys.stderr.write("csscompressor is required to minify CSS. Install it with `pip install csscompressor`.\n")
    raise

ROOT = Path(__file__).resolve().parent.parent
SRC_JS = ROOT / "app" / "static" / "js"
SRC_CSS = ROOT / "app" / "static" / "css"
DEST = ROOT / "app" / "static" / "dist"
VENDOR_SRC = ROOT / "app" / "static" / "vendor"
VENDOR_DEST = DEST / "vendor"
PASSTHROUGH_JS = {"toc-extractor.js"}  # Files that must ship unminified alongside bundles
MANIFEST = DEST / "manifest.json"

IMPORT_FROM_PATTERN = re.compile(r"(from\s+['\"])(\.{1,2}/[^'\"?]+?)(\.js)(['\"])", re.IGNORECASE)
IMPORT_BARE_PATTERN = re.compile(r"(import\s+['\"])(\.{1,2}/[^'\"?]+?)(\.js)(['\"])", re.IGNORECASE)
URL_PATTERN = re.compile(r"(URL\(['\"])(\.{1,2}/[^'\"]+?)(\.js)(['\"]\))", re.IGNORECASE)
DYNAMIC_IMPORT_PATTERN = re.compile(r"(import\s*\(\s*['\"])(\.{1,2}/[^'\"?]+?)(\.js)(['\"]\s*\))", re.IGNORECASE)
RELATIVE_SPECIFIER = re.compile(r"^\.{1,2}/")


def _rewrite_relative_imports(content: str) -> str:
    """Point relative module imports to their minified counterparts."""

    def _replace(match: re.Match) -> str:
        return f"{match.group(1)}{match.group(2)}.min.js{match.group(4)}"

    content = IMPORT_FROM_PATTERN.sub(_replace, content)
    content = IMPORT_BARE_PATTERN.sub(_replace, content)
    content = URL_PATTERN.sub(_replace, content)
    content = DYNAMIC_IMPORT_PATTERN.sub(_replace, content)
    return content


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_manifest() -> dict:
    if MANIFEST.exists():
        try:
            return json.loads(MANIFEST.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _write_manifest(data: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _copy_vendor_assets() -> None:
    if not VENDOR_SRC.exists():
        return
    for source in VENDOR_SRC.rglob("*"):
        if source.is_dir():
            continue
        target = VENDOR_DEST / source.relative_to(VENDOR_SRC)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def minify_js() -> None:
    dest_dir = DEST / "js"
    dest_dir.mkdir(parents=True, exist_ok=True)
    seen = {}
    for source in sorted(SRC_JS.rglob("*.js")):
        if source.is_dir() or source.name.endswith(".min.js"):
            continue
        relative = source.relative_to(SRC_JS)
        target = (dest_dir / relative).with_suffix(".min.js")
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = source.read_text(encoding="utf-8")
        rewritten = _rewrite_relative_imports(raw)
        minified = rjsmin.jsmin(rewritten)
        target.write_text(minified, encoding="utf-8")
        if source.name in PASSTHROUGH_JS:
            passthrough_target = dest_dir / relative
            passthrough_target.parent.mkdir(parents=True, exist_ok=True)
            passthrough_target.write_text(raw, encoding="utf-8")
        seen[str(source.relative_to(ROOT))] = {
            "output": str(target.relative_to(ROOT)),
            "hash": _hash_text(raw),
            "mtime": source.stat().st_mtime,
        }
    return seen


def minify_css() -> None:
    dest_dir = DEST / "css"
    dest_dir.mkdir(parents=True, exist_ok=True)
    seen = {}
    for source in sorted(SRC_CSS.rglob("*.css")):
        if source.is_dir() or source.name.endswith(".min.css"):
            continue
        relative = source.relative_to(SRC_CSS)
        target = (dest_dir / relative).with_suffix(".min.css")
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = source.read_text(encoding="utf-8")
        minified = compress(raw)
        target.write_text(minified, encoding="utf-8")
        seen[str(source.relative_to(ROOT))] = {
            "output": str(target.relative_to(ROOT)),
            "hash": _hash_text(raw),
            "mtime": source.stat().st_mtime,
        }
    return seen


def _verify_coverage(seen: dict, src_dir: Path, dest_dir: Path, suffix: str) -> None:
    errors = []
    pattern = "*.js" if suffix.endswith(".js") else "*.css"
    for source in sorted(src_dir.rglob(pattern)):
        if source.is_dir() or source.name.endswith(".min.js") or source.name.endswith(".min.css"):
            continue
        relative = source.relative_to(src_dir)
        if suffix.endswith(".js"):
            target = (dest_dir / relative).with_suffix(".min.js")
        else:
            target = (dest_dir / relative).with_suffix(".min.css")
        if not target.exists():
            errors.append(f"Missing dist asset for {source.relative_to(ROOT)} -> {target.relative_to(ROOT)}")
    if errors:
        raise SystemExit("\n".join(errors))


def _verify_templates(manifest: dict) -> None:
    template_dir = ROOT / "app" / "templates"
    local_refs = set()
    for path in template_dir.rglob("*.html"):
        content = path.read_text(encoding="utf-8")
        for match in re.finditer(r"""(?:src|href)=["']{{\s*url_for\('static',\s*filename=['"]([^'"]+)['"]\)\s*}}""", content):
            local_refs.add(match.group(1))
    errors = []
    for ref in sorted(local_refs):
        src = ROOT / "app" / "static" / ref
        if not src.exists():
            errors.append(f"Template reference missing source: {ref}")
            continue
        # Only enforce dist presence for JS/CSS assets
        if src.suffix.lower() in {".js", ".css"}:
            if ref.startswith("dist/") or src.name.endswith((".min.js", ".min.css")):
                continue
            minified = ROOT / "app" / "static" / "dist" / ref
            if src.suffix.lower() == ".js":
                minified = minified.with_suffix(".min.js")
            elif src.suffix.lower() == ".css":
                minified = minified.with_suffix(".min.css")
            if not minified.exists():
                errors.append(f"Template reference missing dist: {minified.relative_to(ROOT)}")
    if errors:
        raise SystemExit("\n".join(errors))


def main() -> None:
    old_manifest = _load_manifest()
    manifest = {"generated_from": "tools/build_assets.py", "entries": {}}
    js_entries = minify_js()
    css_entries = minify_css()
    manifest["entries"].update(js_entries)
    manifest["entries"].update(css_entries)
    _verify_coverage(js_entries, SRC_JS, DEST / "js", ".min.js")
    _verify_coverage(css_entries, SRC_CSS, DEST / "css", ".min.css")
    _copy_vendor_assets()
    _verify_templates(manifest)
    _write_manifest(manifest)
    # remove orphaned dist files
    valid_outputs = {Path(info["output"]) for info in manifest["entries"].values()}
    for folder in (DEST / "js", DEST / "css"):
        for file in folder.rglob("*.min.*"):
            rel = file.relative_to(ROOT)
            if rel not in valid_outputs:
                file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
