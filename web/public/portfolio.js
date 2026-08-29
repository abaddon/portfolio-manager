/* Portfolio page: value hero, value-per-run trend, composition (ribbons +
   drift table), rebalance pressure. All data from the read-only API. */
"use strict";

(function () {
  const { $, esc, fmt, pct, money, curSym, timeAgo, fmtTime, api } = PM;

  /* ── data loading ─────────────────────────────────────────────────── */
  async function load() {
    const [ov, targets, orders] = await Promise.all([
      api("/api/overview"),
      api("/api/targets").catch(() => null),
      api("/api/orders?limit=200").catch(() => null),
    ]);
    const cur = ov.accountCurrency;
    const snap = ov.snapshot;
    const targetsList = targets?.current ?? ov.allocation.targets;
    const bandPct = (ov.allocation.rebalanceBand ?? 0.04) * 100;

    renderHero(ov, cur, targetsList);
    await renderTrend(cur);
    renderComposition(ov, snap, targetsList, bandPct, cur);
    renderRebalance(ov, snap, targetsList, bandPct, cur, orders?.orders ?? []);
    renderFooter(ov, cur);
  }

  /* ── 1 · value hero ───────────────────────────────────────────────── */
  function renderHero(ov, cur, targetsList) {
    const snap = ov.snapshot;
    $("#value-eyebrow").textContent = snap ? `Total value · as of ${fmtTime(snap.asOf)}` : "Total value";
    const big = $("#total-value");
    if (!snap) {
      big.textContent = "—";
      $("#day-delta").textContent = "no snapshot yet — press Run now";
      $("#value-figures").innerHTML = `<p class="sub">Nothing has been valued yet.</p>`;
      return;
    }
    const sym = curSym(cur);
    const [intPart, decPart] = fmt(snap.totalValue).split(".");
    big.innerHTML = `<span class="cur">${esc(sym)}</span>${esc(intPart)}<span class="dec">.${esc(decPart ?? "00")}</span>`;

    const day = snap.dayChangePct;
    const delta = $("#day-delta");
    if (day === null || day === undefined) {
      delta.textContent = "day change —";
      delta.className = "delta";
    } else if (day >= 0) {
      delta.innerHTML = `▲ +${day.toFixed(2)}% today`;
      delta.className = "delta delta-pos";
    } else {
      delta.innerHTML = `▼ ${Math.abs(day).toFixed(2)}% today`;
      delta.className = "delta delta-neg";
    }
    const bench = snap.benchmarkChangePct;
    const alpha = day !== null && day !== undefined && bench !== null && bench !== undefined ? day - bench : null;
    $("#bench-meta").textContent =
      bench === null || bench === undefined
        ? alpha === null
          ? "no benchmark data this run"
          : `alpha ${alpha >= 0 ? "+" : ""}${alpha.toFixed(2)}pp`
        : `SPY ${bench >= 0 ? "+" : ""}${bench.toFixed(2)}% · alpha ${alpha === null ? "—" : (alpha >= 0 ? "+" : "") + alpha.toFixed(2) + "pp"}`;

    const invested = snap.investedValue;
    const cash = snap.cash;
    const pnl = snap.positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    const costBasis = invested - pnl;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    const cashTargetPct = targetsList && targetsList.length ? (1 - targetsList.reduce((s, t) => s + t.weight, 0)) * 100 : null;
    $("#invested-sub").textContent = `${snap.positions.length} holdings · ${fmt((invested / snap.totalValue) * 100, 1)}% of NAV`;
    $("#invested-val").textContent = money(invested, cur);
    $("#cash-sub").textContent =
      cashTargetPct === null ? "no target set" : `target buffer ${cashTargetPct.toFixed(1)}%`;
    $("#cash-val").textContent = money(cash, cur);
    $("#pnl-sub").textContent = `against ${money(costBasis, cur)} cost basis`;
    $("#pnl-val").innerHTML =
      `<span class="${pnl >= 0 ? "pos" : "neg"}">${money(pnl, cur)}</span><small class="${pnl >= 0 ? "pos" : "neg"}">${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</small>`;
  }

  /* ── 1b · value-per-run trend ─────────────────────────────────────── */
  async function renderTrend(cur) {
    const hist = await api("/api/portfolio/history?limit=120").catch(() => null);
    const series = (hist?.history ?? [])
      .slice()
      .sort((a, b) => a.asOf.localeCompare(b.asOf))
      .map((s) => ({ t: fmtTime(s.asOf), v: s.totalValue }));
    const svg = $("#trend");
    const chartbox = $("#value-trend");
    if (series.length < 2) {
      chartbox.style.display = "none";
      return;
    }
    chartbox.style.display = "";
    const unit = curSym(cur);
    $("#trend-eyebrow").textContent = `Value per run · ${series[0].t} – ${series[series.length - 1].t}`;
    const first = series[0].v;
    const last = series[series.length - 1].v;
    const delta = last - first;
    $("#trend-summary").textContent = `${delta >= 0 ? "+" : "−"}${unit}${Math.abs(delta).toFixed(2)} · ${((delta / first) * 100).toFixed(2)}%`;
    $("#axis-start").textContent = `${series[0].t} · ${unit}${first.toFixed(2)}`;
    $("#axis-end").textContent = `${series[series.length - 1].t} · ${unit}${last.toFixed(2)}`;
    PM.renderTrendSvg(svg, $("#trend-tip"), series, unit);
  }

  /* ── 2 · composition ──────────────────────────────────────────────── */
  function renderComposition(ov, snap, targetsList, bandPct, cur) {
    const tbody = $("#positions");
    const foot = $("#positions-foot");
    const title = $("#composition-title");
    if (!snap) {
      title.textContent = "Where the money sits";
      tbody.innerHTML = `<tr><td colspan="7" class="sub">no snapshot yet — press Run now to value the portfolio.</td></tr>`;
      foot.innerHTML = "";
      $("#allocation-ribbon").innerHTML = "";
      $("#allocation-legend").innerHTML = "";
      return;
    }

    const targetMap = new Map((targetsList ?? []).map((t) => [t.ticker, t.weight]));
    const pos = snap.positions.slice().sort((a, b) => b.marketValue - a.marketValue);
    const posWeightSum = pos.reduce((s, p) => s + p.weight, 0);
    const cashWeight = Math.max(0, 1 - posWeightSum);
    const cashTarget = Math.max(0, 1 - (targetsList ?? []).reduce((s, t) => s + t.weight, 0));

    // ribbons
    const curSegs = pos.map((p) => ({ label: p.ticker, pct: p.weight * 100 }));
    curSegs.push({ label: "Cash", pct: cashWeight * 100, cash: true });
    const tgtSegs = (targetsList ?? []).map((t) => ({ label: t.ticker, pct: t.weight * 100 }));
    tgtSegs.push({ label: "Cash", pct: cashTarget * 100, cash: true });
    $("#ribbon-current").innerHTML = PM.ribbonHtml(curSegs);
    $("#ribbon-target").innerHTML = PM.ribbonHtml(tgtSegs);
    $("#allocation-legend").innerHTML =
      PM.legendHtml(curSegs) + `<span class="legend-item meta" style="margin-left:auto">Upper bar: current · lower bar: target</span>`;
    $("#ribbon-current").setAttribute("aria-label", "Current allocation: " + curSegs.map((s) => `${s.label} ${s.pct.toFixed(1)}%`).join(", "));
    $("#ribbon-target").setAttribute("aria-label", "Target allocation: " + tgtSegs.map((s) => `${s.label} ${s.pct.toFixed(1)}%`).join(", "));

    const rows = pos.map((p) => {
      const target = targetMap.get(p.ticker);
      const driftPp = target !== undefined ? (p.weight - target) * 100 : null;
      const pnl = p.unrealizedPnl ?? 0;
      return `<tr data-weight="${p.weight}" data-drift="${Math.abs(driftPp ?? 0)}" data-pnl="${pnl}">
        <td><span class="tick"><b>${esc(p.ticker)}</b> <span>${fmt(p.quantity, 4)} sh · ${esc(p.currency)}</span></span></td>
        <td class="r num">${(p.weight * 100).toFixed(2)}%</td>
        <td class="r num sub">${target !== undefined ? (target * 100).toFixed(2) + "%" : "—"}</td>
        <td class="r">${driftPp === null ? '<span class="sub">—</span>' : PM.driftCellHtml(driftPp, bandPct)}</td>
        <td class="r num hide-sm">${money(p.currentPrice, p.currency, 2)} <span class="sub">/ ${money(p.averagePrice, p.currency, 2)}</span></td>
        <td class="r num">${money(p.marketValue, cur)}</td>
        <td class="r num ${pnl >= 0 ? "pos" : "neg"}">${money(pnl, cur)} <span class="sub">${pnl >= 0 ? "+" : ""}${(p.unrealizedPnlPct ?? 0).toFixed(2)}%</span></td>
      </tr>`;
    });
    const cashRow = `<tr data-weight="${cashWeight}" data-drift="${Math.abs(cashWeight - cashTarget) * 100}" data-pnl="0">
      <td><span class="tick"><b>CASH</b> <span>Uninvested · ${esc(cur)}</span></span></td>
      <td class="r num">${(cashWeight * 100).toFixed(2)}%</td>
      <td class="r num sub">${(cashTarget * 100).toFixed(2)}%</td>
      <td class="r">${PM.driftCellHtml((cashWeight - cashTarget) * 100, bandPct)}</td>
      <td class="r num hide-sm sub">—</td>
      <td class="r num">${money(snap.cash, cur)}</td>
      <td class="r num sub">—</td>
    </tr>`;
    tbody.innerHTML = rows.join("") + cashRow;

    const totalPnl = pos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    foot.innerHTML = `<tr>
      <td>Total</td>
      <td class="r num">${(posWeightSum * 100).toFixed(2)}%</td>
      <td class="r num sub">${((targetsList ?? []).reduce((s, t) => s + t.weight, 0) * 100).toFixed(2)}%</td>
      <td class="r"></td>
      <td class="r hide-sm"></td>
      <td class="r num">${money(snap.totalValue, cur)}</td>
      <td class="r num ${totalPnl >= 0 ? "pos" : "neg"}">${money(totalPnl, cur)}</td>
    </tr>`;
    title.textContent = `Where the ${curSym(cur)}${fmt(snap.totalValue)} sits`;
    $("#drift-note").textContent = `Drift bars turn red outside the ±${bandPct.toFixed(0)}pp rebalance band · half-track = 10pp`;

    wireSort();
  }

  function wireSort() {
    const tbody = $("#positions");
    const seg = $("#sort-positions");
    if (!tbody || !seg) return;
    const sortBy = (key) => {
      const rows = Array.from(tbody.querySelectorAll("tr"));
      rows
        .slice()
        .sort((a, b) => {
          const av = parseFloat(a.dataset[key]);
          const bv = parseFloat(b.dataset[key]);
          return key === "drift" ? bv - av : bv - av;
        })
        .forEach((r) => tbody.appendChild(r));
    };
    const onClick = (e) => {
      const btn = e.target.closest("button[data-sort]");
      if (!btn) return;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      sortBy(btn.dataset.sort);
      try { localStorage.setItem("pm.positionSort", btn.dataset.sort); } catch {}
    };
    seg.removeEventListener("click", onClick);
    seg.addEventListener("click", onClick);
    let saved = null;
    try { saved = localStorage.getItem("pm.positionSort"); } catch {}
    if (saved) {
      const target = seg.querySelector(`button[data-sort="${saved}"]`);
      if (target) {
        seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === target)));
        sortBy(saved);
      }
    }
  }

  /* ── 3 · rebalance pressure ───────────────────────────────────────── */
  function renderRebalance(ov, snap, targetsList, bandPct, cur, orders) {
    const tbody = $("#rebalance-rows");
    const title = $("#rebalance-title");
    const note = $("#rebalance-note");
    const decisions = (ov.decisions ?? []).slice().sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    const ordersByDecision = new Map(orders.map((o) => [o.decisionId, o]));

    if (!snap || !targetsList || targetsList.length === 0) {
      title.textContent = "Checking the drift band";
      tbody.innerHTML = `<tr><td colspan="5" class="sub">no snapshot or no allocation targets yet — targets are bootstrapped from the broker on the first run.</td></tr>`;
      note.textContent = "";
      return;
    }

    const targetMap = new Map(targetsList.map((t) => [t.ticker, t.weight]));
    const byTicker = new Map(snap.positions.map((p) => [p.ticker, p.weight]));
    const cashWeight = Math.max(0, 1 - snap.positions.reduce((s, p) => s + p.weight, 0));
    const cashTarget = Math.max(0, 1 - targetsList.reduce((s, t) => s + t.weight, 0));
    const rows = [];
    const outOfBand = [];

    const latestDecision = (ticker) => decisions.find((d) => d.ticker === ticker);

    const addRow = (ticker, label, driftPp, tradeValue, decision) => {
      const out = Math.abs(driftPp) > bandPct;
      if (out) outOfBand.push(ticker);
      const order = decision ? ordersByDecision.get(decision.id) : null;
      const trade =
        decision && decision.action !== "HOLD"
          ? `${decision.action === "BUY" ? "BUY" : "SELL"} ${money(decision.proposal.estimatedValue, cur)}`
          : `${driftPp < 0 ? "BUY" : "SELL"} ${money(Math.abs(tradeValue), cur)}`;
      const call = decision ? (decision.proposal.rationale || "No rationale recorded") : "No decision in the last 20";
      const outcome = order ? PM.orderStatusPill(order.status) : PM.decisionPill(decision ?? { approved: false });
      rows.push({
        driftPp,
        html: `<tr>
        <td><span class="tick"><b>${esc(ticker)}</b> <span>${esc(label)}</span></span></td>
        <td class="r num ${out ? "neg" : ""}">${driftPp >= 0 ? "+" : "−"}${Math.abs(driftPp).toFixed(2)}pp</td>
        <td class="r num hide-sm">${esc(trade)}</td>
        <td class="sub">${esc(truncate(call, 150))}</td>
        <td class="r">${outcome}</td>
      </tr>`,
      });
    };

    for (const t of targetsList) {
      const weight = byTicker.get(t.ticker) ?? 0;
      const driftPp = (weight - t.weight) * 100;
      const decision = latestDecision(t.ticker);
      if (Math.abs(driftPp) <= bandPct && !decision) continue; // quiet name, no recent call
      addRow(t.ticker, `${driftPp < 0 ? "underweight" : "overweight"}`, driftPp, (driftPp / 100) * snap.totalValue, decision);
    }
    // cash row (only when it drifted out of band)
    const cashDriftPp = (cashWeight - cashTarget) * 100;
    if (Math.abs(cashDriftPp) > bandPct) {
      addRow("CASH", "Uninvested", cashDriftPp, (cashDriftPp / 100) * snap.totalValue, null);
    }

    rows.sort((a, b) => Math.abs(b.driftPp) - Math.abs(a.driftPp));
    tbody.innerHTML = rows.map((r) => r.html).join("") || `<tr><td colspan="5" class="sub">No drift outside the ±${bandPct.toFixed(0)}pp band and no recent calls — the portfolio is in balance.</td></tr>`;
    title.textContent =
      outOfBand.length === 0
        ? `All weights inside the ±${bandPct.toFixed(0)}pp band`
        : `${outOfBand.length} ${outOfBand.length === 1 ? "name is" : "names are"} out of band`;

    // gate note: why the recent orders did or didn't clear
    const blocked = decisions.filter((d) => !d.approved && d.action !== "HOLD");
    const risk = ov.risk;
    if (blocked.length > 0 && risk) {
      const pcts = blocked
        .map((d) => (d.proposal.estimatedValue > 0 ? (d.proposal.expectedBenefit / d.proposal.estimatedValue) * 100 : null))
        .filter((n) => n !== null);
      const floor = risk.minExpectedBenefitPct * 100;
      const reasonCount = {};
      blocked.forEach((d) => { reasonCount[PM.REASON_SHORT[d.reason] ?? d.reason] = (reasonCount[PM.REASON_SHORT[d.reason] ?? d.reason] ?? 0) + 1; });
      const reasons = Object.entries(reasonCount).map(([r, n]) => `${n}× ${r}`).join(", ");
      note.innerHTML =
        `${blocked.length} order${blocked.length === 1 ? "" : "s"} from the last ${decisions.length} decisions ${blocked.length === 1 ? "was" : "were"} blocked at the economic gate` +
        (pcts.length ? ` — expected benefit ${Math.min(...pcts).toFixed(2)}–${Math.max(...pcts).toFixed(2)}% of order value vs a ${floor.toFixed(2)}% floor (<span class="num">risk.minExpectedBenefitPct</span>)` : "") +
        `.<br/>${reasons}. Nothing is submitted until the gate passes.`;
    } else {
      note.textContent = "All recent proposals cleared the economic gate — any orders went to the broker.";
    }
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /* ── footer ───────────────────────────────────────────────────────── */
  function renderFooter(ov, cur) {
    const broker = ov.broker ?? {};
    const env = broker.kind === "paper" ? "paper" : broker.environment === "demo" ? "demo" : "live";
    $("#foot-left").textContent =
      `Hourly pipeline · ${ov.universe?.tickers?.length ?? 0} tickers · benchmark ${ov.universe?.benchmark ?? "SPY"} · ${esc(env)}`;
    const run = ov.lastRun;
    $("#foot-right").textContent =
      (run ? `${run.id} · ` : "") + (ov.snapshot ? `snapshot ${fmtTime(ov.snapshot.asOf)} UTC` : "no snapshot yet");
  }

  /* ── boot ─────────────────────────────────────────────────────────── */
  PM.setRefresh(load);
  load().then(PM.initTopbar).catch((err) => {
    $("#status-line").textContent = `error: ${err}`;
    $("#day-delta").textContent = `error: ${err}`;
  });
  setInterval(() => { load().catch(() => {}); }, 60_000);
})();
