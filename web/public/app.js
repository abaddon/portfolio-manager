/* Dashboard frontend: vanilla JS, Chart.js, read-only API. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const fmt = (n, dp = 2) => (n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const pct = (n) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(2)}%`);
const timeAgo = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let trendChart = null;
let allocationChart = null;
let pricesChart = null;

async function load() {
  try {
    const res = await fetch("/api/overview");
    const data = await res.json();
    render(data);
    const historyRes = await fetch("/api/portfolio/history?limit=120");
    const history = await (await historyRes.json());
    renderTrend(history.history);
    const targetsRes = await fetch("/api/targets");
    const targets = await (await targetsRes.json());
    renderTargets(targets);
    renderAllocation(data.snapshot?.positions ?? [], targets.current ?? data.allocation.targets);
  } catch (err) {
    $("#status-line").textContent = `error: ${err}`;
  }
}

function render(d) {
  const snap = d.snapshot;
  const run = d.lastRun;
  const broker = d.broker ?? { kind: d.mode === "live" ? "trading212" : "paper", environment: d.mode === "live" ? "live" : "paper" };
  window.__mode = broker.kind === "trading212" ? broker.environment : "paper";
  const modeLabel =
    broker.kind === "paper" ? "PAPER"
    : broker.environment === "demo" ? "LIVE — DEMO ACCOUNT"
    : "LIVE";

  $("#status-line").innerHTML =
    `<span class="pill ${broker.kind === "paper" ? "muted" : "buy"}">${esc(modeLabel)}</span>` +
    (run
      ? ` last run <span class="pill ${run.status.toLowerCase()}">${run.status}</span> ${timeAgo(run.startedAt)}${run.error ? ` — <span class="neg">${esc(run.error)}</span>` : ""}`
      : " no runs yet");

  const heat = snap ? snap.positions.reduce((s, p) => s + p.weight * 0.9, 0) : 0;
  const bench = snap?.benchmarkChangePct;
  const alpha = snap?.dayChangePct != null && bench != null ? snap.dayChangePct - bench : null;
  const cards = [
    ["Total value", snap ? `${fmt(snap.totalValue)} ${esc(snap.currency)}` : "—", snap?.dayChangePct != null ? `day ${snap.dayChangePct >= 0 ? "+" : ""}${fmt(snap.dayChangePct)}%` : ""],
    ["Cash", snap ? fmt(snap.cash) : "—", `invested ${snap ? fmt(snap.investedValue) : "—"}`],
    ["NAV / unit", d.nav ? fmt(d.nav.navPerUnit, 4) : "—", d.nav ? `${fmt(d.nav.units, 0)} units` : ""],
    ["Benchmark day", bench != null ? `${bench >= 0 ? "+" : ""}${fmt(bench)}%` : "—", alpha != null ? `α ${alpha >= 0 ? "+" : ""}${fmt(alpha)}% vs portfolio` : "vs portfolio day change"],
    ["Positions", snap ? String(snap.positions.length) : "—", `heat ${pct(heat)}`],
    ["Decisions (last 20)", String(d.decisions.filter((x) => x.action !== "HOLD").length), `${d.decisions.filter((x) => x.approved).length} approved`],
    ["Orders (last 20)", String(d.orders.length), `${d.orders.filter((x) => x.status === "FILLED").length} filled`],
  ];
  $("#cards").innerHTML = cards
    .map(([label, value, sub]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`)
    .join("");

  renderPositions(snap?.positions ?? [], d.allocation.targets, d.accountCurrency);
  renderDecisions(d.decisions);
  renderOrders(d.orders);
  renderAnalysis(d.analysisReports ?? []);
  renderNews(d.news ?? []);
  renderSentiment(d.sentiment ?? []);
  renderEvents(d.events);
  renderPrices(d.priceHistory ?? {});
}

function renderPositions(positions, targets, currency) {
  const rows = positions
    .slice()
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((p) => {
      const target = targets[p.ticker];
      const drift = target !== undefined ? (p.weight - target) * 100 : null;
      const pnl = p.unrealizedPnl ?? 0;
      return `<tr>
        <td><b>${esc(p.ticker)}</b></td>
        <td>${fmt(p.quantity, 4)}</td>
        <td>${fmt(p.averagePrice)} ${esc(p.currency)}</td>
        <td>${fmt(p.currentPrice)} ${esc(p.currency)}</td>
        <td>${fmt(p.marketValue)} ${esc(currency)}</td>
        <td>${pct(p.weight)}${drift !== null ? ` <span class="muted">(drift ${drift >= 0 ? "+" : ""}${fmt(drift)}%)</span>` : ""}</td>
        <td class="${pnl >= 0 ? "pos" : "neg"}">${pnl >= 0 ? "+" : ""}${fmt(pnl)} ${esc(currency)} (${p.unrealizedPnlPct >= 0 ? "+" : ""}${fmt(p.unrealizedPnlPct)}%)</td>
      </tr>`;
    });
  $("#positions-table").innerHTML =
    `<thead><tr><th>Ticker</th><th>Qty</th><th>Avg price</th><th>Price</th><th>Value</th><th>Weight</th><th>Unrealized P&L</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="7" class="muted">no positions</td></tr>'}</tbody>`;
}

function reasonClass(reason) {
  if (reason === "ECONOMICALLY_VIABLE") return "approved";
  if (reason === "COST_EXCEEDS_BENEFIT" || reason === "RISK_LIMIT_EXCEEDED" || reason === "INSUFFICIENT_CASH") return "rejected";
  return "hold";
}

function renderDecisions(decisions) {
  const rows = decisions
    .slice()
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    .map((dec) => `<tr>
      <td>${esc(dec.decidedAt)}</td>
      <td><b>${esc(dec.ticker)}</b></td>
      <td><span class="pill ${dec.action.toLowerCase()}">${esc(dec.action)}</span></td>
      <td>${fmt(dec.quantity, 4)}</td>
      <td>${fmt(dec.proposal.estimatedValue)}</td>
      <td>${fmt(dec.proposal.expectedBenefit)}</td>
      <td>${fmt(dec.proposal.costEstimate.total)}</td>
      <td><span class="pill ${reasonClass(dec.reason)}">${esc(dec.reason)}</span></td>
      <td class="rationale">${esc(dec.proposal.rationale)}</td>
    </tr>`);
  $("#decisions-table").innerHTML =
    `<thead><tr><th>At</th><th>Ticker</th><th>Action</th><th>Qty</th><th>Order value</th><th>Expected benefit</th><th>Est. costs</th><th>Reason</th><th>Why</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="9" class="muted">no decisions yet</td></tr>'}</tbody>`;
}

function renderOrders(orders) {
  const rows = orders
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => `<tr>
      <td>${esc(o.createdAt)}</td>
      <td><b>${esc(o.ticker)}</b></td>
      <td><span class="pill ${o.side.toLowerCase()}">${esc(o.side)}</span></td>
      <td>${fmt(o.quantity, 4)}</td>
      <td>${o.fill ? fmt(o.fill.filledPriceAvg) : "—"}</td>
      <td>${o.fill ? fmt(o.fill.filledQuantity, 4) : "—"}</td>
      <td><span class="pill ${o.status.toLowerCase()}">${esc(o.status)}</span></td>
      <td>${o.fill ? fmt(o.fill.realizedCost.total) : "—"}</td>
      <td>${o.error ? `<span class="neg">${esc(o.error)}</span>` : ""}</td>
    </tr>`);
  $("#orders-table").innerHTML =
    `<thead><tr><th>Created</th><th>Ticker</th><th>Side</th><th>Qty</th><th>Fill price</th><th>Filled qty</th><th>Status</th><th>Realized cost</th><th>Error</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="9" class="muted">no orders yet</td></tr>'}</tbody>`;
}

function renderAnalysis(reports) {
  const rows = reports
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => `<tr>
      <td>${esc(r.createdAt)}</td>
      <td><b>${esc(r.ticker)}</b></td>
      <td>${esc(r.analyst)}</td>
      <td><span class="pill ${r.conclusion}">${esc(r.conclusion)}</span></td>
      <td>${fmt(r.confidence)}</td>
      <td>${r.signals.targetWeightAdjustment >= 0 ? "+" : ""}${fmt(r.signals.targetWeightAdjustment, 4)}</td>
      <td class="rationale">${esc(r.rationale)}</td>
    </tr>`);
  $("#analysis-table").innerHTML =
    `<thead><tr><th>At</th><th>Ticker</th><th>Analyst</th><th>Conclusion</th><th>Confidence</th><th>Δ target weight</th><th>Rationale</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="7" class="muted">no reports yet</td></tr>'}</tbody>`;
}

function renderNews(news) {
  const rows = news.map((n) => `<tr>
      <td><b>${esc(n.item.ticker)}</b></td>
      <td>${esc(n.item.headline)}</td>
      <td class="muted">${esc(n.item.source)} · ${timeAgo(n.item.publishedAt)}</td>
    </tr>`);
  $("#news-table").innerHTML =
    `<thead><tr><th>Ticker</th><th>Headline</th><th>Source</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="3" class="muted">no news persisted yet</td></tr>'}</tbody>`;
}

function renderSentiment(sentiment) {
  const rows = sentiment.map((s) => `<tr>
      <td><b>${esc(s.score.ticker)}</b></td>
      <td>${s.score.score >= 0 ? "+" : ""}${fmt(s.score.score)}</td>
      <td><span class="pill ${s.score.label.startsWith("very") ? (s.score.score > 0 ? "buy" : "sell") : "neutral"}">${esc(s.score.label)}</span></td>
      <td class="muted">${esc(s.score.source)}</td>
    </tr>`);
  $("#sentiment-table").innerHTML =
    `<thead><tr><th>Ticker</th><th>Score</th><th>Label</th><th>Source</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="4" class="muted">no sentiment persisted yet</td></tr>'}</tbody>`;
}

function renderPrices(history) {
  const tickers = Object.keys(history).filter((t) => (history[t] ?? []).length > 1);
  const canvas = $("#prices-chart");
  if (tickers.length === 0) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "";
  // Shared x-axis: union of all snapshot timestamps, ordered.
  const allTimes = [...new Set(tickers.flatMap((t) => history[t].map((s) => s.asOf)))].sort();
  const palette = ["#4f8cff", "#2ecc71", "#f1c40f", "#e74c3c", "#9b59b6", "#1abc9c"];
  const datasets = tickers.map((t, i) => {
    const byTime = new Map(history[t].map((s) => [s.asOf, s.price]));
    return {
      label: t,
      data: allTimes.map((ts) => byTime.get(ts) ?? null),
      borderColor: palette[i % palette.length],
      backgroundColor: "transparent",
      tension: 0.2,
      pointRadius: 0,
      spanGaps: true,
    };
  });
  if (pricesChart) pricesChart.destroy();
  pricesChart = new Chart(canvas, {
    type: "line",
    data: { labels: allTimes.map((ts) => new Date(ts).toLocaleString()), datasets },
    options: {
      responsive: true,
      scales: { y: { grid: { color: "#26304a" } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } },
    },
  });
}

function renderEvents(events) {
  const rows = events.map((e) => `<tr>
      <td>${esc(e.occurredAt)}</td>
      <td><b>${esc(e.type)}</b></td>
      <td class="muted">${esc(JSON.stringify(e.payload))}</td>
    </tr>`);
  $("#events-table").innerHTML =
    `<thead><tr><th>At</th><th>Event</th><th>Payload</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="3" class="muted">no events yet</td></tr>'}</tbody>`;
}

function renderTrend(history) {
  const sorted = history.slice().sort((a, b) => a.asOf.localeCompare(b.asOf));
  const labels = sorted.map((s) => new Date(s.asOf).toLocaleString());
  const values = sorted.map((s) => s.totalValue);
  if (trendChart) trendChart.destroy();
  trendChart = new Chart($("#trend-chart"), {
    type: "line",
    data: { labels, datasets: [{ label: "Total value", data: values, borderColor: "#4f8cff", backgroundColor: "rgba(79,140,255,0.12)", fill: true, tension: 0.25 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { grid: { color: "#26304a" } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } } },
  });
}

function renderAllocation(positions, targets) {
  const list = Array.isArray(targets)
    ? targets
    : Object.entries(targets ?? {}).map(([ticker, weight]) => ({ ticker, weight }));
  const labels = list.map((t) => t.ticker);
  const current = labels.map((t) => positions.find((p) => p.ticker === t)?.weight ?? 0);
  const target = list.map((t) => t.weight ?? 0);
  if (allocationChart) allocationChart.destroy();
  allocationChart = new Chart($("#allocation-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Target", data: target, backgroundColor: "#4f8cff" },
        { label: "Current", data: current, backgroundColor: "#2ecc71" },
      ],
    },
    options: {
      responsive: true,
      scales: { y: { grid: { color: "#26304a" }, ticks: { callback: (v) => `${Math.round(v * 100)}%` } }, x: { grid: { display: false } } },
    },
  });
}

function renderTargets(targets) {
  const base = new Map((targets.base ?? []).map((t) => [t.ticker, t.weight]));
  const current = new Map((targets.current ?? []).map((t) => [t.ticker, t.weight]));
  const rows = [...current.keys()].map((ticker) => {
    const from = base.get(ticker);
    const to = current.get(ticker);
    const delta = from !== undefined && to !== undefined ? to - from : null;
    return `<tr>
      <td><b>${esc(ticker)}</b></td>
      <td>${pct(from ?? null)}</td>
      <td>${pct(to ?? null)}</td>
      <td class="${(delta ?? 0) > 0 ? "pos" : (delta ?? 0) < 0 ? "neg" : "muted"}">${delta === null ? "—" : (delta >= 0 ? "+" : "") + (delta * 100).toFixed(2) + "%"}</td>
      <td class="muted">${targets.adaptation?.enabled ? "adaptive (reviewed each run)" : "static"}</td>
    </tr>`;
  });
  const recent = (targets.recent ?? []).slice(0, 10).map((u) => `<tr>
      <td>${esc(u.updatedAt)}</td>
      <td><b>${esc(u.ticker)}</b></td>
      <td>${pct(u.originalWeight)} → ${pct(u.weight)}</td>
      <td>${fmt(u.conviction)}</td>
      <td class="rationale">${esc(u.rationale)}</td>
    </tr>`);
  $("#targets-table").innerHTML =
    `<thead><tr><th>Ticker</th><th>Seed target</th><th>Current target</th><th>Δ</th><th>Mode</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="5" class="muted">no targets configured</td></tr>'}</tbody>` +
    `<thead><tr><th colspan="5">Recent review decisions</th></tr></thead><tbody>${recent.join("") || '<tr><td colspan="5" class="muted">no target changes yet — first review happens on the next run</td></tr>'}</tbody>`;
}

load();
setInterval(load, 60_000);

/* ---- Manual run trigger (same pipeline + gates as the scheduler) ---- */

