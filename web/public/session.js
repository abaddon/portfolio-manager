/* Committee session detail page: the latest Asset Allocation Committee
   session rendered in full — vote outcome, proposals, peer review, applied
   targets and the orders at the economic gate. Read-only. */
"use strict";

(function () {
  const { $, esc, money, fmtTime, api } = PM;

  async function load() {
    const [cmt, ov] = await Promise.all([api("/api/committee").catch(() => null), api("/api/overview")]);
    const currency = ov.accountCurrency ?? "GBP";
    const maxTarget = ov.allocation?.adaptation?.maxTarget ?? null;
    const detail = cmt?.latestSession ?? null;
    if (!detail || !detail.session) {
      renderEmpty(cmt, currency);
      return;
    }
    const hist = await api("/api/portfolio/history?limit=500").catch(() => null);
    const navByRun = new Map((hist?.history ?? []).map((s) => [s.runId, s.totalValue]));
    const run = await api(`/api/runs/${encodeURIComponent(detail.session.runId)}`).catch(() => null);
    render(detail, currency, maxTarget, navByRun.get(detail.session.runId) ?? null, run, ov.risk ?? null);
  }

  function renderEmpty(cmt, currency) {
    $("#session-head").style.display = "none";
    const host = $("#session-main");
    host.innerHTML =
      `<section class="band"><div class="wrap">` +
      `<p class="eyebrow">Asset allocation committee</p>` +
      `<h1 class="h2" style="font-size:30px;margin:8px 0 18px">No committee session yet</h1>` +
      `<p class="sub p-note" style="max-width:70ch">` +
      (cmt?.enabled
        ? `The committee is enabled — press “Run now” to hold the first session (propose → feedback → vote → apply).`
        : `The committee is disabled, so the classic flow runs. Toggle “Committee” in the top bar and press “Run now” to hold the first session.`) +
      `</p></div></section>`;
    $("#foot-left").textContent = "Asset Allocation Committee";
    $("#foot-right").textContent = "";
  }

  function render(detail, currency, maxTarget, nav, run, risk) {
    const s = detail.session;
    const proposals = detail.proposals ?? [];
    const feedback = detail.feedback ?? [];
    const votes = detail.votes ?? [];
    const winner = proposals.find((p) => p.id === s.winnerProposalId) ?? proposals.find((p) => p.status === "accepted") ?? null;
    const sorted = proposals.slice().sort((a, b) => b.points - a.points || a.createdAt.localeCompare(b.createdAt));
    const maxPoints = Math.max(1, ...sorted.map((p) => p.points));

    // ── header ────────────────────────────────────────────────────────
    $("#crumb-time").textContent = fmtTime(s.createdAt);
    $("#session-eyebrow").textContent = `Asset allocation committee · session ${esc(s.id)}`;
    $("#session-title").textContent = winner
      ? `${winner.agentName} won with ${winner.points} ${winner.points === 1 ? "point" : "points"}`
      : s.status === "FAILED"
        ? "Session failed"
        : `Session ${s.status.toLowerCase()}`;
    const started = new Date(s.createdAt).getTime();
    const finished = s.completedAt ? new Date(s.completedAt).getTime() : null;
    const dur = finished ? Math.round((finished - started) / 1000) : null;
    $("#session-meta").innerHTML =
      `<span class="pill ${s.status === "COMPLETED" ? "pill-plain" : s.status === "FAILED" ? "pill-danger" : "pill-open"}">${esc(s.status)}</span>` +
      `<span class="meta">${esc(s.id)} · run ${esc(s.runId)}${dur !== null ? ` · ${dur}s` : ""}</span>` +
      (nav !== null ? `<span class="meta">NAV ${money(nav, currency)}</span>` : "") +
      (s.error ? `<span class="meta neg">${esc(s.error)}</span>` : "");

    // ── votes ─────────────────────────────────────────────────────────
    const scoreRows = sorted
      .map((p) => {
        const isWinner = winner && p.id === winner.id;
        const statusPill = isWinner
          ? '<span class="pill pill-accent">Accepted</span>'
          : p.status === "excluded"
            ? '<span class="pill pill-blocked">Excluded</span>'
            : p.points === 0
              ? '<span class="pill pill-hold">No votes</span>'
              : '<span class="pill pill-plain">Defeated</span>';
        return `<div class="agentrow">
          <span class="agent-id"><b>${esc(p.agentName)}</b><span>${esc(p.agentModel)}</span></span>
          <span class="ptrack-cell"><span class="ptrack"><span class="pfill${isWinner ? " win" : ""}" style="width:${Math.round((p.points / maxPoints) * 100)}%"></span></span></span>
          <span class="ptotal">${p.points}<span>${p.points === 1 ? "pt" : "pts"}</span></span>
          <span style="text-align:right">${statusPill}</span>
        </div>`;
      })
      .join("");
    $("#agent-scores").innerHTML = scoreRows || '<p class="sub">no proposals recorded.</p>';

    // one vote matrix per round
    const rounds = [...new Set(votes.map((v) => v.round))].sort((a, b) => a - b);
    $("#vote-matrix").innerHTML = rounds
      .map((round) => {
        const roundVotes = votes.filter((v) => v.round === round);
        const voters = [...new Set(roundVotes.map((v) => v.voterAgentName))];
        const totals = new Map();
        for (const v of roundVotes) totals.set(v.proposalId, (totals.get(v.proposalId) ?? 0) + v.points);
        const head = `<tr><th scope="col">Voter</th>${sorted.map((p) => `<th scope="col" class="r">→ ${esc(shortTitle(p.title))}</th>`).join("")}</tr>`;
        const body = voters
          .map((voter) => {
            const cells = sorted
              .map((p) => {
                const v = roundVotes.find((x) => x.voterAgentName === voter && x.proposalId === p.id);
                return v ? `<td>${v.points}</td>` : `<td class="dim">0</td>`;
              })
              .join("");
            return `<tr><th scope="row" style="font-weight:400">${esc(voter)}</th>${cells}</tr>`;
          })
          .join("");
        const foot = `<tfoot><tr><td>Total</td>${sorted.map((p) => `<td>${totals.get(p.id) ?? 0}</td>`).join("")}</tr></tfoot>`;
        return (
          `<p class="panel-title" style="margin-top:26px">Vote round ${round}</p>` +
          `<table class="vmatrix"><thead>${head}</thead><tbody>${body}</tbody>${foot}</table>`
        );
      })
      .join("");
    $("#vote-title").textContent =
      rounds.length <= 1 ? "A clear majority in round one" : `${rounds.length} vote rounds to a decision`;

    // ── proposals ─────────────────────────────────────────────────────
    $("#proposals-title").textContent = `${sorted.length} ${sorted.length === 1 ? "proposal" : "proposals"} on the table`;
    $("#proposal-cards").innerHTML = sorted
      .map((p) => {
        const isWinner = winner && p.id === winner.id;
        const chips = (p.targets ?? [])
          .map((t) => `<span class="chip"><b>${esc(t.ticker)}</b>${(t.weight * 100).toFixed(1)}%</span>`)
          .join("");
        const orders = (p.orders ?? [])
          .map(
            (o) =>
              `<li><b>${esc(o.ticker)}</b><span class="amt">${o.side === "BUY" ? "BUY" : "SELL"} ${money(o.value, currency)}</span><span class="rsn">${esc(o.reason)}</span></li>`,
          )
          .join("");
        return `<article class="card${isWinner ? " card-win" : ""}">
          <div class="prop-head">
            <span class="who"><b>${esc(p.agentName)}</b><span>${esc(p.agentModel)} · ${esc(p.id)}</span></span>
            <span class="marks">
              <span class="meta">confidence ${p.confidence.toFixed(2)}</span>
              <span class="pill ${isWinner ? "pill-accent" : p.points === 0 ? "pill-hold" : "pill-plain"}">${isWinner ? "Accepted · " + p.points + " pts" : p.status === "excluded" ? "Excluded" : p.points + " pts"}</span>
            </span>
          </div>
          <p class="prop-title">${esc(p.title)}</p>
          <div class="chips">${chips || '<span class="chip chip-hold">no target changes</span>'}</div>
          <ul class="orderlist">${orders || '<li class="rsn">No orders proposed.</li>'}</ul>
          <p class="quote-block">${esc(truncate(p.rationale, 600))}</p>
        </article>`;
      })
      .join("");

    // ── peer review ───────────────────────────────────────────────────
    const byProposal = new Map(sorted.map((p) => [p.id, []]));
    for (const f of feedback) {
      if (!byProposal.has(f.proposalId)) byProposal.set(f.proposalId, []);
      byProposal.get(f.proposalId).push(f);
    }
    let reviewCount = 0;
    const reviewCards = sorted
      .map((p) => {
        const revs = byProposal.get(p.id) ?? [];
        reviewCount += revs.length;
        return revs
          .map(
            (f) =>
              `<article class="card">
                <div class="prop-head" style="margin-bottom:12px">
                  <span class="who"><b>${esc(f.reviewerAgentName)}</b><span>reviewing ${esc(shortTitle(p.title))}</span></span>
                  <span class="marks"><span class="pill ${f.verdict === "positive" ? "pill-filled" : "pill-danger"}">${esc(f.verdict)}</span></span>
                </div>
                <p class="sub" style="line-height:1.65">“${esc(f.comment)}”</p>
              </article>`,
          )
          .join("");
      })
      .join("");
    $("#review-eyebrow").textContent = `Peer review · ${reviewCount} ${reviewCount === 1 ? "review" : "reviews"} across ${sorted.length} proposals`;
    $("#review-cards").innerHTML = reviewCards || '<p class="sub">No peer reviews recorded for this session.</p>';

    // ── outcome: applied targets ──────────────────────────────────────
    const targets = winner?.targets ?? [];
    $("#targets-rows").innerHTML = targets.length
      ? targets
          .map((t) =>
            `<tr><td><span class="tick"><b>${esc(t.ticker)}</b></span></td>` +
            `<td class="r num">${(t.weight * 100).toFixed(2)}%</td>` +
            `<td class="sub">${maxTarget !== null && t.weight >= maxTarget ? `At the <span class="num">maxTarget ${(maxTarget * 100).toFixed(0)}%</span> ceiling` : "Applied by the winning proposal"}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="3" class="sub">The winning proposal did not change any targets.</td></tr>`;

    // ── outcome: orders at the gate ───────────────────────────────────
    // This page renders for a specific committee session, so every decision
    // of its run came from the committee's order intents through the gate.
    const decisions = run?.decisions ?? [];
    const mult = risk?.costBenefitMultiplier ?? 1.5;
    const rows = decisions
      .map((d) => {
        const p = d.proposal;
        const benefitPct = p.estimatedValue > 0 ? (p.expectedBenefit / p.estimatedValue) * 100 : null;
        return `<tr>
          <td><span class="tick">${PM.sidePill(intentSide(d))} <b>${esc(d.ticker)}</b></span></td>
          <td class="r num">${p.estimatedValue > 0 ? money(p.estimatedValue, p.currency) : "—"}</td>
          <td class="r num">${p.estimatedValue > 0 ? money(p.expectedBenefit, p.currency) : "—"}</td>
          <td class="r num ${d.approved ? "" : "neg"}">${benefitPct === null ? "—" : benefitPct.toFixed(2) + "%"}</td>
          <td class="r num hide-sm">${p.estimatedValue > 0 ? money(p.costEstimate.total, p.currency) + " · " + money(p.costEstimate.total * mult, p.currency) + ` <span class="${p.expectedBenefit >= p.costEstimate.total * mult ? "pos" : "neg"}">${p.expectedBenefit >= p.costEstimate.total * mult ? "✓" : "✕"}</span>` : "—"}</td>
          <td class="r">${d.approved ? '<span class="pill pill-filled">Cleared</span>' : `<span class="pill ${d.reason === "RISK_LIMIT_EXCEEDED" ? "pill-danger" : "pill-blocked"}">${esc(PM.REASON_SHORT[d.reason] ?? d.reason)}</span>`}</td>
        </tr>`;
      })
      .join("");
    const totalValue = decisions.reduce((s, d) => s + d.proposal.estimatedValue, 0);
    const totalBenefit = decisions.reduce((s, d) => s + d.proposal.expectedBenefit, 0);
    const cleared = decisions.filter((d) => d.approved).length;
    $("#gate-rows").innerHTML =
      rows || `<tr><td colspan="6" class="sub">No orders proposed in this session.</td></tr>`;
    $("#gate-foot").innerHTML = decisions.length
      ? `<tr>
          <td>${decisions.length} ${decisions.length === 1 ? "order" : "orders"}</td>
          <td class="r num">${money(totalValue, currency)}</td>
          <td class="r num">${money(totalBenefit, currency)}</td>
          <td class="r num">${totalValue > 0 ? ((totalBenefit / totalValue) * 100).toFixed(2) + "%" : "—"}</td>
          <td class="r hide-sm"></td>
          <td class="r num">${cleared} cleared</td>
        </tr>`
      : "";
    $("#outcome-note").textContent =
      decisions.length === 0
        ? "The committee session completed without any order intents reaching the economic gate."
        : `${cleared} of ${decisions.length} orders cleared the gate and went to the broker; the rest were blocked at the same cost/risk gates the hourly scheduler uses.`;

    $("#foot-left").textContent = `Session ${esc(s.id)} · ${sorted.length} managers · ${sorted.length} proposals · ${reviewCount} peer reviews · ${rounds.length} vote rounds`;
    $("#foot-right").textContent = `${fmtTime(s.createdAt)}${s.completedAt ? ` – ${fmtTime(s.completedAt)}` : ""}`;
  }

  function shortTitle(t) {
    const s = String(t ?? "");
    return s.length > 42 ? s.slice(0, 41) + "…" : s;
  }
  /** The gate rewrites blocked intents to HOLD; the intended side lives on the proposal. */
  function intentSide(d) {
    return d.action !== "HOLD" || !d.proposal || d.proposal.action === "HOLD" ? d.action : d.proposal.action;
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  PM.setRefresh(load);
  load().then(PM.initTopbar).catch((err) => {
    $("#status-line").textContent = `error: ${err}`;
    $("#session-title").textContent = `error: ${err}`;
  });
  setInterval(() => { load().catch(() => {}); }, 60_000);
})();
