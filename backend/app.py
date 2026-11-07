"""Fuel telemetry dashboard backend.

Reads the fuel log CSV, repairs and flags bad rows, computes lifetime stats and
30-90 day projections, and serves both /data.json and the static frontend.

Run from the project root:
    python -m uvicorn backend.app:app --port 8000
"""

from __future__ import annotations

import math
import os
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = Path(os.environ.get("FUEL_CSV", ROOT / "data" / "mpg_tracking.csv"))
FRONTEND_DIR = ROOT / "frontend"

COLUMN_MAP = {
    "date": "date",
    "gallons": "gallons",
    "end_mileage": "end_mileage",
    "miles_between": "miles_between",
    "mpg": "mpg",
    "days_between": "days_between",
    "miles_per_day": "miles_per_day",
    "total_spent": "total_spent",
    "$_per_gal": "price_per_gal",
    "discount_$_per_gal": "discount_per_gal",
}

PRICE_WINDOW_DAYS = 60       # the "60-day moving trend"
PROJECTION_HORIZONS = (30, 60, 90)
RECENT_MPG_FILLS = 10        # "recent MPG" = last N trustworthy tanks
USAGE_WINDOW_DAYS = 365      # a full seasonal cycle of miles/day
OUTLIER_Z = 3.5              # modified z-score cut-off for implausible MPG
PUMP_MATH_REPAIR = 0.10      # gallons x price off by >10%: the gallons are wrong
PUMP_MATH_NOTE = 0.005       # off by >0.5%: worth a note, not a repair
T_80 = {1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.440, 7: 1.415,
        8: 1.397, 9: 1.383, 10: 1.372}  # two-sided 80% Student-t critical values
RANGES = {"all": None, "3y": 3 * 365, "1y": 365}
SEASONS = {12: "Winter", 1: "Winter", 2: "Winter", 3: "Spring", 4: "Spring", 5: "Spring",
           6: "Summer", 7: "Summer", 8: "Summer", 9: "Fall", 10: "Fall", 11: "Fall"}
SEASON_ORDER = ("Winter", "Spring", "Summer", "Fall")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


# ---------------------------------------------------------------- helpers

def num(value, digits: int | None = None):
    """Convert to a JSON-safe float. NaN and infinity become None."""
    if value is None:
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    return round(value, digits) if digits is not None else value


def iso(ts) -> str:
    return pd.Timestamp(ts).date().isoformat()


def short_date(ts) -> str:
    ts = pd.Timestamp(ts)
    return f"{MONTHS[ts.month - 1]} {ts.day}, {ts.year}"


def parse_money(series: pd.Series) -> pd.Series:
    cleaned = series.astype("string").str.replace(r"[$,\s]", "", regex=True)
    return pd.to_numeric(cleaned, errors="coerce").astype(float)


def weighted_mpg(rows: pd.DataFrame) -> float:
    """Total miles over total gallons. Averaging per-tank MPG would overweight short tanks."""
    good = rows[~rows["excluded_from_mpg"]]
    gallons = good["gallons"].sum()
    return float(good["miles_between"].sum() / gallons) if gallons > 0 else float("nan")


# ---------------------------------------------------------------- ingest and clean

