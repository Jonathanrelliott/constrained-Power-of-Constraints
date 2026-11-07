"""Build a static copy of the dashboard for hosting without a server.

Copies the frontend and writes the processed data to data.json next to it.

Run from the project root:
    python -m backend.build_static [output_dir]   # default: site/
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from backend.app import CSV_PATH, FRONTEND_DIR, ROOT, build_payload


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "site"
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(FRONTEND_DIR, out)
    (out / "data.json").write_text(json.dumps(build_payload(CSV_PATH)), encoding="utf-8")
    (out / ".nojekyll").touch()
    print(f"Static site written to {out}")


if __name__ == "__main__":
    main()
