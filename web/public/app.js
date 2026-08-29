/* Portfolio Manager — shared dashboard core.
   Vanilla JS, no build step. Loaded by every page before its page script.

   Provides:
   - formatting helpers (money, percent, time, escaping)
   - `initTopbar()` — account chip, last-run status, Run now (same pipeline +
     same cost/risk gates as the hourly scheduler, never a bypass), force-run
     checkbox, Asset Allocation Committee toggle, nav highlighting
   - reusable renderers: SVG value trend (hover tooltip), allocation ribbons,
     diverging drift bars, status/side pills, economic-gate checklist,
     execution block
   Everything the dashboard displays comes from the read-only /api endpoints. */
"use strict";

window.PM = (() => {
  /* ── helpers ─────────────────────────────────────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, dp = 2) =>
    n === null || n === undefined || Number.isNaN(n)
      ? "—"
      : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const pct = (n) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(2)}%`);
  const CURR = { GBP: "£", USD: "$", EUR: "€" };
  const curSym = (c) => CURR[c] || `${c} `;
  const money = (n, c, dp = 2) =>
    n === null || n === undefined || Number.isNaN(n) ? "—" : (n < 0 ? "−" : "") + curSym(c) + fmt(Math.abs(n), dp);
  const timeAgo = (iso) => {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${d.toLocaleString(undefined, { day: "2-digit", month: "short" })} · ${hh}:${mm}`;
  };
  const api = async (path) => {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };

  /* ── topbar: account chip, run status, Run now, committee toggle ──── */
  const RUN_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 3.2v9.6L13 8 4.5 3.2Z" fill="currentColor"/></svg>';
  let runInProgress = false;
  let activeRunId = null;
  let refreshHook = null;

  function setRefresh(fn) {
    refreshHook = fn;
  }

  async function initTopbar() {
    const [ov, cmt] = await Promise.all([api("/api/overview"), api("/api/committee").catch(() => null)]);

    // nav highlighting
    const page = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".navlinks a").forEach((a) => {
      if (a.getAttribute("href") === page) a.setAttribute("aria-current", "page");
    });

    // account chip: mode · broker · currency
    const broker = ov.broker ?? {};
    const kind = broker.kind === "paper" ? "Paper" : "Trading212";
    const env = broker.kind === "paper" ? "PAPER" : broker.environment === "demo" ? "DEMO" : "LIVE";
    const chip = $("#acct-chip");
    if (chip) {
      chip.innerHTML = `<span class="dot" aria-hidden="true"></span><b>${env}</b> · ${kind} · ${esc(ov.accountCurrency)}`;
      if (broker.kind === "paper") chip.querySelector(".dot").style.background = "var(--muted)";
    }
    window.__modeLabel =
      broker.kind === "paper"
        ? "PAPER (simulated)"
        : broker.environment === "demo"
          ? "LIVE — DEMO ACCOUNT"
          : "LIVE (real money)";
    window.__risk = ov.risk ?? null;
    window.__accountCurrency = ov.accountCurrency ?? "GBP";

    // force-run checkbox (persisted)
    const force = $("#force-run");
    if (force) {
      let saved = "1";
      try { saved = localStorage.getItem("pm.forceRun") ?? "1"; } catch {}
      force.checked = saved !== "0";
      force.addEventListener("change", () => {
        try { localStorage.setItem("pm.forceRun", force.checked ? "1" : "0"); } catch {}
      });
    }

    // committee toggle (next run uses the chosen flow; gates unchanged)
    const cmtToggle = $("#committee-enabled");
    if (cmtToggle) {
      cmtToggle.checked = Boolean(cmt?.enabled);
      cmtToggle.addEventListener("change", async (e) => {
        const enabled = e.target.checked;
        try {
          const res = await fetch("/api/committee/enable", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(`Could not ${enabled ? "enable" : "disable"} the committee: ${data.error ?? res.status}`);
            e.target.checked = !enabled;
            return;
          }
        } catch (err) {
          alert(`Committee toggle error: ${err}`);
          e.target.checked = !enabled;
        }
      });
    }

    // last-run status + running-state recovery
    const run = ov.lastRun;
    const line = $("#status-line");
    if (line) {
      if (!run) line.textContent = "no runs yet";
      else if (run.status === "RUNNING") line.innerHTML = `<b>Running…</b> ${esc(run.id)}`;
      else
        line.innerHTML =
          `<b>${esc(run.status)}</b> · ${esc(timeAgo(run.startedAt))}` +
          (run.error ? ` — <span class="neg">${esc(run.error)}</span>` : "");
    }
    syncRunUi(run);

    // Run now — same pipeline + gates as the hourly scheduler.
    $("#run-now")?.addEventListener("click", async () => {
      if (runInProgress || activeRunId) return;
      const forceNow = $("#force-run")?.checked ?? false;
      const ok = confirm(
        `Run the full hourly cycle now?\n\nAccount: ${window.__modeLabel}\nForce (ignore market hours): ${forceNow ? "yes" : "no"}\n\nThis runs analysis → allocation → cost-gated decisions and MAY PLACE TRADES through the same gates as the scheduled runs.`,
      );
      if (!ok) return;
      const btn = $("#run-now");
      btn.disabled = true;
      btn.innerHTML = "Running…";
      runInProgress = true;
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: forceNow }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 409 && data.runId) {
            alert(`A run is already in progress (${data.runId}) — tracking it instead of starting a new one.`);
            activeRunId = data.runId;
            void watchRun(data.runId);
            return;
          }
          alert(`Run failed to start: ${data.error ?? res.status}`);
          return;
        }
        activeRunId = null;
        await refreshHook?.();
      } catch (err) {
        alert(`Run trigger error: ${err}`);
      } finally {
        runInProgress = false;
        const after = $("#run-now");
        if (activeRunId === null) after.innerHTML = RUN_ICON + "Run now";
      }
    });
  }

  /** Keeps the button in the running state if a run is still in flight. */
  function syncRunUi(run) {
    const btn = $("#run-now");
    if (!btn) return;
    if (run && run.status === "RUNNING") {
      btn.disabled = true;
      btn.innerHTML = "Running…";
      if (activeRunId !== run.id) {
        activeRunId = run.id;
        void watchRun(run.id);
      }
    } else if (activeRunId === null) {
      btn.disabled = false;
      btn.innerHTML = RUN_ICON + "Run now";
    }
  }

  /** Polls /api/overview until the watched run settles, then re-renders. */
  async function watchRun(runId) {
    while (activeRunId === runId) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const ov = await api("/api/overview");
        const run = ov.lastRun;
        if (run && run.id === runId && run.status !== "RUNNING") {
          activeRunId = null;
          const line = $("#status-line");
          if (line)
            line.innerHTML =
              `<b>${esc(run.status)}</b> · ${esc(runId)}` +
              (run.error ? ` — <span class="neg">${esc(run.error)}</span>` : "");
          await refreshHook?.();
          return;
        }
      } catch {
        // transient fetch failure — keep watching until the run settles
      }
    }
  }

  /* ── value-per-run SVG trend (hover tooltip) ──────────────────────── */
  function renderTrendSvg(svg, tip, series, unit = "") {
    if (!svg) return;
    const W = 1120, H = 210, PAD_T = 16, PAD_B = 16;
    // guard against a single-point series
    if (series.length === 1) series = [series[0], { ...series[0], t: series[0].t + " " }];
    if (series.length === 0) return;
    const lo = Math.min(...series.map((d) => d.v));
    const hi = Math.max(...series.map((d) => d.v));
    const span = hi - lo || 1;
    const x = (i) => (i / (series.length - 1)) * W;
    const y = (v) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B);
    const line = series.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d.v).toFixed(1)).join(" ");
    const area = line + " L" + W + " " + H + " L0 " + H + " Z";
    const ns = "http://www.w3.org/2000/svg";
    const el = (name, attrs) => {
      const n = document.createElementNS(ns, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    svg.replaceChildren();
    [H - 0.5, PAD_T + (H - PAD_T - PAD_B) / 2].forEach((yy) => {
      svg.appendChild(el("line", { x1: 0, x2: W, y1: yy, y2: yy, class: "chart-grid" }));
    });
    svg.appendChild(el("path", { d: area, class: "chart-area" }));
    svg.appendChild(el("path", { d: line, class: "chart-line" }));
    const cursor = el("line", { x1: 0, x2: 0, y1: 0, y2: H, class: "chart-cursor", opacity: 0 });
    svg.appendChild(cursor);
    const last = series.length - 1;
    const dot = el("circle", { r: 4.5, cx: x(last), cy: y(series[last].v), class: "chart-dot" });
    svg.appendChild(dot);
    const hit = el("rect", { x: 0, y: 0, width: W, height: H, class: "chart-hit" });
    svg.appendChild(hit);

    const show = (i) => {
      const d = series[i];
      cursor.setAttribute("opacity", 1);
      cursor.setAttribute("x1", x(i));
      cursor.setAttribute("x2", x(i));
      dot.setAttribute("cx", x(i));
      dot.setAttribute("cy", y(d.v));
      const delta = d.v - series[0].v;
      tip.innerHTML = `<b>${esc(unit)}${d.v.toFixed(2)}</b> &nbsp;${delta >= 0 ? "+" : "−"}${esc(unit)}${Math.abs(delta).toFixed(2)}<br>${esc(d.t)}`;
      const box = svg.getBoundingClientRect();
      tip.style.left = box.width * (x(i) / W) + "px";
      tip.style.top = box.height * (y(d.v) / H) - 12 + "px";
      tip.classList.add("on");
    };
    const reset = () => {
      cursor.setAttribute("opacity", 0);
      dot.setAttribute("cx", x(last));
      dot.setAttribute("cy", y(series[last].v));
      tip.classList.remove("on");
    };
    hit.addEventListener("mousemove", (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.round(((e.clientX - box.left) / box.width) * (series.length - 1));
      show(Math.max(0, Math.min(series.length - 1, i)));
    });
    hit.addEventListener("mouseleave", reset);
  }

  /* ── allocation ribbons ───────────────────────────────────────────── */
  const RIBBON_STOPS = [88, 72, 56, 40, 24];
  const segColor = (i) => `color-mix(in oklch, var(--fg) ${RIBBON_STOPS[Math.min(i, RIBBON_STOPS.length - 1)]}%, var(--bg))`;
  /** segs: [{ label, pct, cash? }] — widths must sum to ~100. */
  function ribbonHtml(segs) {
    return segs
      .map(
        (s, i) =>
          `<div class="ribbon-seg${s.cash ? " cash" : ""}" style="width:${s.pct.toFixed(2)}%;${s.cash ? "" : `background:${segColor(i)}`}" title="${esc(s.label)} · ${s.pct.toFixed(2)}%"></div>`,
      )
      .join("");
  }
  function legendHtml(segs) {
    return segs
      .map(
        (s, i) =>
          `<span class="legend-item"><span class="legend-swatch" style="${s.cash ? "background:repeating-linear-gradient(135deg, var(--fg-soft) 0 4px, transparent 4px 8px);border:1px solid var(--border)" : `background:${segColor(i)}`}"></span>${esc(s.label)} <span class="num">${s.pct.toFixed(1)}%</span></span>`,
      )
      .join("");
  }

  /* ── diverging drift bar (half-track = 10pp, red outside the band) ── */
  function driftCellHtml(driftPp, bandPct) {
    const out = Math.abs(driftPp) > bandPct;
    const w = Math.max(2, Math.min((Math.abs(driftPp) / 10) * 50, 50));
    const color = out ? "var(--neg)" : "color-mix(in oklch, var(--fg) 34%, transparent)";
    const pos = driftPp >= 0 ? "left:50%" : "right:50%";
    return (
      `<span class="drift"><span class="drift-track"><span class="drift-fill" style="${pos};width:${w.toFixed(1)}%;background:${color}"></span></span>` +
      `<span class="drift-val${out ? " neg" : ""}">${driftPp >= 0 ? "+" : "−"}${Math.abs(driftPp).toFixed(2)}pp</span></span>`
    );
  }

  /* ── pills ────────────────────────────────────────────────────────── */
  function sidePill(side) {
    if (side === "BUY") return '<span class="pill pill-buy">Buy</span>';
    if (side === "SELL") return '<span class="pill pill-sell">Sell</span>';
    return '<span class="pill pill-hold">Hold</span>';
  }
  function orderStatusPill(status) {
    const s = String(status ?? "");
    if (s === "FILLED") return '<span class="pill pill-filled">Filled</span>';
    if (s === "PARTIALLY_FILLED") return '<span class="pill pill-open">Partially filled</span>';
    if (s === "SUBMITTED" || s === "PENDING") return '<span class="pill pill-open">Open at broker</span>';
    if (s === "REJECTED" || s === "FAILED") return '<span class="pill pill-danger">Failed</span>';
    if (s === "CANCELLED") return '<span class="pill pill-hold">Cancelled</span>';
    return '<span class="pill pill-blocked">Blocked</span>';
  }
  const REASON_SHORT = {
    ECONOMICALLY_VIABLE: "Cleared the gate",
    OPPORTUNITY_TOO_SMALL: "Below benefit floor",
    COST_EXCEEDS_BENEFIT: "Costs exceed benefit",
    RISK_LIMIT_EXCEEDED: "Risk limit",
    NO_CONVICTION: "No conviction",
    INSUFFICIENT_CASH: "Insufficient cash",
    MARKET_CLOSED: "Market closed",
    INSTRUMENT_UNAVAILABLE: "No instrument quote",
    COOLDOWN_ACTIVE: "Cooldown",
  };
  function decisionPill(dec) {
    if (dec.approved) return '<span class="pill pill-filled">Cleared</span>';
    return '<span class="pill pill-blocked">Blocked</span>';
  }

  /* ── economic gate checklist (numbers straight from the decision) ─── */
  function gateListHtml(dec, risk) {
    if (!risk) return `<p class="sub">gate limits unavailable</p>`;
    const p = dec.proposal;
    const val = p.estimatedValue;
    const benefitPct = val > 0 ? (p.expectedBenefit / val) * 100 : 0;
    const heat = dec.details && typeof dec.details.heat === "number" ? dec.details.heat : null;
    const c = p.costEstimate;
    const items = [
      ["Benefit floor", p.expectedBenefit >= risk.minExpectedBenefitPct * val, `${benefitPct.toFixed(2)}% vs ${(risk.minExpectedBenefitPct * 100).toFixed(2)}% min`],
      ["Cost coverage", p.expectedBenefit >= c.total * risk.costBenefitMultiplier, `${money(p.expectedBenefit, c.currency)} vs ${money(c.total * risk.costBenefitMultiplier, c.currency)} min`],
      ["Order size", val <= risk.maxOrderValue, `${money(val, c.currency)} vs ${money(risk.maxOrderValue, c.currency)} max`],
      ["Conviction", p.confidence >= risk.minConfidence, `${p.confidence.toFixed(2)} vs ${risk.minConfidence.toFixed(2)} min`],
    ];
    if (heat !== null) items.splice(3, 0, ["Portfolio heat", heat <= risk.maxHeatPct, `${heat.toFixed(3)} vs ${risk.maxHeatPct} cap`]);
    return (
      '<ul class="gate">' +
      items
        .map(
          (it) =>
            `<li class="${it[1] ? "pass" : "fail"}"><span class="g-mark">${it[1] ? "✓" : "✕"}</span>` +
            `<span class="g-name">${it[0]}</span><span class="g-num">${it[2]}</span></li>`,
        )
        .join("") +
      "</ul>"
    );
  }

  /* ── execution block (order lifecycle) ────────────────────────────── */
  function execBlockHtml(o) {
    const rows =
      `<dt>Order</dt><dd>${esc(o.id)}</dd>` +
      (o.brokerOrderId ? `<dt>Broker ref</dt><dd>${esc(o.brokerOrderId)}</dd>` : "") +
      `<dt>Quantity</dt><dd>${fmt(o.quantity, 4)}</dd>` +
      (o.submittedAt ? `<dt>Submitted</dt><dd>${esc(fmtTime(o.submittedAt))}</dd>` : "") +
      `<dt>Status</dt><dd>${esc(o.status)}</dd>`;
    if (o.fill) {
      const c = o.fill.realizedCost;
      return (
        `<dl class="kv">${rows}` +
        `<dt>Filled</dt><dd>${esc(fmtTime(o.fill.filledAt))}</dd>` +
        `<dt>Fill price</dt><dd>${money(o.fill.filledPriceAvg, o.fill.currency, 4)}</dd>` +
        `<dt>Filled qty</dt><dd>${fmt(o.fill.filledQuantity, 4)}</dd>` +
        `<dt>Realised cost</dt><dd>${money(c.total, o.currency)}</dd>` +
        `<dt>&nbsp;&nbsp;spread / FX</dt><dd class="sub">${money(c.spread, o.currency)} / ${money(c.fxFee, o.currency)}</dd>` +
        `<dt>&nbsp;&nbsp;stamp / platform</dt><dd class="sub">${money(c.stampDuty, o.currency)} / ${money(c.platformFee, o.currency)}</dd>` +
        `</dl>`
      );
    }
    return `<dl class="kv">${rows}</dl>`;
  }

  return {
    $, esc, fmt, pct, money, curSym, timeAgo, fmtTime, api,
    initTopbar, setRefresh, renderTrendSvg, ribbonHtml, legendHtml,
    driftCellHtml, sidePill, orderStatusPill, decisionPill, REASON_SHORT,
    gateListHtml, execBlockHtml,
  };
})();