def load_log(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path)
    raw.columns = [c.strip().lower() for c in raw.columns]
    missing = sorted(set(COLUMN_MAP) - set(raw.columns))
    if missing:
        raise ValueError(f"CSV is missing columns: {', '.join(missing)}")
    df = raw.rename(columns=COLUMN_MAP)[list(COLUMN_MAP.values())].copy()

    df["date"] = pd.to_datetime(df["date"].astype("string").str.strip(), format="%m/%d/%Y")
    for col in ("gallons", "end_mileage", "miles_between", "mpg", "days_between", "miles_per_day"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
    for col in ("total_spent", "price_per_gal", "discount_per_gal"):
        df[col] = parse_money(df[col])

    df = df.dropna(subset=["date", "gallons", "miles_between"])
    return df.sort_values("date", kind="stable").reset_index(drop=True)


def clean_log(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["gallons_raw"] = df["gallons"]
    df["mpg_raw"] = df["mpg"]
    flags: list[list[dict]] = [[] for _ in range(len(df))]

    # The first row has no previous fill, so it has no meaningful interval.
    df.loc[df["days_between"] <= 0, "miles_per_day"] = np.nan

    # Pump math: gallons x price should equal the total paid.
    expected = df["gallons"] * df["price_per_gal"]
    gap = (expected - df["total_spent"]) / df["total_spent"]
    for i in df.index[gap.abs() > PUMP_MATH_REPAIR]:
        fixed = df.at[i, "total_spent"] / df.at[i, "price_per_gal"]
        flags[i].append({
            "code": "gallons_repaired",
            "severity": "repaired",
            "note": (f"Logged {df.at[i, 'gallons']:.3f} gal does not match "
                     f"${df.at[i, 'total_spent']:.2f} at ${df.at[i, 'price_per_gal']:.3f}/gal. "
                     f"Using {fixed:.3f} gal (total ÷ price)."),
        })
        df.at[i, "gallons"] = fixed
    for i in df.index[(gap.abs() > PUMP_MATH_NOTE) & (gap.abs() <= PUMP_MATH_REPAIR)]:
        delta = expected[i] - df.at[i, "total_spent"]
        flags[i].append({
            "code": "pump_math",
            "severity": "note",
            "note": f"Total is ${abs(delta):.2f} {'below' if delta > 0 else 'above'} gallons × price.",
        })

    df["mpg"] = df["miles_between"] / df["gallons"]

    # Implausible tanks usually mean a missed log or a partial fill, so the row's
    # miles and gallons do not belong to each other. Keep the miles, skip the MPG.
    median = df["mpg"].median()
    spread = 1.4826 * (df["mpg"] - median).abs().median()
    z = (df["mpg"] - median) / spread if spread > 0 else pd.Series(0.0, index=df.index)
    df["excluded_from_mpg"] = z.abs() > OUTLIER_Z
    for i in df.index[df["excluded_from_mpg"]]:
        flags[i].append({
            "code": "mpg_outlier",
            "severity": "excluded",
            "note": (f"{df.at[i, 'mpg']:.1f} MPG over {df.at[i, 'miles_between']:.0f} mi is not "
                     f"plausible for this car (median {median:.1f}). Likely a missed or partial "
                     "fill. Miles are kept, MPG averages skip this tank."),
        })

    # If $/gal already nets out the discount, the pump price is $/gal + discount.
    discount = df["discount_per_gal"].fillna(0.0)
    net_error = (df["gallons"] * df["price_per_gal"] - df["total_spent"]).abs()
    gross_error = (df["gallons"] * (df["price_per_gal"] - discount) - df["total_spent"]).abs()
    df["pump_price"] = np.where(net_error <= gross_error, df["price_per_gal"] + discount,
                                df["price_per_gal"])

    good = df[~df["excluded_from_mpg"]]
    rolling = (good["miles_between"].rolling(5, min_periods=3).sum()
               / good["gallons"].rolling(5, min_periods=3).sum())
    df["mpg_rolling"] = rolling.reindex(df.index).ffill()

    by_date = df.set_index("date")
    df["miles_per_day_90"] = (by_date["miles_between"].rolling("90D").sum() / 90).to_numpy()
    df.loc[df["date"] < df["date"].iloc[0] + pd.Timedelta(days=90), "miles_per_day_90"] = np.nan

    priced = df.dropna(subset=["pump_price"]).set_index("date")["pump_price"]
    df["price_ma60"] = priced.rolling(f"{PRICE_WINDOW_DAYS}D").mean().reindex(df["date"]).to_numpy()

    df["flags"] = flags
    df["season"] = df["date"].dt.month.map(SEASONS)
    return df


# ---------------------------------------------------------------- range-scoped summaries

def bubbles(rows: pd.DataFrame, monthly: bool) -> list[dict]:
    frame = rows.copy()
    if monthly:
        frame["bucket"] = frame["date"].dt.to_period("M").dt.start_time
    else:
        # Meteorological seasons: December belongs to the following winter.
        shifted = frame["date"] + pd.DateOffset(months=1)
        frame["bucket"] = shifted.dt.to_period("Q").dt.start_time - pd.DateOffset(months=1)
    out = []
    for bucket, group in frame.groupby("bucket"):
        mpg = weighted_mpg(group)
        if math.isnan(mpg):
            continue
        season = SEASONS[bucket.month]
        end_year = (bucket + pd.DateOffset(months=2)).year
        out.append({
            "label": f"{MONTHS[bucket.month - 1]} {bucket.year}" if monthly else f"{season} {end_year}",
            "date": iso(bucket + pd.Timedelta(days=14 if monthly else 45)),
            "season": season,
            "mpg": num(mpg, 2),
            "miles": num(group["miles_between"].sum(), 1),
            "gallons": num(group["gallons"].sum(), 2),
            "fills": int(len(group)),
        })
    return out


def summarize(rows: pd.DataFrame, monthly_bubbles: bool) -> dict:
    priced = rows.dropna(subset=["total_spent"])
    good = rows[~rows["excluded_from_mpg"]]
    best = good.loc[good["mpg"].idxmax()]
    worst = good.loc[good["mpg"].idxmin()]
    gap = rows.loc[rows["days_between"].idxmax()]
    span_days = max((rows["date"].iloc[-1] - rows["date"].iloc[0]).days, 1)
    timed = rows[rows["days_between"] > 0]
    discounted = rows[rows["discount_per_gal"] > 0]

    seasons = []
    for name in SEASON_ORDER:
        group = rows[rows["season"] == name]
        if len(group):
            seasons.append({"season": name, "mpg": num(weighted_mpg(group), 2),
                            "miles": num(group["miles_between"].sum(), 1)})

    month_of_year = []
    for index, name in enumerate(MONTHS, start=1):
        group = rows[rows["date"].dt.month == index]
        mpg = weighted_mpg(group) if len(group) else float("nan")
        month_of_year.append({"month": name, "season": SEASONS[index], "mpg": num(mpg, 2),
                              "fills": int(len(group))})

    return {
        "start": iso(rows["date"].iloc[0]),
        "end": iso(rows["date"].iloc[-1]),
        "fills": int(len(rows)),
        "miles": num(rows["miles_between"].sum(), 1),
        "gallons": num(rows["gallons"].sum(), 1),
        "mpg": num(weighted_mpg(rows), 2),
        "spend": num(priced["total_spent"].sum(), 2),
        "priced_fills": int(len(priced)),
        "saved": num((discounted["discount_per_gal"] * discounted["gallons"]).sum(), 2),
        "discounted_fills": int(len(discounted)),
        "avg_price": num(priced["total_spent"].sum() / priced["gallons"].sum(), 3) if len(priced) else None,
        "cost_per_mile": num(priced["total_spent"].sum() / priced["miles_between"].sum(), 3) if len(priced) else None,
        "miles_per_day": num((rows["end_mileage"].iloc[-1] - rows["end_mileage"].iloc[0]) / span_days, 2),
        "avg_days_between": num(timed["days_between"].mean(), 1),
        "best_tank": {"date": iso(best["date"]), "mpg": num(best["mpg"], 1)},
        "worst_tank": {"date": iso(worst["date"]), "mpg": num(worst["mpg"], 1)},
        "longest_gap": {"date": iso(gap["date"]), "days": int(gap["days_between"])},
        "excluded_tanks": int(rows["excluded_from_mpg"].sum()),
        "bubbles": bubbles(rows, monthly_bubbles),
        "seasons": seasons,
        "month_of_year": month_of_year,
    }


# ---------------------------------------------------------------- projections

def continuous_prices(df: pd.DataFrame) -> pd.DataFrame:
    """Priced fills after the last long gap, when price logging became continuous."""
    priced = df.dropna(subset=["pump_price"])
    gaps = priced["date"].diff().dt.days
    breaks = gaps[gaps > 180]
    return priced.loc[breaks.index[-1]:] if len(breaks) else priced


def fit_trend(days: np.ndarray, prices: np.ndarray) -> dict:
    """Least-squares line. x is days relative to the forecast origin."""
    n = len(days)
    slope, intercept = np.polyfit(days, prices, 1)
    residuals = prices - (slope * days + intercept)
    dof = n - 2
    sigma = math.sqrt(float((residuals ** 2).sum()) / dof) if dof > 0 else 0.0
    return {"slope": float(slope), "intercept": float(intercept), "sigma": sigma, "dof": dof,
            "n": n, "x_mean": float(days.mean()), "sxx": float(((days - days.mean()) ** 2).sum())}


def predict(fit: dict, day: float) -> tuple[float, float, float]:
    mid = fit["intercept"] + fit["slope"] * day
    if fit["dof"] <= 0 or fit["sxx"] == 0:
        return mid, mid, mid
    t = T_80.get(fit["dof"], 1.282)
    half = t * fit["sigma"] * math.sqrt(1 + 1 / fit["n"] + (day - fit["x_mean"]) ** 2 / fit["sxx"])
    return mid, max(mid - half, 0.0), mid + half


def trend_window(prices: pd.DataFrame, origin: pd.Timestamp) -> pd.DataFrame:
    seen = prices[prices["date"] <= origin]
    window = seen[seen["date"] > origin - pd.Timedelta(days=PRICE_WINDOW_DAYS)]
    return window if len(window) >= 3 else seen.tail(3)


def backtest(prices: pd.DataFrame, horizon: int = 30, tolerance: int = 10) -> dict | None:
    """Replay the 60-day trend at every past fill against what the pump really did."""
    trend_errors, naive_errors = [], []
    for origin in prices["date"].iloc[3:]:
        window = trend_window(prices, origin)
        target = origin + pd.Timedelta(days=horizon)
        future = prices[(prices["date"] - target).abs() <= pd.Timedelta(days=tolerance)]
        if len(window) < 3 or future.empty:
            continue
        nearest = future.iloc[(future["date"] - target).abs().argmin()]
        x = (window["date"] - origin).dt.days.to_numpy(dtype=float)
        fit = fit_trend(x, window["pump_price"].to_numpy())
        ahead = (nearest["date"] - origin).days
        trend_errors.append(abs(predict(fit, ahead)[0] - nearest["pump_price"]))
        naive_errors.append(abs(window["pump_price"].iloc[-1] - nearest["pump_price"]))
    if not trend_errors:
        return None
    return {"horizon_days": horizon, "samples": len(trend_errors),
            "trend_mae": num(np.mean(trend_errors), 3), "last_price_mae": num(np.mean(naive_errors), 3)}


def spend_windows(df: pd.DataFrame, prices: pd.DataFrame) -> list[dict]:
    """30-day windows counted back from the last fill, comparable to the projected windows."""
    end = df["date"].iloc[-1]
    start = prices["date"].iloc[0]
    out = []
    while end - pd.Timedelta(days=30) >= start - pd.Timedelta(days=1):
        begin = end - pd.Timedelta(days=30)
        rows = df[(df["date"] > begin) & (df["date"] <= end)]
        out.append({"start": iso(begin + pd.Timedelta(days=1)), "end": iso(end),
                    "spend": num(rows["total_spent"].sum(), 2), "fills": int(len(rows))})
        end = begin
    return out[::-1]


def project(df: pd.DataFrame) -> dict:
    prices = continuous_prices(df)
    origin = df["date"].iloc[-1]

    window = trend_window(prices, origin)
    x = (window["date"] - origin).dt.days.to_numpy(dtype=float)
    fit = fit_trend(x, window["pump_price"].to_numpy())

    usage_start = df[df["date"] <= origin - pd.Timedelta(days=USAGE_WINDOW_DAYS)].iloc[-1]
    usage_days = (origin - usage_start["date"]).days
    miles_per_day = (df["end_mileage"].iloc[-1] - usage_start["end_mileage"]) / usage_days
    lifetime_mpd = (df["end_mileage"].iloc[-1] - df["end_mileage"].iloc[0]) / max(
        (origin - df["date"].iloc[0]).days, 1)

    recent = df[~df["excluded_from_mpg"]].tail(RECENT_MPG_FILLS)
    recent_mpg = recent["miles_between"].sum() / recent["gallons"].sum()

    curve = []
    for day in range(0, max(PROJECTION_HORIZONS) + 1, 5):
        mid, low, high = predict(fit, day)
        curve.append({"day": day, "date": iso(origin + pd.Timedelta(days=day)),
                      "price": num(mid, 3), "low": num(low, 3), "high": num(high, 3)})

    horizons = []
    for horizon in PROJECTION_HORIZONS:
        mid, low, high = predict(fit, horizon)
        horizons.append({"days": horizon, "date": iso(origin + pd.Timedelta(days=horizon)),
                         "price": num(mid, 3), "low": num(low, 3), "high": num(high, 3)})

    windows, running = [], 0.0
    for first in range(1, max(PROJECTION_HORIZONS), 30):
        days = np.arange(first, first + 30, dtype=float)
        path = np.array([predict(fit, d) for d in days])
        gallons_per_day = miles_per_day / recent_mpg
        spend, low, high = (float(path[:, col].sum()) * gallons_per_day for col in range(3))
        running += spend
        windows.append({
            "start": iso(origin + pd.Timedelta(days=first)),
            "end": iso(origin + pd.Timedelta(days=first + 29)),
            "miles": num(miles_per_day * 30, 0),
            "gallons": num(gallons_per_day * 30, 1),
            "price": num(path[:, 0].mean(), 3),
            "spend": num(spend, 2), "low": num(low, 2), "high": num(high, 2),
            "cumulative": num(running, 2),
        })

    # What the same 90 days cost if each day gets its own season's lifetime MPG
    # instead of the recent figure. The spec'd model ignores the winter dip.
    season_mpg = {s: weighted_mpg(df[df["season"] == s]) for s in SEASON_ORDER}
    seasonal_total = 0.0
    for day in range(1, max(PROJECTION_HORIZONS) + 1):
        season = SEASONS[(origin + pd.Timedelta(days=day)).month]
        seasonal_total += predict(fit, day)[0] * miles_per_day / season_mpg[season]

    history = spend_windows(df, prices)
    last_year = history[-12:]
    intervals = df[(df["date"] > origin - pd.Timedelta(days=USAGE_WINDOW_DAYS))
                   & (df["days_between"] > 0)]["days_between"]
    next_fill_days = int(round(float(intervals.median())))

    return {
        "origin": iso(origin),
        "price": {
            "window_days": PRICE_WINDOW_DAYS,
            "points": int(fit["n"]),
            "slope_per_30d": num(fit["slope"] * 30, 3),
            "last_price": num(prices["pump_price"].iloc[-1], 3),
            "ma60": num(window["pump_price"].mean(), 3),
            "curve": curve,
            "horizons": horizons,
            "history": [{
                "date": iso(r.date), "price": num(r.pump_price, 3), "ma60": num(r.price_ma60, 3),
            } for r in prices.itertuples()],
            "backtest": backtest(prices),
        },
        "spend": {
            "miles_per_day": num(miles_per_day, 2),
            "lifetime_miles_per_day": num(lifetime_mpd, 2),
            "recent_mpg": num(recent_mpg, 2),
            "recent_mpg_fills": int(len(recent)),
            "windows": windows,
            "history": history,
            "trailing_avg": num(np.mean([w["spend"] for w in last_year]), 2),
            "seasonal_total_90d": num(seasonal_total, 2),
        },
        "next_fill": {"date": iso(origin + pd.Timedelta(days=next_fill_days)), "days": next_fill_days},
    }


# ---------------------------------------------------------------- insights

def insights(df: pd.DataFrame) -> list[dict]:
    out = []
    origin = df["date"].iloc[-1]

    by_season = {s: weighted_mpg(df[df["season"] == s]) for s in SEASON_ORDER}
    high = max(by_season, key=by_season.get)
    low = min(by_season, key=by_season.get)
    drop = (by_season[high] - by_season[low]) / by_season[high] * 100
    out.append({"title": f"{low} costs you {drop:.0f}% of your range",
                "body": f"{by_season[low]:.1f} MPG in {low.lower()} against "
                        f"{by_season[high]:.1f} in {high.lower()}, across every year logged."})

    yearly = df.groupby(df["date"].dt.year)
    priced = df.dropna(subset=["total_spent"])
    priced_year = priced.groupby(priced["date"].dt.year)
    avg = priced_year["total_spent"].sum() / priced_year["gallons"].sum()
    this_year, prior_year = origin.year, origin.year - 1
    if this_year in avg.index and prior_year in avg.index:
        gallons = priced_year["gallons"].sum()[this_year]
        extra = (avg[this_year] - avg[prior_year]) * gallons
        rise = (avg[this_year] / avg[prior_year] - 1) * 100
        out.append({"title": f"{this_year} fuel is up {rise:.0f}% per gallon",
                    "body": f"${avg[this_year]:.2f} paid against ${avg[prior_year]:.2f} in {prior_year}. "
                            f"That is ${extra:,.0f} extra on {gallons:.0f} gallons so far."})

    full_years = yearly["miles_between"].sum()
    full_years = full_years[(full_years.index > df["date"].iloc[0].year) & (full_years.index < origin.year)]
    peak, quiet = full_years.idxmax(), full_years.idxmin()
    out.append({"title": f"{peak} was your biggest driving year",
                "body": f"{full_years[peak]:,.0f} miles, against {full_years[quiet]:,.0f} in {quiet}, "
                        "the quietest full year."})

    year_ago = origin - pd.Timedelta(days=365)
    now_rows = priced[priced["date"] > year_ago]
    then_rows = priced[(priced["date"] <= year_ago) & (priced["date"] > year_ago - pd.Timedelta(days=365))]
    if len(now_rows) and len(then_rows):
        now_cpm = now_rows["total_spent"].sum() / now_rows["miles_between"].sum()
        then_cpm = then_rows["total_spent"].sum() / then_rows["miles_between"].sum()
        out.append({"title": f"Each mile now costs {now_cpm * 100:.1f}¢",
                    "body": f"Up from {then_cpm * 100:.1f}¢ over the 12 months before." if now_cpm > then_cpm
                            else f"Down from {then_cpm * 100:.1f}¢ over the 12 months before."})

    good = df[~df["excluded_from_mpg"]]
    best = good.loc[good["mpg"].idxmax()]
    out.append({"title": f"Best tank: {best['mpg']:.1f} MPG",
                "body": f"{best['miles_between']:.0f} miles on {best['gallons']:.1f} gallons, "
                        f"{short_date(best['date'])}."})
    return out


# ---------------------------------------------------------------- payload

def row_payload(row) -> dict:
    return {
        "date": iso(row.date),
        "gallons": num(row.gallons, 3),
        "gallons_raw": num(row.gallons_raw, 3),
        "end_mileage": num(row.end_mileage, 1),
        "miles": num(row.miles_between, 1),
        "mpg": num(row.mpg, 2),
        "mpg_raw": num(row.mpg_raw, 2),
        "mpg_rolling": num(row.mpg_rolling, 2),
        "days": int(row.days_between),
        "miles_per_day": num(row.miles_per_day, 2),
        "miles_per_day_90": num(row.miles_per_day_90, 2),
        "total_spent": num(row.total_spent, 2),
        "price": num(row.price_per_gal, 3),
        "pump_price": num(row.pump_price, 3),
        "discount": num(row.discount_per_gal, 2),
        "excluded_from_mpg": bool(row.excluded_from_mpg),
        "flags": row.flags,
    }


def build_payload(path: Path) -> dict:
    df = clean_log(load_log(path))
    origin = df["date"].iloc[-1]

    ranges = {}
    for key, days in RANGES.items():
        rows = df if days is None else df[df["date"] > origin - pd.Timedelta(days=days)]
        ranges[key] = summarize(rows, monthly_bubbles=key == "1y")

    quality = [{"date": iso(r.date), **flag} for r in df.itertuples() for flag in r.flags]
    priced = df.dropna(subset=["total_spent"])
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "today": date.today().isoformat(),
        "source": path.name,
        "ranges": ranges,
        "rows": [row_payload(r) for r in df.itertuples()],
        "projections": project(df),
        "insights": insights(df),
        "quality": quality,
        "coverage": {"priced_fills": int(len(priced)), "fills": int(len(df)),
                     "first_priced": iso(continuous_prices(df)["date"].iloc[0])},
    }


# ---------------------------------------------------------------- web app

class FrontendFiles(StaticFiles):
    """Static files browsers must revalidate, so HTML and JS never go out of step."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app = FastAPI(title="Fuel Telemetry Dashboard")
_cache: dict = {"mtime": None, "payload": None}


@app.get("/data.json")
def data_json() -> JSONResponse:
    """Processed dashboard data. The CSV is re-read whenever the file changes."""
    if not CSV_PATH.exists():
        raise HTTPException(503, f"Fuel log not found at {CSV_PATH}. Set FUEL_CSV to its location.")
    mtime = CSV_PATH.stat().st_mtime
    if _cache["mtime"] != mtime:
        try:
            _cache["payload"] = build_payload(CSV_PATH)
        except ValueError as error:
            raise HTTPException(422, f"Could not process {CSV_PATH.name}: {error}") from error
        _cache["mtime"] = mtime
    return JSONResponse(_cache["payload"], headers={"Cache-Control": "no-store"})


app.mount("/", FrontendFiles(directory=FRONTEND_DIR, html=True), name="frontend")
