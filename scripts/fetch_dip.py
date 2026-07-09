"""
CSP Scanner — Dip Buyer data fetcher.

Strategy: identify the S&P 500's biggest single-day losers, then scan their
put option chains for cash-secured put opportunities. The thesis is that
oversold stocks with elevated IV tend to mean-revert, making CSP entry
attractive — you collect elevated premium while being willing to own the
stock at an even deeper discount.

Phase 1: Bulk-download 30 days of OHLCV for all S&P 500 tickers. Find the
         top N tickers by worst single-day percentage decline.

Phase 2: Full CSP option chain scan on those N tickers only, identical to
         the normal scanner logic but with extra dip-specific fields
         (day_change_pct, vol_ratio, pct_from_52w_low) injected into each
         contract record.

Writes:
    docs/dip/data.json  — accepted + rejected contracts with dip fields
    docs/dip/meta.json  — scan metadata including loser_list

Run:
    python scripts/fetch_dip.py
    python scripts/fetch_dip.py --sp500-tickers config/tickers_sp500.txt --out-dir docs/dip
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf
from scipy.stats import norm

# ---------------------------------------------------------------------------
# Config — slightly wider delta cap for dip buys (underlying already fell,
# so even 20%-delta puts provide meaningful cushion on top of the drop).
# ---------------------------------------------------------------------------
CONFIG = {
    "max_delta": 0.20,
    "max_dte": 21,
    "min_dte": 1,
    "min_oi": 100,
    "max_spread_pct": 20.0,
    "max_per_ticker": 3,
    "risk_free_rate": 0.05,
    "exclude_earnings_before_expiry": True,
    "premium_basis": "bid",
    "max_workers": 8,
    "top_n_losers": 20,
    "min_drop_pct": 1.0,        # only consider tickers down at least this %
    "vol_spike_threshold": 2.0, # vol_ratio above this = spike flag
    "near_low_threshold": 10.0, # pct_from_52w_low below this = near 52W low
}

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SP500_TICKERS = ROOT / "config" / "tickers_sp500.txt"
DEFAULT_OUT_DIR = ROOT / "docs" / "dip"


# ---------------------------------------------------------------------------
# Helpers (mirrors fetch.py).
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


def bs_put_delta(spot: float, strike: float, t_years: float,
                 r: float, sigma: float) -> float | None:
    if t_years <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return None
    try:
        d1 = (math.log(spot / strike) + (r + 0.5 * sigma ** 2) * t_years) \
            / (sigma * math.sqrt(t_years))
        return float(norm.cdf(d1) - 1.0)
    except (ValueError, ZeroDivisionError):
        return None


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
    try:
        ed = tk.get_earnings_dates(limit=8)
        if ed is not None and not ed.empty:
            today = date.today()
            future = [d.date() for d in ed.index.to_pydatetime() if d.date() >= today]
            if future:
                return min(future)
    except Exception:
        pass
    try:
        cal = tk.calendar
        if cal:
            ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
            if ed:
                candidate = ed[0] if isinstance(ed, list) and ed else ed
                if hasattr(candidate, "date"):
                    candidate = candidate.date()
                if isinstance(candidate, date):
                    return candidate
    except Exception:
        pass
    return None


def score_contract(c: dict) -> tuple[float, list[str]]:
    notes: list[str] = []

    ann = c["annualized_premium_pct"]
    premium_score = min(25.0, max(0.0, ann / 50.0 * 25.0))

    disc = c["assignment_discount_pct"]
    cushion_score = min(25.0, max(0.0, disc / 15.0 * 25.0))
    if disc < 0:
        notes.append("Strike above spot (ITM)")

    delta_abs = c["delta_pct"]
    delta_score = max(0.0, (CONFIG["max_delta"] * 100.0 - delta_abs)
                      / (CONFIG["max_delta"] * 100.0) * 20.0)

    oi = max(1, c["open_interest"])
    oi_score = min(10.0, max(0.0, (math.log10(oi) - 2.0) / 2.0 * 5.0 + 5.0))
    spread = c["spread_pct"]
    spread_score = max(0.0, (20.0 - spread) / 20.0 * 5.0)
    liquidity_score = oi_score + spread_score

    days_to_earn = c.get("days_until_earnings")
    dte = c["dte"]
    if days_to_earn is None:
        earnings_score = 12.0
        notes.append("Earnings date unknown")
    elif days_to_earn < 0:
        earnings_score = 15.0
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

    total = premium_score + cushion_score + delta_score + liquidity_score + earnings_score
    return round(min(100.0, max(0.0, total)), 1), notes


# ---------------------------------------------------------------------------
# Phase 1 — bulk download to identify biggest daily losers.
# ---------------------------------------------------------------------------
def get_loser_metrics(
    sp500_tickers: list[str],
    top_n: int,
    min_drop: float,
) -> dict[str, dict]:
    """
    Returns {ticker: {'day_change_pct': float, 'vol_ratio': float}}
    for the top_n S&P 500 tickers with the worst single-day % change,
    provided the drop is at least min_drop %.
    """
    print(f"[phase1] bulk-downloading 30d OHLCV for {len(sp500_tickers)} tickers…",
          flush=True)
    try:
        raw = yf.download(
            sp500_tickers,
            period="30d",
            auto_adjust=True,
            progress=False,
        )
    except Exception as e:
        print(f"[phase1] bulk download failed: {e}", file=sys.stderr)
        return {}

    try:
        closes = raw["Close"]
        volumes = raw["Volume"]
    except KeyError as e:
        print(f"[phase1] unexpected data shape: {e}", file=sys.stderr)
        return {}

    # Ensure DataFrame (yfinance returns Series for single ticker).
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=sp500_tickers[0])
        volumes = volumes.to_frame(name=sp500_tickers[0])

    if len(closes) < 2:
        print("[phase1] not enough rows in bulk data", file=sys.stderr)
        return {}

    today_close = closes.iloc[-1]
    prev_close = closes.iloc[-2]
    today_vol = volumes.iloc[-1]
    # Average of all days except today (~21 trading days from 30 calendar days).
    avg_vol = volumes.iloc[:-1].mean().replace(0, float("nan"))

    change_pct = ((today_close - prev_close) / prev_close.replace(0, float("nan"))) * 100.0
    vol_ratio = (today_vol / avg_vol).fillna(1.0)

    valid = change_pct.dropna()
    losers = valid[valid <= -min_drop].nsmallest(top_n)

    result: dict[str, dict] = {}
    for ticker in losers.index:
        ticker_str = str(ticker)
        result[ticker_str] = {
            "day_change_pct": round(float(change_pct[ticker]), 2),
            "vol_ratio": round(float(vol_ratio.get(ticker, 1.0)), 2),
        }

    print(f"[phase1] {len(result)} tickers down ≥{min_drop}% — scanning options",
          flush=True)
    return result


# ---------------------------------------------------------------------------
# Phase 2 — per-ticker CSP scan with dip fields injected.
# ---------------------------------------------------------------------------
def process_ticker_dip(
    symbol: str,
    dip_info: dict,
) -> tuple[list[dict], list[dict], dict]:
    """
    Full CSP option-chain scan for one ticker.
    Injects day_change_pct, vol_ratio, pct_from_52w_low into each contract.
    Never raises; always returns (accepted, rejected, meta).
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

        # 52-week low (for the dip-specific display column).
        low_52w = _safe_float(info.get("fiftyTwoWeekLow"))
        if low_52w > 0 and spot:
            pct_from_52w_low: float | None = round((spot / low_52w - 1.0) * 100.0, 1)
        else:
            pct_from_52w_low = None

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

                mid = (bid + ask) / 2.0
                spread_pct = ((ask - bid) / mid) * 100.0 if mid > 0 else 999.0
                if spread_pct > CONFIG["max_spread_pct"]:
                    rejected.append({**base, "reason": "Spread too wide"})
                    continue

                if oi < CONFIG["min_oi"]:
                    rejected.append({**base, "reason": "Low liquidity (OI)"})
                    continue

                delta = bs_put_delta(spot, strike, t_years,
                                     CONFIG["risk_free_rate"], iv)
                if delta is None:
                    rejected.append({**base, "reason": "Missing delta"})
                    continue
                delta_abs = abs(delta)
                if delta_abs > CONFIG["max_delta"]:
                    rejected.append({
                        **base,
                        "reason": f"Delta above {CONFIG['max_delta']*100:.0f}%"
                                  f" ({delta_abs * 100:.1f}%)",
                    })
                    continue

                days_until_earnings = None
                earnings_risk = False
                if next_earnings is not None:
                    days_until_earnings = (next_earnings - today).days
                    if 0 <= days_until_earnings <= dte:
                        earnings_risk = True

                if earnings_risk and CONFIG["exclude_earnings_before_expiry"]:
                    rejected.append({**base, "reason": "Earnings before expiration"})
                    continue

                premium = bid if CONFIG["premium_basis"] == "bid" else mid
                cash_required = strike * 100.0
                breakeven = strike - premium
                assignment_discount_pct = ((spot - strike) / spot) * 100.0
                annualized_premium_pct = (premium / strike) * (365.0 / dte) * 100.0

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
                    # Dip-specific fields.
                    "day_change_pct": dip_info.get("day_change_pct"),
                    "vol_ratio": dip_info.get("vol_ratio"),
                    "pct_from_52w_low": pct_from_52w_low,
                }
                score, notes = score_contract(contract)
                contract["score"] = score
                contract["notes"] = "; ".join(notes)
                accepted.append(contract)

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
        traceback.print_exc()
        return accepted, rejected, meta


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def load_tickers(path: Path) -> list[str]:
    if not path.exists():
        print(f"[fatal] tickers file missing: {path}", file=sys.stderr)
        sys.exit(1)
    out, seen = [], set()
    for line in path.read_text().splitlines():
        s = line.strip().upper()
        if not s or s.startswith("#"):
            continue
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sp500-tickers", type=Path, default=DEFAULT_SP500_TICKERS,
                        help="Path to S&P 500 ticker file (one symbol per line).")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR,
                        help="Directory to write data.json and meta.json into.")
    parser.add_argument("--top-n", type=int, default=CONFIG["top_n_losers"],
                        help="Number of biggest daily losers to scan.")
    parser.add_argument("--min-drop", type=float, default=CONFIG["min_drop_pct"],
                        help="Minimum % decline to qualify as a loser.")
    parser.add_argument("--label", default="",
                        help="Free-text label written into meta.json.")
    args = parser.parse_args()

    CONFIG["top_n_losers"] = args.top_n
    CONFIG["min_drop_pct"] = args.min_drop

    data_out = args.out_dir / "data.json"
    meta_out = args.out_dir / "meta.json"

    start = time.time()
    sp500_tickers = load_tickers(args.sp500_tickers)

    # Phase 1: find today's biggest losers.
    loser_metrics = get_loser_metrics(sp500_tickers, args.top_n, args.min_drop)
    if not loser_metrics:
        print("[warn] no losers found — market may be closed or data unavailable",
              flush=True)

    losers_list = sorted(loser_metrics.items(), key=lambda x: x[1]["day_change_pct"])

    # Phase 2: full CSP scan on the losers.
    all_accepted: list[dict] = []
    all_rejected: list[dict] = []
    ticker_meta: list[dict] = []

    with ThreadPoolExecutor(max_workers=CONFIG["max_workers"]) as pool:
        futures = {pool.submit(process_ticker_dip, sym, metrics): sym
                   for sym, metrics in loser_metrics.items()}
        n = len(futures)
        for i, fut in enumerate(as_completed(futures), 1):
            sym = futures[fut]
            try:
                acc, rej, meta = fut.result()
            except Exception as e:
                print(f"[warn] {sym}: unhandled {e}", flush=True)
                all_rejected.append({"ticker": sym, "reason": f"Unhandled: {e}"})
                ticker_meta.append({"symbol": sym, "ok": False, "error": str(e)})
                continue
            all_accepted.extend(acc)
            all_rejected.extend(rej)
            ticker_meta.append(meta)
            chg = loser_metrics[sym]["day_change_pct"]
            print(f"[{i}/{n}] {sym} ({chg:+.1f}%): "
                  f"{len(acc)} accepted, {len(rej)} rejected", flush=True)

    # Global ranking.
    all_accepted.sort(key=lambda c: c["score"], reverse=True)
    for i, c in enumerate(all_accepted, 1):
        c["rank"] = i

    # Dip-specific summary counts.
    vol_spike_count = sum(
        1 for sym, m in loser_metrics.items()
        if m["vol_ratio"] >= CONFIG["vol_spike_threshold"]
    )
    near_low_count = sum(
        1 for c in all_accepted
        if c.get("pct_from_52w_low") is not None
        and c["pct_from_52w_low"] < CONFIG["near_low_threshold"]
    )
    day_drops = [m["day_change_pct"] for m in loser_metrics.values()]
    avg_day_drop = round(sum(day_drops) / len(day_drops), 2) if day_drops else 0.0
    biggest_drop = round(min(day_drops), 2) if day_drops else 0.0

    data_out.parent.mkdir(parents=True, exist_ok=True)
    data_out.write_text(json.dumps(
        {"accepted": all_accepted, "rejected": all_rejected},
        indent=2, default=str,
    ))

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "label": args.label,
        "tickers_scanned": len(loser_metrics),
        "accepted_count": len(all_accepted),
        "rejected_count": len(all_rejected),
        "stocks_analyzed": len(loser_metrics),
        "avg_day_drop": avg_day_drop,
        "biggest_drop": biggest_drop,
        "vol_spike_count": vol_spike_count,
        "near_52w_low_count": near_low_count,
        "tickers_ok": sum(1 for m in ticker_meta if m.get("ok")),
        "tickers_failed": sum(1 for m in ticker_meta if not m.get("ok")),
        "loser_list": [
            {"ticker": sym, **metrics}
            for sym, metrics in losers_list
        ],
        "config": CONFIG,
        "elapsed_seconds": round(time.time() - start, 1),
    }
    meta_out.write_text(json.dumps(meta, indent=2, default=str))

    print(f"[done] {len(all_accepted)} accepted, {len(all_rejected)} rejected"
          f" in {meta['elapsed_seconds']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
