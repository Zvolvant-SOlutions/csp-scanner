/* CSP Scanner — Dip Buys frontend.
 *
 * Loads data.json + meta.json from the dip/ directory.
 * Extends the base CSP columns with dip-specific fields:
 *   day_change_pct  — today's % change (negative = red)
 *   vol_ratio       — today's volume vs 30-day average
 *   pct_from_52w_low — % above the 52-week low
 *
 * No build step — vanilla JS + Tailwind via CDN.
 */
(() => {
  "use strict";

  const state = {
    accepted: [],
    rejected: [],
    meta: {},
    activeTab: "dip",
    sort: { key: "day_change_pct", dir: "asc" },
    filters: {
      search: "",
      maxDelta: 20,
      maxDte: 21,
      minOi: 100,
      maxSpread: 20,
      excludeEarnings: true,
    },
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

  function dayChangeCell(v) {
    if (v == null || isNaN(v)) return '<span class="text-slate-400">—</span>';
    const cls = v <= -5
      ? "bg-rose-200 text-rose-900"
      : v <= -2
      ? "bg-rose-100 text-rose-800"
      : "bg-amber-100 text-amber-800";
    return `<span class="pill ${cls} font-semibold">${v.toFixed(2)}%</span>`;
  }
  function volRatioCell(v) {
    if (v == null || isNaN(v)) return '<span class="text-slate-400">—</span>';
    const cls = v >= 3
      ? "text-violet-700 font-semibold"
      : v >= 2
      ? "text-blue-700 font-medium"
      : "text-slate-500";
    return `<span class="${cls}">${v.toFixed(1)}x</span>`;
  }
  function lowPctCell(v) {
    if (v == null) return '<span class="text-slate-400">—</span>';
    const cls = v < 5
      ? "text-rose-700 font-semibold"
      : v < 15
      ? "text-amber-700 font-medium"
      : "text-slate-600";
    return `<span class="${cls}">+${v.toFixed(1)}%</span>`;
  }
  function deltaCell(v) {
    let cls = "text-emerald-700 bg-emerald-50";
    if (v >= 10) cls = "text-amber-700 bg-amber-50";
    if (v >= 16) cls = "text-rose-700 bg-rose-50";
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

  // ----- Column definitions -----
  const COLS_ACCEPTED = [
    { key: "rank", label: "#", type: "number", align: "right" },
    { key: "ticker", label: "Ticker", type: "string", align: "left",
      render: (r) => `<span class="font-mono font-semibold">${r.ticker}</span>` },
    { key: "company_name", label: "Company", type: "string", align: "left",
      render: (r) => `<span class="text-slate-600 text-xs">${escapeHTML(truncate(r.company_name, 22))}</span>` },
    { key: "current_price", label: "Price", type: "number", align: "right",
      render: (r) => fmtMoney(r.current_price) },
    // Dip-specific columns — front and centre.
    { key: "day_change_pct", label: "Day Chg", type: "number", align: "right",
      render: (r) => dayChangeCell(r.day_change_pct) },
    { key: "vol_ratio", label: "Vol Ratio", type: "number", align: "right",
      render: (r) => volRatioCell(r.vol_ratio) },
    { key: "pct_from_52w_low", label: "↑52W Lo", type: "number", align: "right",
      render: (r) => lowPctCell(r.pct_from_52w_low) },
    // Standard CSP columns.
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
  const TAB_PRESETS = {
    dip:      { sort: { key: "day_change_pct", dir: "asc" }, filter: () => true },
    best:     { sort: { key: "score", dir: "desc" }, filter: () => true },
    ann:      { sort: { key: "annualized_premium_pct", dir: "desc" }, filter: () => true },
    nearlow:  { sort: { key: "pct_from_52w_low", dir: "asc" }, filter: () => true },
    volspike: { sort: { key: "vol_ratio", dir: "desc" }, filter: () => true },
    earnsafe: { sort: { key: "score", dir: "desc" },
                filter: (r) => !r.earnings_risk && (r.days_until_earnings == null || r.days_until_earnings > r.dte + 7) },
    rejected: { sort: { key: "ticker", dir: "asc" }, filter: () => true, isRejected: true },
  };

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
        premium_dollars: Math.round((r.premium || 0) * 100),
      }));
      state.rejected = data.rejected || [];
      state.meta = meta;
    } catch (err) {
      console.error("[dip] failed to load data:", err);
      document.getElementById("table-body").innerHTML = `
        <tr><td colspan="99" class="p-6 text-center text-rose-600">
          Failed to load data.json. Run <code>python scripts/fetch_dip.py</code> first.
        </td></tr>`;
    }
    renderSummary();
    renderLoserBadges();
    render();
  }

  // ----- Summary cards -----
  function renderSummary() {
    const m = state.meta || {};
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val ?? "—";
    };
    set("card-scanned", m.stocks_analyzed);
    set("card-drop", m.avg_day_drop != null ? `${m.avg_day_drop.toFixed(1)}%` : null);
    set("card-accepted", m.accepted_count ?? state.accepted.length);
    set("card-rejected", m.rejected_count ?? state.rejected.length);
    set("card-volspike", m.vol_spike_count);
    set("card-nearlow", m.near_52w_low_count);
    if (m.last_updated) {
      const d = new Date(m.last_updated);
      set("last-updated", d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }));
    }
    if (m.elapsed_seconds != null) {
      set("elapsed-info", `Scan took ${m.elapsed_seconds}s`);
    }
  }

  // ----- Loser badges strip -----
  function renderLoserBadges() {
    const list = state.meta?.loser_list;
    const container = document.getElementById("loser-badges");
    if (!container || !list || !list.length) return;
    container.innerHTML = list.map((item) => {
      const chg = item.day_change_pct != null ? item.day_change_pct.toFixed(2) : "?";
      const vol = item.vol_ratio != null ? ` · ${item.vol_ratio.toFixed(1)}x vol` : "";
      const intensity = item.day_change_pct <= -5 ? "bg-rose-100 border-rose-300 text-rose-800"
                      : item.day_change_pct <= -2 ? "bg-rose-50 border-rose-200 text-rose-700"
                      : "bg-amber-50 border-amber-200 text-amber-700";
      return `<span class="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-mono ${intensity}">
        <span class="font-semibold">${escapeHTML(item.ticker)}</span>
        <span class="opacity-75">${chg}%${vol}</span>
      </span>`;
    }).join("");
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

    let rows = isRejected
      ? applyRejectedFilters(state.rejected)
      : applyFilters(state.accepted.filter(preset.filter));

    const sortKey = state.sort.userSet ? state.sort.key : preset.sort.key;
    const sortDir = state.sort.userSet ? state.sort.dir : preset.sort.dir;
    rows = sortRows(rows, sortKey, sortDir);

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
