# CSP Scanner

A clean cash-secured put scanner that **strictly filters for ≤15% delta put
options expiring within 21 days**, scores each contract 0–100 across five
dimensions, and limits results to the top three per ticker.

Built as a static site on GitHub Pages. Data is refreshed automatically by
GitHub Actions at **14:00 UTC and 18:00 UTC** on weekdays (≈ 10 AM / 2 PM ET
during EDT) and committed back to the repo as `docs/data.json`.

---

## Strategy logic

This scanner is **conservative on purpose**. It does not optimize for raw
premium. The scoring algorithm balances five components:

| Component                | Max points | What earns it                                     |
|--------------------------|-----------:|---------------------------------------------------|
| Premium efficiency       | 25         | Higher annualized return on cash secured          |
| Assignment cushion       | 25         | Larger discount from spot to strike               |
| Delta safety             | 20         | Lower delta (0% → 20pt, 15% → 0pt)                |
| Liquidity                | 15         | Higher OI, tighter bid/ask spread                 |
| Earnings risk            | 15         | No earnings before expiry (Unknown → mild penalty)|

A contract with high premium but poor liquidity, upcoming earnings, or a
strike too close to the current price will not rank highly.

### Hard filters (a contract is excluded if any fail)

- Put options only
- Expiration within 21 calendar days
- Absolute delta ≤ **0.15**
- Bid > 0
- Open interest ≥ **100** (configurable)
- Bid/ask spread ≤ **20%** of mid (configurable)
- All of: bid, ask, last, OI, volume, strike, expiration, IV must be present
- Earnings before expiration → excluded (toggle in `scripts/fetch.py`)

Delta is computed locally with **Black-Scholes** because yfinance does not
return greeks. Inputs: spot, strike, DTE, implied volatility, and a 5%
risk-free rate. Accurate enough for filtering at the ≤15% delta cutoff.

---

## Repo layout

```
csp-scanner/
├── .github/workflows/refresh.yml   # 2x-daily cron + commit
├── config/tickers.txt              # editable ticker universe
├── scripts/fetch.py                # main fetcher + scorer
├── docs/                           # GitHub Pages root
│   ├── index.html
│   ├── app.js
│   ├── data.json                   # generated
│   └── meta.json                   # generated
├── requirements.txt
└── README.md
```

---

## Running locally

```bash
# 1. Install deps
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Fetch fresh data
python scripts/fetch.py

# 3. Serve the static dashboard
cd docs && python -m http.server 8000
# open http://localhost:8000
```

The scan takes roughly 60–120 seconds for the default ~80-ticker universe
using 8 parallel workers (rate-limited by Yahoo Finance).

---

## Configuring

### Ticker list
Edit `config/tickers.txt`. One symbol per line. Lines starting with `#` are
comments. The defaults are large-cap optionable names + popular ETFs.

### Filter thresholds and scoring knobs
Edit the `CONFIG` dict at the top of `scripts/fetch.py`:

```python
CONFIG = {
    "max_delta": 0.15,
    "max_dte": 21,
    "min_oi": 100,
    "max_spread_pct": 20.0,
    "max_per_ticker": 3,
    "risk_free_rate": 0.05,
    "exclude_earnings_before_expiry": True,
    "premium_basis": "bid",     # "bid" or "mid"
    "max_workers": 8,
}
```

The dashboard also exposes live filters (max delta, max DTE, min OI, max
spread, exclude-earnings toggle) so you can re-slice without re-running the
fetch.

---

## Deploying to GitHub Pages

This repo is already wired up. The workflow (`.github/workflows/refresh.yml`)
fetches fresh data **inside** the Action, then uploads the generated
`docs/` folder as a Pages artifact and deploys it via
`actions/deploy-pages`. No commits are pushed back to `main` — the live
data lives in the deployed Pages artifact.

To set this up from scratch:

1. Push the repo to GitHub (public).
2. **Settings → Pages** → Source: **GitHub Actions** → Save.
3. Done — the workflow runs on push, twice a day on weekdays, and
   on-demand via **Actions → Refresh CSP data and deploy → Run workflow**.

Live URL: `https://<org>.github.io/<repo>/`

---

## Dashboard

Summary cards: tickers scanned, accepted, rejected, missing delta, missing
earnings, tickers that failed.

**Tabs / filters:**

- **Best Overall** — sorted by total score
- **Safest Delta** — sorted by lowest delta
- **Highest Annualized** — sorted by annualized return on cash
- **Best Cushion** — sorted by assignment discount
- **Best Liquidity** — sorted by open interest
- **Earnings-Safe** — hides contracts with earnings risk + earnings within a
  week of expiry
- **Rejected / Landmines** — every excluded contract with the reason

Every column header is click-to-sort. Color codes: green = strong, amber =
caution, rose = risk.

---

## Data notes & caveats

- **Source:** [yfinance](https://github.com/ranaroussi/yfinance) — free, no
  API key. Underlying data is Yahoo Finance, which is best-effort. Quotes
  during market hours are 15–20 minutes delayed; after-hours may be stale.
- **Greeks:** delta is computed locally via Black-Scholes (yfinance does not
  return greeks). All other fields come straight from Yahoo.
- **Earnings dates:** pulled via `Ticker.get_earnings_dates()` with a
  fallback to `Ticker.calendar`. Occasionally missing; the UI shows
  *Unknown* and the score applies a mild penalty.
- **Not investment advice.** Always verify quotes, deltas, and earnings
  dates in your broker before placing a trade.
