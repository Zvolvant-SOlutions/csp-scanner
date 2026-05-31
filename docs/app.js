/* CSP Scanner frontend.
 *
 * Loads data.json + meta.json (refreshed twice daily by GitHub Actions),
 * applies user filters + tab presets, and renders a sortable table.
 *
 * No build step — vanilla JS + Tailwind via CDN.
 */
(() => {
  "use strict";

  // ----- State -----
  const state = {
    accepted: [],
    rejected: [],
    meta: {},
    activeTab: "best",
    sort: { key: "score", dir: "desc" },
    filters: {
      search: "",
      maxDelta: 15,
      maxDte: 21,
      minOi: 100,
      maxSpread: 20,
      excludeEarnings: true,
    },
  };

  // ----- Column definitions per view -----
  // key      : object property
  // label    : header text
  // type     : number | string | date — controls sorting
  // render   : optional cell renderer; defaults to text
  // align    : left|right (right for numeric)
  // accepted view shares these columns; rejected has its own set.
  const COLS_ACCEPTED = [
    { key: "rank", label: "#", type: "number", align: "right" },
    { key: "ticker", label: "Ticker", type: "string", align: "left",
      render: (r) => `<span class="font-mono font-semibold">${r.ticker}</span>` },
    { key: "company_name", label: "Company", type: "string", align: "left",
      render: (r) => `<span class="text-slate-600 text-xs">${escapeHTML(truncate(r.company_name, 24))}</span>` },
    { key: "current_price", label: "Price", type: "number", align: "right",
      render: (r) => fmtMoney(r.current_price) },
    { key: "strike", label: "Target", type: "number", align: "right",
      render: (r) => `<span class="font-medium">${fmtMoney(r.strike)}</span>` },
    { key: "premium_dollars", label: "Prem $", type: "number", align: "right",
      render: (r) => `<span class="text-emerald-700 font-medium">${fmtMoney(r.premium_dollars, 0)}</span>` },
    { key: "expiration", label: "Expiry", type: "date", align: "left",
      render: (r) => `<span class="font-mono text-xs">${r.expiration}</span>` },
    { key: "dte", label: "DTE", type: "number", align: "right" },
    { key: "bid", label: "Bid", type: "number", align: "right",
      render: (r) => fmtMoney(r.bid) },
    { key: "ask", label: "Ask", type: "number", align: "right",
      render: (r) => fmtMoney(r.ask) },
    { key: "mid", label: "Mid", type: "number", align: "right",
      render: (r) => fmtMoney(r.mid) },
    { key: "premium_used", label: "Prem Basis", type: "string", align: "left",
      render: (r) => `<span class="text-xs text-slate-500">${r.premium_used}</span>` },
    { key: "delta_pct", label: "Delta", type: "number", align: "right",
      render: (r) => deltaCell(r.delta_pct) },
    { key: "iv_pct", label: "IV", type: "number", align: "right",
      render: (r) => `${r.iv_pct.toFixed(1)}%` },
    { key: "open_interest", label: "OI", type: "number", align: "right",
      render: (r) => fmtInt(r.open_interest) },
    { key: "volume", label: "Vol", type: "number", align: "right",
      render: (r) => fmtInt(r.volume) },
    { key: "spread_pct", label: "Spread", type: "number", align: "right",
      render: (r) => spreadCell(r.spread_pct) },
    { key: "cash_required", label: "Cash Req", type: "number", align: "right",
      render: (r) => fmtMoney(r.cash_required, 0) },
    { key: "breakeven", label: "Breakeven", type: "number", align: "right",
      render: (r) => fmtMoney(r.breakeven) },
    { key: "assignment_discount_pct", label: "Cushion", type: "number", align: "right",
      render: (r) => cushionCell(r.assignment_discount_pct) },
    { key: "annualized_premium_pct", label: "Ann %", type: "number", align: "right",
      render: (r) => annCell(r.annualized_premium_pct) },
    { key: "next_earnings", label: "Next Earnings", type: "date", align: "left",
      render: (r) => earningsCell(r) },
    { key: "days_until_earnings", label: "Days→Earn", type: "number", align: "right",
      render: (r) => r.days_until_earnings == null
        ? '<span class="text-slate-400">—</span>'
        : `${r.days_until_earnings}` },
    { key: "earnings_risk", label: "Earn Risk", type: "string", align: "left",
      render: (r) => r.earnings_risk
        ? '<span class="pill bg-rose-100 text-rose-700">Risk</span>'
        : (r.next_earnings
            ? '<span class="pill bg-emerald-100 text-emerald-700">Clear</span>'
            : '<span class="pill bg-amber-100 text-amber-700">Unknown</span>') },
    { key: "score", label: "Score", type: "number", align: "right",
      render: (r) => scoreCell(r.score) },
    { key: "notes", label: "Notes", type: "string", align: "left",
      render: (r) => `<span class="text-xs text-slate-500">${escapeHTML(r.notes || "")}</span>` },
  ];

  const COLS_REJECTED = [
    { key: "ticker", label: "Ticker", type: "string", align: "left",
      render: (r) => `<span class="font-mono font-semibold">${r.ticker}</span>` },
    { key: "expiration", label: "Expiry", type: "date", align: "left",
      render: (r) => r.expiration ? `<span class="font-mono text-xs">${r.expiration}</span>` : '<span class="text-slate-400">—</span>' },
    { key: "strike", label: "Strike", type: "number", align: "right",
      render: (r) => r.strike ? fmtMoney(r.strike) : '<span class="text-slate-400">—</span>' },
    { key: "dte", label: "DTE", type: "number", align: "right",
      render: (r) => r.dte != null ? r.dte : '<span class="text-slate-400">—</span>' },
    { key: "bid", label: "Bid", type: "number", align: "right",
      render: (r) => r.bid != null ? fmtMoney(r.bid) : '<span class="text-slate-400">—</span>' },
    { key: "ask", label: "Ask", type: "number", align: "right",
      render: (r) => r.ask != null ? fmtMoney(r.ask) : '<span class="text-slate-400">—</span>' },
    { key: "reason", label: "Reason", type: "string", align: "left",
      render: (r) => `<span class="pill bg-rose-50 text-rose-700">${escapeHTML(r.reason || "")}</span>` },
  ];

  // ----- Tab presets -----
  // Each tab returns a filtered+sorted view of the accepted dataset.
  const TAB_PRESETS = {
    best:      { sort: { key: "score", dir: "desc" }, filter: () => true,
                 sortDefault: true },
    safest:    { sort: { key: "delta_pct", dir: "asc" }, filter: () => true },
    ann:       { sort: { key: "annualized_premium_pct", dir: "desc" }, filter: () => true },
    cushion:   { sort: { key: "assignment_discount_pct", dir: "desc" }, filter: () => true },
    liquidity: { sort: { key: "open_interest", dir: "desc" }, filter: () => true },
    earnsafe:  { sort: { key: "score", dir: "desc" },
                 filter: (r) => !r.earnings_risk && (r.days_until_earnings == null || r.days_until_earnings > r.dte + 7) },
    rejected:  { sort: { key: "ticker", dir: "asc" }, filter: () => true, isRejected: true },
  };

  // ----- Formatters -----
  function fmtMoney(v, digits = 2) {
    if (v == null || isNaN(v)) return '<span class="text-slate-400">—</span>';
    return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
  function fmtInt(v) {
    if (v == null) return '<span class="text-slate-400">—</span>';
    return Number(v).toLocaleString("en-US");
  }
  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function truncate(s, n) {
    s = s || "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function deltaCell(v) {
    let cls = "text-emerald-700 bg-emerald-50";
    if (v >= 10) cls = "text-amber-700 bg-amber-50";
    if (v >= 13) cls = "text-rose-700 bg-rose-50";
    return `<span class="pill ${cls}">${v.toFixed(1)}%</span>`;
  }
  function spreadCell(v) {
    let cls = "text-emerald-700";
    if (v >= 10) cls = "text-amber-700";
    if (v >= 15) cls = "text-rose-700";
    return `<span class="${cls}">${v.toFixed(1)}%</span>`;
  }
  function cushionCell(v) {
    if (v < 0) return `<span class="text-rose-700 font-medium">${v.toFixed(2)}%</span>`;
    if (v < 5) return `<span class="text-amber-700">${v.toFixed(2)}%</span>`;
    return `<span class="text-emerald-700 font-medium">${v.toFixed(2)}%</span>`;
  }
  function annCell(v) {
    let cls = "text-slate-700";
    if (v >= 20) cls = "text-emerald-700 font-medium";
    if (v >= 40) cls = "text-emerald-800 font-semibold";
    return `<span class="${cls}">${v.toFixed(1)}%</span>`;
  }
  function earningsCell(r) {
    if (!r.next_earnings) return '<span class="text-amber-600 text-xs">Unknown</span>';
    const cls = r.earnings_risk ? "text-rose-700 font-medium" : "text-slate-700";
    return `<span class="font-mono text-xs ${cls}">${r.next_earnings}</span>`;
  }
  function scoreCell(v) {
    let barColor = "bg-rose-500";
    let textColor = "text-rose-700";
    if (v >= 50) { barColor = "bg-amber-500"; textColor = "text-amber-700"; }
    if (v >= 70) { barColor = "bg-emerald-500"; textColor = "text-emerald-700"; }
    return `<div class="flex items-center gap-2 justify-end">
      <div class="score-bar"><div class="${barColor}" style="width:${Math.min(100, Math.max(0, v))}%"></div></div>
      <span class="font-semibold ${textColor} num">${v.toFixed(0)}</span>
    </div>`;
  }

  // ----- Data loading -----
  async function loadData() {
    const noCache = `?t=${Date.now()}`;
    try {
      const [dataResp, metaResp] = await Promise.all([
        fetch(`data.json${noCache}`),
        fetch(`meta.json${noCache}`),
      ]);
      if (!dataResp.ok) throw new Error(`data.json: ${dataResp.status}`);
      const data = await dataResp.json();
      const meta = metaResp.ok ? await metaResp.json() : {};
      state.accepted = (data.accepted || []).map((r) => ({
        ...r,
        // Dollars collected per CSP contract (one contract = 100 shares).
        premium_dollars: Math.round((r.premium || 0) * 100),
      }));
      state.rejected = data.rejected || [];
      state.meta = meta;
    } catch (err) {
      console.error("[csp] failed to load data:", err);
      document.getElementById("table-body").innerHTML = `
        <tr><td colspan="99" class="p-6 text-center text-rose-600">
          Failed to load data.json. Run <code>python scripts/fetch.py</code> first.
        </td></tr>`;
    }
    renderSummary();
    render();
  }

  // ----- Summary cards -----
  function renderSummary() {
    const m = state.meta || {};
    document.getElementById("card-scanned").textContent = m.tickers_scanned ?? "—";
    document.getElementById("card-accepted").textContent = m.accepted_count ?? state.accepted.length;
    document.getElementById("card-rejected").textContent = m.rejected_count ?? state.rejected.length;
    document.getElementById("card-missing-delta").textContent = m.missing_delta_count ?? "—";
    document.getElementById("card-missing-earnings").textContent = m.missing_earnings_count ?? "—";
    document.getElementById("card-failed").textContent = m.tickers_failed ?? "—";
    if (m.last_updated) {
      const d = new Date(m.last_updated);
      document.getElementById("last-updated").textContent =
        d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    }
    if (m.elapsed_seconds != null) {
      document.getElementById("elapsed-info").textContent =
        `Scan took ${m.elapsed_seconds}s`;
    }
  }

  // ----- Filtering / sorting -----
  function applyFilters(rows) {
    const f = state.filters;
    const term = f.search.trim().toUpperCase();
    return rows.filter((r) => {
      if (term && !r.ticker.includes(term)) return false;
      if (r.delta_pct != null && r.delta_pct > f.maxDelta) return false;
      if (r.dte != null && r.dte > f.maxDte) return false;
      if (r.open_interest != null && r.open_interest < f.minOi) return false;
      if (r.spread_pct != null && r.spread_pct > f.maxSpread) return false;
      if (f.excludeEarnings && r.earnings_risk) return false;
      return true;
    });
  }

  function applyRejectedFilters(rows) {
    const f = state.filters;
    const term = f.search.trim().toUpperCase();
    return rows.filter((r) => !term || (r.ticker || "").includes(term));
  }

  function sortRows(rows, key, dir) {
    const mult = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
      return String(va).localeCompare(String(vb)) * mult;
    });
  }

  // ----- Render -----
  function render() {
    const preset = TAB_PRESETS[state.activeTab];
    const isRejected = !!preset.isRejected;
    const cols = isRejected ? COLS_REJECTED : COLS_ACCEPTED;

    // Filters section is shown for accepted tabs; partially relevant for rejected.
    let rows = isRejected
      ? applyRejectedFilters(state.rejected)
      : applyFilters(state.accepted.filter(preset.filter));

    // Sort: user-clicked sort wins; otherwise preset sort.
    const sortKey = state.sort.userSet ? state.sort.key : preset.sort.key;
    const sortDir = state.sort.userSet ? state.sort.dir : preset.sort.dir;
    rows = sortRows(rows, sortKey, sortDir);

    // Header.
    const headRow = cols.map((c) => {
      const isSorted = c.key === sortKey;
      const cls = [
        "sortable", "px-3 py-2 text-xs font-semibold uppercase tracking-wider",
        c.align === "right" ? "text-right" : "text-left",
        isSorted ? `sorted-${sortDir}` : "",
      ].join(" ");
      const indicator = isSorted ? (sortDir === "asc" ? "▲" : "▼") : "↕";
      return `<th class="${cls}" data-key="${c.key}">
        <span>${c.label}</span>
        <span class="sort-indicator">${indicator}</span>
      </th>`;
    }).join("");
    document.getElementById("table-head").innerHTML = `<tr>${headRow}</tr>`;

    // Body.
    const body = document.getElementById("table-body");
    if (rows.length === 0) {
      body.innerHTML = "";
      document.getElementById("empty-state").classList.remove("hidden");
    } else {
      document.getElementById("empty-state").classList.add("hidden");
      body.innerHTML = rows.map((r) => {
        const cells = cols.map((c) => {
          const val = c.render ? c.render(r) : escapeHTML(r[c.key] ?? "");
          const align = c.align === "right" ? "text-right num" : "text-left";
          return `<td class="px-3 py-2 ${align}">${val}</td>`;
        }).join("");
        return `<tr class="row">${cells}</tr>`;
      }).join("");
    }

    document.getElementById("row-count").textContent =
      `${rows.length} row${rows.length === 1 ? "" : "s"}`;

    // Wire up header click sort.
    document.querySelectorAll("#table-head th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (state.sort.key === key && state.sort.userSet) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort.key = key;
          state.sort.dir = "desc";
        }
        state.sort.userSet = true;
        render();
      });
    });
  }

  // ----- Tabs / filters wiring -----
  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => {
          b.classList.remove("border-blue-600", "text-blue-700");
          b.classList.add("border-transparent", "text-slate-600");
        });
        btn.classList.add("border-blue-600", "text-blue-700");
        btn.classList.remove("border-transparent", "text-slate-600");
        state.activeTab = btn.dataset.tab;
        // Reset user-clicked sort so each tab opens with its preset sort.
        state.sort = { key: null, dir: null, userSet: false };
        render();
      });
    });
  }

  function wireFilters() {
    const onChange = () => {
      state.filters.search = document.getElementById("f-search").value || "";
      state.filters.maxDelta = parseFloat(document.getElementById("f-max-delta").value) || 100;
      state.filters.maxDte = parseFloat(document.getElementById("f-max-dte").value) || 365;
      state.filters.minOi = parseFloat(document.getElementById("f-min-oi").value) || 0;
      state.filters.maxSpread = parseFloat(document.getElementById("f-max-spread").value) || 100;
      state.filters.excludeEarnings = document.getElementById("f-exclude-earn").checked;
      render();
    };
    ["f-search", "f-max-delta", "f-max-dte", "f-min-oi", "f-max-spread"]
      .forEach((id) => document.getElementById(id).addEventListener("input", onChange));
    document.getElementById("f-exclude-earn").addEventListener("change", onChange);
  }

  // ----- Init -----
  document.addEventListener("DOMContentLoaded", () => {
    wireTabs();
    wireFilters();
    loadData();
  });
})();
