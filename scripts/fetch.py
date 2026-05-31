"""
Cash-Secured Put Scanner — data fetcher.

Pulls put option chains from Yahoo Finance via yfinance, computes
Black-Scholes delta (yfinance does not return greeks), applies strict
filters from the spec, scores each contract 0-100, and writes:
    docs/data.json   — accepted + rejected contracts
    docs/meta.json   — counts, config, last-updated timestamp

Run:
    python scripts/fetch.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf
from scipy.stats import norm

# ---------------------------------------------------------------------------
# Config — also written to meta.json so the UI can display thresholds.
# ---------------------------------------------------------------------------
CONFIG = {
    "max_delta": 0.15,          # absolute delta cutoff
    "max_dte": 21,              # max calendar days to expiration
    "min_dte": 1,               # ignore same-day expirations
    "min_oi": 100,              # minimum open interest
    "max_spread_pct": 20.0,     # bid/ask spread as percent of mid
    "max_per_ticker": 3,        # top N contracts per ticker
    "risk_free_rate": 0.05,     # for Black-Scholes
    "exclude_earnings_before_expiry": True,
    "premium_basis": "bid",     # "bid" (conservative) or "mid"
    "max_workers": 8,           # parallel ticker fetches
}

ROOT = Path(__file__).resolve().parent.parent
TICKERS_FILE = ROOT / "config" / "tickers.txt"
DATA_OUT = ROOT / "docs" / "data.json"
META_OUT = ROOT / "docs" / "meta.json"


# ---------------------------------------------------------------------------
# Pandas NaN-safe coercion (yfinance returns NaN for missing OI/volume).
# ---------------------------------------------------------------------------
def _safe_float(v) -> float:
    try:
        f = float(v)
        return 0.0 if math.isnan(f) else f
    except (TypeError, ValueError):
        return 0.0


def _safe_int(v) -> int:
    try:
        f = float(v)
        if math.isnan(f):
            return 0
        return int(f)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Black-Scholes put delta.
# ---------------------------------------------------------------------------
def bs_put_delta(spot: float, strike: float, t_years: float,
                 r: float, sigma: float) -> float | None:
    """Black-Scholes put delta. Returns a negative value in (-1, 0)."""
    if t_years <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return None
    try:
        d1 = (math.log(spot / strike) + (r + 0.5 * sigma ** 2) * t_years) \
            / (sigma * math.sqrt(t_years))
        return float(norm.cdf(d1) - 1.0)
    except (ValueError, ZeroDivisionError):
        return None


# ---------------------------------------------------------------------------
# Ticker metadata helpers.
# ---------------------------------------------------------------------------
def safe_get_info(tk: yf.Ticker) -> dict:
    try:
        return tk.info or {}
    except Exception:
        return {}


def get_spot_and_name(info: dict, symbol: str) -> tuple[float | None, str]:
    spot = (info.get("regularMarketPrice")
            or info.get("currentPrice")
            or info.get("previousClose"))
    name = info.get("shortName") or info.get("longName") or symbol
    return (float(spot) if spot else None), name


def get_next_earnings_date(tk: yf.Ticker) -> date | None:
    """
    Try several yfinance surfaces for the next earnings date.
    Returns None if unavailable.
    """
    # 1) get_earnings_dates() — most reliable when available
    try:
        ed = tk.get_earnings_dates(limit=8)
        if ed is not None and not ed.empty:
            today = date.today()
            future = [d.date() for d in ed.index.to_pydatetime() if d.date() >= today]
            if future:
                return min(future)
    except Exception:
        pass

    # 2) calendar dict
    try:
        cal = tk.calendar
        if cal:
            ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
            if ed:
                if isinstance(ed, list) and ed:
                    candidate = ed[0]
                else:
                    candidate = ed
                if hasattr(candidate, "date"):
                    candidate = candidate.date()
                if isinstance(candidate, date):
                    return candidate
    except Exception:
        pass

    return None


# ---------------------------------------------------------------------------
# Scoring.
# ---------------------------------------------------------------------------
def score_contract(c: dict) -> tuple[float, list[str]]:
    """Returns (score 0-100, notes list)."""
    notes: list[str] = []

    # A. Premium efficiency (25 pts) — annualized return on cash secured.
    # 50% annualized maps to full 25 pts (sigmoid-ish linear cap).
    ann = c["annualized_premium_pct"]
    premium_score = min(25.0, max(0.0, ann / 50.0 * 25.0))

    # B. Assignment cushion (25 pts) — discount of strike vs spot.
    disc = c["assignment_discount_pct"]
    cushion_score = min(25.0, max(0.0, disc / 15.0 * 25.0))
    if disc < 0:
        notes.append("Strike above spot (ITM)")

    # C. Delta safety (20 pts). 0% delta -> 20, 15% delta -> 0.
    delta_abs = c["delta_pct"]
    delta_score = max(0.0, (15.0 - delta_abs) / 15.0 * 20.0)

    # D. Liquidity (15 pts) — split between OI (10) and spread (5).
    oi = max(1, c["open_interest"])
    # log10 ramp: 100 -> 5pt, 1000 -> 7.5pt, 10000 -> 10pt
    oi_score = min(10.0, max(0.0, (math.log10(oi) - 2.0) / 2.0 * 5.0 + 5.0))
    spread = c["spread_pct"]
    spread_score = max(0.0, (20.0 - spread) / 20.0 * 5.0)
    liquidity_score = oi_score + spread_score

    # E. Earnings risk (15 pts).
    days_to_earn = c.get("days_until_earnings")
    dte = c["dte"]
    if days_to_earn is None:
        earnings_score = 12.0
        notes.append("Earnings date unknown")
    elif days_to_earn < 0:
        earnings_score = 15.0  # earnings already passed
    elif days_to_earn <= dte:
        earnings_score = 0.0
        notes.append("Earnings before expiry")
    elif days_to_earn <= dte + 7:
        earnings_score = 8.0
        notes.append("Earnings shortly after expiry")
    elif days_to_earn <= 30:
        earnings_score = 12.0
    else:
        earnings_score = 15.0

    total = premium_score + cushion_score + delta_score \
        + liquidity_score + earnings_score
    return round(min(100.0, max(0.0, total)), 1), notes


# ---------------------------------------------------------------------------
# Per-ticker processing.
# ---------------------------------------------------------------------------
def process_ticker(symbol: str) -> tuple[list[dict], list[dict], dict]:
    """
    Returns (accepted_contracts, rejected_contracts, ticker_meta).
    Always returns; never raises.
    """
    accepted: list[dict] = []
    rejected: list[dict] = []
    meta = {"symbol": symbol, "ok": False, "error": None,
            "next_earnings": None}

    try:
        tk = yf.Ticker(symbol)
        info = safe_get_info(tk)
        spot, name = get_spot_and_name(info, symbol)
        if not spot:
            meta["error"] = "no spot price"
            rejected.append({"ticker": symbol, "reason": "Stale data — no spot"})
            return accepted, rejected, meta

        next_earnings = get_next_earnings_date(tk)
        meta["next_earnings"] = next_earnings.isoformat() if next_earnings else None

        try:
            expirations = tk.options or ()
        except Exception as e:
            meta["error"] = f"options list error: {e}"
            rejected.append({"ticker": symbol, "reason": f"Options unavailable: {e}"})
            return accepted, rejected, meta

        today = date.today()
        max_exp = today + timedelta(days=CONFIG["max_dte"])

        for exp_str in expirations:
            try:
                exp_date = datetime.strptime(exp_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if exp_date < today or exp_date > max_exp:
                continue

            dte = (exp_date - today).days
            if dte < CONFIG["min_dte"]:
                continue

            try:
                chain = tk.option_chain(exp_str)
                puts = chain.puts
            except Exception:
                continue

            t_years = dte / 365.0

            for _, row in puts.iterrows():
                strike = _safe_float(row.get("strike"))
                bid = _safe_float(row.get("bid"))
                ask = _safe_float(row.get("ask"))
                last = _safe_float(row.get("lastPrice"))
                oi = _safe_int(row.get("openInterest"))
                volume = _safe_int(row.get("volume"))
                iv = _safe_float(row.get("impliedVolatility"))

                base = {
                    "ticker": symbol,
                    "expiration": exp_str,
                    "strike": strike,
                    "dte": dte,
                    "bid": bid,
                    "ask": ask,
                }

                # Hard validation per spec.
                if strike <= 0:
                    rejected.append({**base, "reason": "Missing strike"})
                    continue
                if bid <= 0:
                    rejected.append({**base, "reason": "Bid is zero"})
                    continue
                if ask <= 0:
                    rejected.append({**base, "reason": "Stale data — no ask"})
                    continue
                if last <= 0:
                    rejected.append({**base, "reason": "Stale data — no last"})
                    continue
                if iv <= 0:
                    rejected.append({**base, "reason": "Missing IV"})
                    continue
                if oi <= 0:
                    rejected.append({**base, "reason": "Missing open interest"})
                    continue

                # Spread check.
                mid = (bid + ask) / 2.0
                spread_pct = ((ask - bid) / mid) * 100.0 if mid > 0 else 999.0
                if spread_pct > CONFIG["max_spread_pct"]:
                    rejected.append({**base, "reason": "Spread too wide"})
                    continue

                # Liquidity check.
                if oi < CONFIG["min_oi"]:
                    rejected.append({**base, "reason": "Low liquidity (OI)"})
                    continue

                # Delta (Black-Scholes since yfinance doesn't provide it).
                delta = bs_put_delta(spot, strike, t_years,
                                     CONFIG["risk_free_rate"], iv)
                if delta is None:
                    rejected.append({**base, "reason": "Missing delta"})
                    continue
                delta_abs = abs(delta)
                if delta_abs > CONFIG["max_delta"]:
                    rejected.append({
                        **base,
                        "reason": f"Delta above 15% ({delta_abs * 100:.1f}%)",
                    })
                    continue

                # Earnings check.
                days_until_earnings = None
                earnings_risk = False
                if next_earnings is not None:
                    days_until_earnings = (next_earnings - today).days
                    if 0 <= days_until_earnings <= dte:
                        earnings_risk = True

                if earnings_risk and CONFIG["exclude_earnings_before_expiry"]:
                    rejected.append({**base, "reason": "Earnings before expiration"})
                    continue

                # Metrics.
                premium = bid if CONFIG["premium_basis"] == "bid" else mid
                cash_required = strike * 100.0  # one contract = 100 shares
                breakeven = strike - premium
                assignment_discount_pct = ((spot - strike) / spot) * 100.0
                # Annualized return on cash-secured capital.
                annualized_premium_pct = (premium / strike) \
                    * (365.0 / dte) * 100.0

                contract = {
                    "ticker": symbol,
                    "company_name": name,
                    "current_price": round(spot, 2),
                    "expiration": exp_str,
                    "dte": dte,
                    "strike": round(strike, 2),
                    "bid": round(bid, 2),
                    "ask": round(ask, 2),
                    "mid": round(mid, 2),
                    "premium_used": CONFIG["premium_basis"],
                    "premium": round(premium, 2),
                    "delta_pct": round(delta_abs * 100.0, 2),
                    "iv_pct": round(iv * 100.0, 2),
                    "open_interest": oi,
                    "volume": volume,
                    "spread_pct": round(spread_pct, 2),
                    "cash_required": round(cash_required, 2),
                    "breakeven": round(breakeven, 2),
                    "assignment_discount_pct": round(assignment_discount_pct, 2),
                    "annualized_premium_pct": round(annualized_premium_pct, 2),
                    "next_earnings": next_earnings.isoformat() if next_earnings else None,
                    "days_until_earnings": days_until_earnings,
                    "earnings_risk": earnings_risk,
                }
                score, notes = score_contract(contract)
                contract["score"] = score
                contract["notes"] = "; ".join(notes)
                accepted.append(contract)

        # Keep top N per ticker by score.
        accepted.sort(key=lambda c: c["score"], reverse=True)
        accepted = accepted[: CONFIG["max_per_ticker"]]
        meta["ok"] = True
        return accepted, rejected, meta

    except Exception as e:
        meta["error"] = str(e)
        rejected.append({
            "ticker": symbol,
            "reason": f"Fetch error: {e.__class__.__name__}",
        })
        return accepted, rejected, meta


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------
def load_tickers() -> list[str]:
    if not TICKERS_FILE.exists():
        print(f"[fatal] tickers file missing: {TICKERS_FILE}", file=sys.stderr)
        sys.exit(1)
    out = []
    for line in TICKERS_FILE.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(s.upper())
    # de-dup while preserving order
    seen, deduped = set(), []
    for t in out:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped


def main() -> int:
    start = time.time()
    tickers = load_tickers()
    print(f"[info] scanning {len(tickers)} tickers", flush=True)

    all_accepted: list[dict] = []
    all_rejected: list[dict] = []
    ticker_meta: list[dict] = []

    with ThreadPoolExecutor(max_workers=CONFIG["max_workers"]) as pool:
        futures = {pool.submit(process_ticker, t): t for t in tickers}
        for i, fut in enumerate(as_completed(futures), 1):
            t = futures[fut]
            try:
                acc, rej, meta = fut.result()
            except Exception as e:
                print(f"[warn] {t}: unhandled {e}", flush=True)
                traceback.print_exc()
                all_rejected.append({"ticker": t,
                                     "reason": f"Unhandled error: {e}"})
                ticker_meta.append({"symbol": t, "ok": False, "error": str(e)})
                continue
            all_accepted.extend(acc)
            all_rejected.extend(rej)
            ticker_meta.append(meta)
            print(f"[{i}/{len(tickers)}] {t}: "
                  f"{len(acc)} accepted, {len(rej)} rejected", flush=True)

    # Global ranking by score, then assign 1-based rank.
    all_accepted.sort(key=lambda c: c["score"], reverse=True)
    for i, c in enumerate(all_accepted, 1):
        c["rank"] = i

    # Counts for summary cards.
    missing_delta = sum(1 for r in all_rejected
                        if "delta" in r.get("reason", "").lower())
    missing_earnings = sum(1 for c in all_accepted
                           if not c.get("next_earnings"))

    DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    DATA_OUT.write_text(json.dumps(
        {"accepted": all_accepted, "rejected": all_rejected},
        indent=2, default=str,
    ))

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "tickers_scanned": len(tickers),
        "accepted_count": len(all_accepted),
        "rejected_count": len(all_rejected),
        "missing_delta_count": missing_delta,
        "missing_earnings_count": missing_earnings,
        "tickers_ok": sum(1 for m in ticker_meta if m.get("ok")),
        "tickers_failed": sum(1 for m in ticker_meta if not m.get("ok")),
        "config": CONFIG,
        "elapsed_seconds": round(time.time() - start, 1),
    }
    META_OUT.write_text(json.dumps(meta, indent=2, default=str))

    print(f"[done] {len(all_accepted)} accepted, {len(all_rejected)} rejected"
          f" in {meta['elapsed_seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
