"""Build a static copy of the dashboard for hosting without a server.

Copies the frontend files and writes the processed data to data.json next to
them. Existing files in the output folder are overwritten, nothing is deleted.

Run from the project root:
    python -m backend.build_static        # writes the site into the project root
    python -m backend.build_static site   # or into another folder
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from backend.app import CSV_PATH, FRONTEND_DIR, ROOT, build_payload


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT
    out.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "app.js", "style.css"):
        shutil.copy2(FRONTEND_DIR / name, out / name)
    (out / "data.json").write_text(json.dumps(build_payload(CSV_PATH)), encoding="utf-8")
    (out / ".nojekyll").touch()
    print(f"Static site written to {out}")


if __name__ == "__main__":
    main()
