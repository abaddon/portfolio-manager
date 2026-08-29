/* Activity page: decision log grouped by run, with expandable decision
   panels (decision facts + gate checklist or execution). Same data as the
   read-only API; nothing here ever submits an order. */
"use strict";

(function () {
  const { $, esc, fmt, money, fmtTime, api } = PM;

  let risk = null;
  let currency = "GBP";

  async function load() {
    const [runsRes, decRes, ordRes, histRes, ov, cmt] = await Promise.all([
      api("/api/runs?limit=100"),
      api("/api/decisions?limit=500"),
      api("/api/orders?limit=500"),
      api("/api/portfolio/history?limit=500").catch(() => null),
      api("/api/overview"),
      api("/api/committee").catch(() => null),
    ]);
    risk = ov.risk ?? null;
    currency = ov.accountCurrency ?? "GBP";
    render(runsRes.runs ?? [], decRes.decisions ?? [], ordRes.orders ?? [], histRes?.history ?? [], cmt);
  }

  function render(runs, decisions, orders, history, cmt) {
    const ordersByDecision = new Map(orders.map((o) => [o.decisionId, o]));
    const navByRun = new Map(history.map((s) => [s.runId, s.totalValue]));
    const committeeRunId = cmt?.latestSession?.session?.runId ?? null;

    const sortedRuns = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const byRun = new Map();
    for (const d of decisions) {
      if (!byRun.has(d.runId)) byRun.set(d.runId, []);
      byRun.get(d.runId).push(d);
    }

    // ── summary strip ─────────────────────────────────────────────────
    const total = decisions.length;
    const approved = decisions.filter((d) => d.approved).length;
    const filled = orders.filter((o) => o.status === "FILLED").length;
    $("#summary-strip").innerHTML =
      `<div><b class="num">${total}</b><span class="lbl">Decisions taken</span></div>` +
      `<div><b class="num">${approved}</b><span class="lbl">Cleared the gate</span></div>` +
      `<div><b class="num pos">${filled}</b><span class="lbl">Filled at the broker</span></div>` +
      `<div><b class="num">${total - approved}</b><span class="lbl">Blocked before submission</span></div>`;
    const first = sortedRuns.length ? sortedRuns[sortedRuns.length - 1] : null;
    const last = sortedRuns[0] ?? null;
    $("#activity-eyebrow").textContent =
      `Activity${first && last ? ` · ${fmtTime(first.startedAt)} – ${fmtTime(last.startedAt)}` : ""}`;
    $("#summary-note").textContent =
      total === 0
        ? "No decisions recorded yet — the first run happens on schedule (or press Run now)."
        : `Nothing is submitted until the economic gate passes, so an order only ever exists downstream of an approved decision. ` +
          `${total - approved} of ${total} decisions were blocked before submission; the ${filled} fills below cleared the gate.`;

    // ── run log ───────────────────────────────────────────────────────
    const host = $("#runs");
    const seg = $("#activity-filter");
    let uid = 0;
    let html = "";
    for (const run of sortedRuns) {
      const decs = (byRun.get(run.id) ?? []).slice().sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
      if (decs.length === 0) continue;
      const isCommittee = committeeRunId === run.id;
      const nav = navByRun.get(run.id);
      html += `<div class="run" data-run-id="${esc(run.id)}">` +
        `<div class="run-head">` +
        `<span class="run-time">${esc(fmtTime(run.startedAt))}</span>` +
        `<span class="pill ${isCommittee ? "pill-strong" : "pill-plain"}">${isCommittee ? "Committee" : "Classic"}</span>` +
        (run.status !== "COMPLETED" ? `<span class="pill ${run.status === "FAILED" ? "pill-danger" : "pill-open"}">${esc(run.status)}</span>` : "") +
        `<span class="meta">${esc(run.id)}${nav ? ` · NAV ${money(nav, currency)}` : ""}</span>` +
        (isCommittee ? `<a class="btn btn-quiet spacer" href="decision-detail.html">Open committee session ›</a>` : "") +
        `</div>` +
        decs.map((d) => decisionRow(d, run, ordersByDecision, ++uid)).join("") +
        `</div>`;
    }
    host.innerHTML = html || `<p class="empty">No decisions yet — the run log fills after the first pipeline run.</p>`;

    // ── expand / collapse ─────────────────────────────────────────────
    host.onclick = (e) => {
      const btn = e.target.closest(".decrow");
      if (!btn) return;
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      document.getElementById(btn.getAttribute("aria-controls")).classList.toggle("on", !open);
    };

    // ── filter ────────────────────────────────────────────────────────
    const counts = {
      all: decisions.length,
      executed: approved,
      blocked: total - approved,
    };
    seg.querySelectorAll("button").forEach((b) => {
      const c = b.querySelector(".count");
      if (c) c.textContent = counts[b.dataset.filter];
    });
    const apply = (mode) => {
      let shown = 0;
      host.querySelectorAll(".run").forEach((run) => {
        let visible = 0;
        run.querySelectorAll(".decrow").forEach((row) => {
          const s = row.dataset.status;
          const keep = mode === "all" || (mode === "executed" ? s !== "blocked" : s === "blocked");
          row.hidden = !keep;
          document.getElementById(row.getAttribute("aria-controls")).hidden = !keep;
          if (keep) visible++;
        });
        run.hidden = visible === 0;
        shown += visible;
      });
      $("#empty").hidden = shown > 0;
    };
    const onClick = (e) => {
      const btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      apply(btn.dataset.filter);
      try { localStorage.setItem("pm.activityFilter", btn.dataset.filter); } catch {}
    };
    seg.removeEventListener("click", onClick);
    seg.addEventListener("click", onClick);
    let saved = null;
    try { saved = localStorage.getItem("pm.activityFilter"); } catch {}
    if (saved && saved !== "all") {
      const target = seg.querySelector(`button[data-filter="${saved}"]`);
      if (target) target.click();
    }

    // ── footer ────────────────────────────────────────────────────────
    if (risk) {
      $("#foot-left").textContent =
        `Gate in force: benefit ≥ ${(risk.minExpectedBenefitPct * 100).toFixed(2)}% of order value · benefit ≥ ${risk.costBenefitMultiplier}× cost · ` +
        `order ≤ ${money(risk.maxOrderValue, currency)} · heat ≤ ${risk.maxHeatPct} · conviction ≥ ${risk.minConfidence.toFixed(2)}`;
    }
    $("#foot-right").textContent = `${decisions.length} decisions · ${orders.length} orders`;
  }

  function decisionRow(d, run, ordersByDecision, uid) {
    const order = ordersByDecision.get(d.id);
    const p = d.proposal;
    const id = "p" + uid;
    const statusKey = d.approved || order ? "executed" : "blocked";
    const benefitPct = p.estimatedValue > 0 ? (p.expectedBenefit / p.estimatedValue) * 100 : 0;
    const drift = d.details && typeof d.details.drift === "number" ? (d.details.drift * 100).toFixed(2) : null;

    const gateNote = order
      ? order.status === "FILLED"
        ? `filled ${fmt(order.fill.filledQuantity, 4)} @ ${money(order.fill.filledPriceAvg, order.fill.currency, 2)}`
        : order.status === "SUBMITTED" || order.status === "PENDING"
          ? "submitted · awaiting fill"
          : `gate cleared · ${esc(order.status.toLowerCase())}`
      : d.approved
        ? "cleared the gate"
        : `benefit ${benefitPct.toFixed(2)}% vs ${risk ? (risk.minExpectedBenefitPct * 100).toFixed(2) : "—"}% floor`;

    return (
      `<button class="decrow" type="button" aria-expanded="false" aria-controls="${id}" data-status="${statusKey}">` +
      PM.sidePill(d.action === "HOLD" && p.action !== "HOLD" ? p.action : d.action) +
      `<span class="intent"><b>${esc(d.ticker)}</b><span>${d.action === "HOLD" ? (p.action === "HOLD" ? "no trade" : "intent held at the gate") : `${fmt(p.estimatedValue, 2)} ${esc(p.currency)}`}</span></span>` +
      `<span class="decrow-val">${p.estimatedValue > 0 ? money(p.estimatedValue, p.currency) : "—"}</span>` +
      `<span class="gate-note">${esc(gateNote)}</span>` +
      `<span class="status-cell">${order ? PM.orderStatusPill(order.status) : PM.decisionPill(d)}</span>` +
      `<svg class="chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      `</button>` +
      `<div class="decpanel" id="${id}" data-status="${statusKey}"><div class="decpanel-in">` +
      `<div>` +
      `<p class="panel-title">Decision</p>` +
      `<dl class="kv">` +
      `<dt>Run</dt><dd>${esc(d.runId)}</dd>` +
      `<dt>At</dt><dd>${esc(fmtTime(d.decidedAt))}</dd>` +
      (d.details?.source === "committee" && d.details?.agentName
        ? `<dt>Committee</dt><dd>${esc(d.details.agentName)}${typeof d.details.points === "number" ? ` · ${d.details.points} pts` : ""}</dd>`
        : "") +
      `<dt>Recorded action</dt><dd>${d.approved ? esc(d.action) : "HOLD · no order placed"}</dd>` +
      `<dt>Order value</dt><dd>${p.estimatedValue > 0 ? money(p.estimatedValue, p.currency) : "—"}</dd>` +
      (drift !== null ? `<dt>Drift vs target</dt><dd>${drift}%</dd>` : "") +
      `<dt>Expected benefit</dt><dd>${p.estimatedValue > 0 ? money(p.expectedBenefit, p.currency) + " · " + benefitPct.toFixed(2) + "%" : "—"}</dd>` +
      `<dt>Estimated cost</dt><dd>${p.estimatedValue > 0 ? money(p.costEstimate.total, p.currency) : "—"}</dd>` +
      `<dt>Confidence</dt><dd>${p.confidence.toFixed(2)}</dd>` +
      `<dt>Verdict</dt><dd class="${d.approved ? "pos" : "neg"}">${esc(PM.REASON_SHORT[d.reason] ?? d.reason)}</dd>` +
      `</dl>` +
      `<p class="quote-block">${esc(p.rationale || "No rationale recorded.")}</p>` +
      `</div>` +
      `<div>` +
      `<p class="panel-title">${order ? "Execution" : "Economic gate"}</p>` +
      (order ? PM.execBlockHtml(order) : PM.gateListHtml(d, risk)) +
      `</div>` +
      `</div></div>`
    );
  }

  PM.setRefresh(load);
  load().then(PM.initTopbar).catch((err) => {
    $("#status-line").textContent = `error: ${err}`;
    $("#runs").innerHTML = `<p class="empty">error: ${esc(String(err))}</p>`;
  });
  setInterval(() => { load().catch(() => {}); }, 60_000);
})();
