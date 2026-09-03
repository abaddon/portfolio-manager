/* Data page: the operational panels kept from the original dashboard —
   macro snapshot/trend, price history, news, sentiment, orders, allocation
   targets + review, per-run analysis (expandable) and the event log.
   Read-only; the only mutating action is the shared Run-now button. */
"use strict";

(function () {
  const { $, esc, fmt, pct, timeAgo, fmtTime, api } = PM;

  let macroChart = null;
  let pricesChart = null;
  const expandedRuns = new Set();
  const runDetailCache = new Map();

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const TOK = {
    border: css("--border") || "#2b2f3a",
    muted: css("--muted") || "#8b95ad",
    fg: css("--fg") || "#e6ebf5",
    accent: css("--accent") || "#4f8cff",
    pos: css("--pos") || "#2ecc71",
    neg: css("--neg") || "#e74c3c",
    grid: css("--fg-soft") || "rgba(230,235,245,0.08)",
  };
  const PALETTE = [TOK.accent, TOK.pos, TOK.neg, "oklch(80% 0.12 85)", "oklch(70% 0.12 300)", "oklch(75% 0.1 190)"];
  const chartText = (color) => ({ color, font: { family: "'JetBrains Mono', ui-monospace, Menlo, monospace", size: 11 } });
  const baseOptions = () => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: chartText(TOK.muted) } },
    scales: {
      y: { grid: { color: TOK.grid }, ticks: chartText(TOK.muted) },
      x: { grid: { display: false }, ticks: { ...chartText(TOK.muted), maxTicksLimit: 8 } },
    },
  });

  async function load() {
    const [ov, macro, news, sentiment, orders, targets, runsAnalysis, events] = await Promise.all([
      api("/api/overview"),
      api("/api/macro?limit=60").catch(() => null),
      api("/api/news?limit=15").catch(() => null),
      api("/api/sentiment?limit=10").catch(() => null),
      api("/api/orders?limit=100").catch(() => null),
      api("/api/targets").catch(() => null),
      api("/api/runs-analysis?limit=10").catch(() => null),
      api("/api/events?limit=50").catch(() => null),
    ]);
    const cur = ov.accountCurrency ?? "GBP";
    const priceHistory = ov.priceHistory ?? {};
    renderMacro(macro);
    renderPrices(priceHistory);
    renderNews(news?.news ?? []);
    renderSentiment(sentiment?.sentiment ?? []);
    renderOrders(orders?.orders ?? [], cur);
    renderTargets(targets);
    renderRunsAnalysis(runsAnalysis?.runs ?? []);
    renderEvents(events?.events ?? []);
    $("#foot-right").textContent = `refreshed ${fmtTime(new Date().toISOString())}`;
  }

  /* FRED values are in percent units already (4.33 means 4.33%) — no ×100. */
  const pctUnit = (n) => (n === null || n === undefined ? "—" : `${fmt(n, 2)}%`);

  function renderMacro(macro) {
    const history = macro?.history ?? [];
    const latest = history[0]?.snapshot ?? null;
    const rows = latest
      ? [
          ["S&P 500", fmt(latest.sp500, 2)],
          ["VIX", fmt(latest.vix, 2)],
          ["Fed funds rate", pctUnit(latest.fedFundsRatePct)],
          ["10Y treasury", pctUnit(latest.treasury10yPct)],
          ["2Y treasury", pctUnit(latest.treasury2yPct)],
          ["10Y–2Y spread", pctUnit(latest.yieldSpread10y2yPct)],
          ["CPI YoY", pctUnit(latest.cpiYoYPct)],
          ["Unemployment", pctUnit(latest.unemploymentPct)],
        ].map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="r num"><b>${v}</b></td></tr>`)
      : [];
    $("#macro-table").innerHTML =
      `<thead><tr><th>Indicator</th><th class="r">Latest</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="2" class="sub">no macro snapshot yet (next run)</td></tr>'}</tbody>`;

    const points = history.slice().sort((a, b) => a.snapshot.asOf.localeCompare(b.snapshot.asOf));
    const wrap = $("#macro-wrap");
    if (points.length < 2) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    if (macroChart) macroChart.destroy();
    macroChart = new Chart($("#macro-chart"), {
      type: "line",
      data: {
        labels: points.map((p) => fmtTime(p.snapshot.asOf)),
        datasets: [
          { label: "VIX", data: points.map((p) => p.snapshot.vix), borderColor: TOK.neg, backgroundColor: "transparent", tension: 0.2, pointRadius: 0, spanGaps: true },
          { label: "10Y–2Y spread (%)", data: points.map((p) => p.snapshot.yieldSpread10y2yPct), borderColor: TOK.pos, backgroundColor: "transparent", tension: 0.2, pointRadius: 0, spanGaps: true },
        ],
      },
      options: baseOptions(),
    });
  }

  function renderPrices(history) {
    const tickers = Object.keys(history).filter((t) => (history[t] ?? []).length > 1);
    const wrap = $("#prices-wrap");
    if (tickers.length === 0) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    const allTimes = [...new Set(tickers.flatMap((t) => history[t].map((s) => s.asOf)))].sort();
    const datasets = tickers.map((t, i) => {
      const byTime = new Map(history[t].map((s) => [s.asOf, s.price]));
      return {
        label: t,
        data: allTimes.map((ts) => byTime.get(ts) ?? null),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: "transparent",
        tension: 0.2,
        pointRadius: 0,
        spanGaps: true,
      };
    });
    if (pricesChart) pricesChart.destroy();
    pricesChart = new Chart($("#prices-chart"), {
      type: "line",
      data: { labels: allTimes.map((ts) => fmtTime(ts)), datasets },
      options: baseOptions(),
    });
  }

  function renderNews(news) {
    const rows = news.map((n) => `<tr>
      <td><b>${esc(n.item.ticker)}</b></td>
      <td>${esc(n.item.headline)}</td>
      <td class="muted nowrap">${esc(n.item.source)} · ${esc(timeAgo(n.item.publishedAt))}</td>
    </tr>`);
    $("#news-table").innerHTML =
      `<thead><tr><th>Ticker</th><th>Headline</th><th>Source</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="3" class="sub">no news persisted yet</td></tr>'}</tbody>`;
  }

  function renderSentiment(sentiment) {
    const rows = sentiment.map((s) => `<tr>
      <td><b>${esc(s.score.ticker)}</b></td>
      <td class="num">${s.score.score >= 0 ? "+" : ""}${fmt(s.score.score)}</td>
      <td><span class="pill ${s.score.label.startsWith("very") ? (s.score.score > 0 ? "pill-buy" : "pill-sell") : "pill-hold"}">${esc(s.score.label)}</span></td>
      <td class="muted">${esc(s.score.source)}</td>
    </tr>`);
    $("#sentiment-table").innerHTML =
      `<thead><tr><th>Ticker</th><th>Score</th><th>Label</th><th>Source</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="4" class="sub">no sentiment persisted yet</td></tr>'}</tbody>`;
  }

  function renderOrders(orders, cur) {
    const rows = orders
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => `<tr>
      <td class="nowrap">${esc(fmtTime(o.createdAt))}</td>
      <td><b>${esc(o.ticker)}</b></td>
      <td>${PM.sidePill(o.side)}</td>
      <td class="num">${fmt(o.quantity, 4)}</td>
      <td class="num">${o.fill ? fmt(o.fill.filledPriceAvg) : "—"}</td>
      <td class="num">${o.fill ? fmt(o.fill.filledQuantity, 4) : "—"}</td>
      <td>${PM.orderStatusPill(o.status)}</td>
      <td class="num">${o.fill ? PM.money(o.fill.realizedCost.total, cur) : "—"}</td>
      <td class="sub">${o.error ? `<span class="neg">${esc(o.error)}</span>` : ""}</td>
    </tr>`);
    $("#orders-table").innerHTML =
      `<thead><tr><th>Created</th><th>Ticker</th><th>Side</th><th>Qty</th><th>Fill price</th><th>Filled qty</th><th>Status</th><th>Realised cost</th><th>Error</th></tr></thead>` +
      `<tbody>${rows.join("") || '<tr><td colspan="9" class="sub">no orders yet</td></tr>'}</tbody>`;
  }

  function renderTargets(targets) {
    const base = new Map((targets?.base ?? []).map((t) => [t.ticker, t.weight]));
    const current = new Map((targets?.current ?? []).map((t) => [t.ticker, t.weight]));
    const rows = [...current.keys()].map((ticker) => {
      const from = base.get(ticker);
      const to = current.get(ticker);
      const delta = from !== undefined && to !== undefined ? to - from : null;
      return `<tr>
      <td><b>${esc(ticker)}</b></td>
      <td class="r num">${pct(from ?? null)}</td>
      <td class="r num">${pct(to ?? null)}</td>
      <td class="r num ${(delta ?? 0) > 0 ? "pos" : (delta ?? 0) < 0 ? "neg" : "muted"}">${delta === null ? "—" : (delta >= 0 ? "+" : "") + (delta * 100).toFixed(2) + "%"}</td>
      <td class="muted">${targets?.managedBy === "committee" ? "managed by the committee" : "static"}</td>
    </tr>`;
    });
    $("#targets-table").innerHTML =
      `<thead><tr><th>Ticker</th><th class="r">Seed target</th><th class="r">Current target</th><th class="r">Change</th><th>Mode</th></tr></thead>` +
      `<tbody>${rows.join("") || '<tr><td colspan="5" class="sub">no targets configured</td></tr>'}</tbody>`;

    const recent = (targets?.recent ?? []).slice(0, 10).map((u) => {
      const from = u.from ?? u.originalWeight;
      const delta = u.weight - from;
      return `<tr>
      <td class="nowrap">${esc(fmtTime(u.updatedAt))}</td>
      <td><b>${esc(u.ticker)}</b></td>
      <td class="num">${pct(from)} → ${pct(u.weight)} <span class="${delta > 0 ? "pos" : delta < 0 ? "neg" : "muted"}">(${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%)</span></td>
      <td class="num">${fmt(u.conviction)}</td>
      <td class="rationale">${esc(u.rationale)}</td>
    </tr>`;
    });
    $("#review-table").innerHTML =
      `<thead><tr><th>At</th><th>Ticker</th><th>Target change</th><th>Conviction</th><th>Why</th></tr></thead>` +
      `<tbody>${recent.join("") || '<tr><td colspan="5" class="sub">no target changes yet — the first review happens on the next run</td></tr>'}</tbody>`;
  }

  function renderRunsAnalysis(runs) {
    const rows = (runs ?? []).map((r) => `<tr class="run-row" data-run-id="${esc(r.runId)}">
      <td class="nowrap">${esc(fmtTime(r.startedAt))}${r.marketOpen ? "" : ' <span class="muted">(closed)</span>'}</td>
      <td class="num pos"><b>${r.counts.bullish}</b></td>
      <td class="num muted">${r.counts.neutral}</td>
      <td class="num neg">${r.counts.bearish}</td>
      <td class="num">${fmt(r.avgConfidence)}</td>
      <td class="num">${r.avgAdjustment >= 0 ? "+" : ""}${fmt(r.avgAdjustment, 4)}</td>
      <td>${(r.tickers ?? []).map((t) => `<span class="pill ${t.dominant === "bullish" ? "pill-buy" : t.dominant === "bearish" ? "pill-sell" : "pill-hold"}">${esc(t.ticker)} ${t.dominant === "bullish" ? "↗" : t.dominant === "bearish" ? "↘" : "→"}</span>`).join(" ")}</td>
    </tr>`);
    $("#runs-analysis-table").innerHTML =
      `<thead><tr><th>Run</th><th class="r">Bullish</th><th class="r">Neutral</th><th class="r">Bearish</th><th class="r">Avg confidence</th><th class="r">Avg Δ target</th><th>Tickers (dominant view)</th></tr></thead>` +
      `<tbody>${rows.join("") || '<tr><td colspan="7" class="sub">no analysis runs yet</td></tr>'}</tbody>`;
    for (const runId of expandedRuns) {
      const tr = document.querySelector(`tr.run-row[data-run-id="${runId}"]`);
      if (tr) void toggleRunDetail(tr, runId);
    }
  }

  async function toggleRunDetail(tr, runId) {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains("run-detail")) {
      existing.remove();
      expandedRuns.delete(runId);
      return;
    }
    let detail = runDetailCache.get(runId);
    if (!detail) {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
      if (!res.ok) {
        alert(`run ${runId} not found`);
        return;
      }
      detail = await res.json();
      runDetailCache.set(runId, detail);
    }
    expandedRuns.add(runId);
    const row = document.createElement("tr");
    row.className = "run-detail";
    row.innerHTML = `<td colspan="7">${runAnalysisDetailHtml(detail.analysis ?? [])}</td>`;
    tr.after(row);
  }

  function runAnalysisDetailHtml(reports) {
    const rows = reports
      .slice()
      .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.analyst.localeCompare(b.analyst))
      .map((r) => `<tr>
      <td><b>${esc(r.ticker)}</b></td>
      <td>${esc(r.analyst)}</td>
      <td><span class="pill ${r.conclusion === "bullish" ? "pill-buy" : r.conclusion === "bearish" ? "pill-sell" : "pill-hold"}">${esc(r.conclusion)}</span></td>
      <td class="num">${fmt(r.confidence)}</td>
      <td class="num">${r.signals.targetWeightAdjustment >= 0 ? "+" : ""}${fmt(r.signals.targetWeightAdjustment, 4)}</td>
      <td class="rationale">${esc(r.rationale)}</td>
    </tr>`);
    return `<div class="table-wrap">
      <h3 class="subhead">Analyst reports — run detail</h3>
      <table class="dtable">
        <thead><tr><th>Ticker</th><th>Analyst</th><th>Conclusion</th><th class="r">Confidence</th><th class="r">Δ target</th><th>Rationale</th></tr></thead>
        <tbody>${rows.join("") || '<tr><td colspan="6" class="sub">no reports for this run</td></tr>'}</tbody>
      </table>
    </div>`;
  }

  // Click delegation: expanding rows survive table re-renders.
  document.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.run-row");
    if (tr && tr.dataset.runId) void toggleRunDetail(tr, tr.dataset.runId);
  });

  function renderEvents(events) {
    const rows = events.map((e) => `<tr>
      <td class="nowrap">${esc(fmtTime(e.occurredAt))}</td>
      <td><b>${esc(e.type)}</b></td>
      <td class="sub">${esc(truncate(JSON.stringify(e.payload), 160))}</td>
    </tr>`);
    $("#events-table").innerHTML =
      `<thead><tr><th>At</th><th>Event</th><th>Payload</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="3" class="sub">no events yet</td></tr>'}</tbody>`;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  PM.setRefresh(load);
  load().then(PM.initTopbar).catch((err) => {
    $("#status-line").textContent = `error: ${err}`;
  });
  setInterval(() => { load().catch(() => {}); }, 60_000);
})();
