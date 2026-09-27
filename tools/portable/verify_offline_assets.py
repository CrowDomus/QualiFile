"""Verify offline asset references for portable builds."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app

DIST_ROOT = ROOT / "app" / "static" / "dist"
VENDOR_ROOT = DIST_ROOT / "vendor"

REQUIRED_FILES = [
    VENDOR_ROOT / "bootstrap" / "bootstrap.min.css",
    VENDOR_ROOT / "bootstrap" / "bootstrap.bundle.min.js",
    VENDOR_ROOT / "html2canvas" / "html2canvas.esm.js",
    VENDOR_ROOT / "konva" / "konva.min.js",
    VENDOR_ROOT / "prism" / "prism.min.js",
    VENDOR_ROOT / "prism" / "plugins" / "autoloader" / "prism-autoloader.min.js",
]

EXPECTED_SNIPPETS = [
    "/static/dist/vendor/bootstrap/bootstrap.min.css",
    "/static/dist/vendor/bootstrap/bootstrap.bundle.min.js",
    "/static/dist/vendor/prism/prism.min.js",
    "/static/dist/vendor/prism/plugins/autoloader/prism-autoloader.min.js",
]

URL_RE = re.compile(r"https?://", re.IGNORECASE)


def _prepare_env() -> None:
    data_dir = ROOT / ".tmp" / "offline_assets_check"
    os.environ.setdefault("QUALIFILE_OFFLINE_ASSETS", "1")
    os.environ.setdefault("QUALIFILE_MINIFIED", "1")
    os.environ.setdefault("QUALIFILE_DATA_DIR", str(data_dir))
    os.environ.setdefault("QUALIFILE_INSTANCE_PATH", str(data_dir))
    os.environ.setdefault("QUALIFILE_STATE", str(data_dir / "notes" / "root_state.json"))


def _render_pages() -> list[str]:
    app = create_app({"SERVER_PORT": 80})
    client = app.test_client()
    pages = ["/", "/workspace"]
    html_outputs: list[str] = []
    for path in pages:
        response = client.get(path)
        if response.status_code != 200:
            raise RuntimeError(f"GET {path} returned {response.status_code}")
        html_outputs.append(response.get_data(as_text=True))
    return html_outputs


def main() -> int:
    missing = [str(path) for path in REQUIRED_FILES if not path.exists()]
    if missing:
        sys.stderr.write("Missing vendor files:\n" + "\n".join(missing) + "\n")
        return 1

    _prepare_env()
    html_outputs = _render_pages()
    failures: list[str] = []

    for html in html_outputs:
        if URL_RE.search(html):
            failures.append("Found external URL in rendered HTML")
        for snippet in EXPECTED_SNIPPETS:
            if snippet not in html:
                failures.append(f"Missing expected asset reference: {snippet}")

    if failures:
        sys.stderr.write("Offline asset verification failed:\n" + "\n".join(sorted(set(failures))) + "\n")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
