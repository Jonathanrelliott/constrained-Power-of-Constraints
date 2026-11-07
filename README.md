# Fuel stats dashboard

Local dashboard for a vehicle fuel log. FastAPI and pandas process the CSV; the
frontend is vanilla HTML, CSS, and JavaScript with charts drawn as native SVG.

Double-click `start_dashboard.bat` to set up, start the server, and open the
dashboard. Close its window to stop the server.

Or run these from this folder:

    python -m venv .venv
    .venv/Scripts/python -m pip install -r backend/requirements.txt
    .venv/Scripts/python -m uvicorn backend.app:app --port 8000

Then open http://localhost:8000. The processed data is at `/data.json`.

The log lives at `data/mpg_tracking.csv`. Edit or replace that file and refresh
the page; the server re-reads it when it changes. To use a file somewhere else,
set `FUEL_CSV` to its path before starting the server.