let runInProgress = false;

$("#run-now").addEventListener("click", async () => {
  if (runInProgress) return;
  const force = $("#force-run").checked;
  const modeLabel =
    window.__mode === "paper" ? "PAPER (simulated)" : window.__mode === "demo" ? "LIVE — DEMO ACCOUNT" : "LIVE (real money)";
  const ok = confirm(
    `Run the full hourly cycle now?\n\nAccount: ${modeLabel}\nForce (ignore market hours): ${force ? "yes" : "no"}\n\nThis runs analysis → allocation → cost-gated decisions and MAY PLACE TRADES through the same gates as the scheduled runs.`,
  );
  if (!ok) return;

  const btn = $("#run-now");
  btn.disabled = true;
  btn.textContent = "⏳ Running…";
  runInProgress = true;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Run failed to start: ${data.error ?? res.status}`);
      return;
    }
    const runId = data.runId;
    $("#status-line").innerHTML = `<span class="pill pending">RUNNING</span> ${esc(runId)} — started, polling…`;
    // The pipeline takes ~1-2 minutes (LLM analysis). Poll until it settles.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const ov = await (await fetch("/api/overview")).json();
      const run = ov.lastRun;
      if (run && run.id === runId && run.status !== "RUNNING") {
        $("#status-line").innerHTML = `<span class="pill ${run.status.toLowerCase()}">${esc(run.status)}</span> ${esc(runId)}${
          run.error ? ` — <span class="neg">${esc(run.error)}</span>` : ""
        }`;
        await load();
        return;
      }
    }
    await load();
  } catch (err) {
    alert(`Run trigger error: ${err}`);
  } finally {
    runInProgress = false;
    btn.disabled = false;
    btn.textContent = "▶ Run now";
  }
});
