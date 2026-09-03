# Investment decision — flowchart

Visual companion to [DECISION_PROCESS.md](./DECISION_PROCESS.md). Three Mermaid charts: the end-to-end hourly pipeline, the economic-correctness gate (`DecisionEngine.evaluate`, `src/domain/decision.ts`), and order execution. Every box below is implemented behavior, not aspiration.

Since [ADR 0009](./ADRs/0009-unified-committee-decision-flow.md) there is exactly **one** flow: the Asset Allocation Committee manages every allocation change and every order.

---

## 1. End-to-end: from trigger to order

```mermaid
flowchart TD
    Start(["Trigger: every market-open hour at minute 0 (scheduler)<br/>or dashboard ▶ Run now (skips the hour guard)"])
    Start --> HK["Housekeeping — Trading212 broker only, BEFORE the guard:<br/>• reconcile stale PENDING orders vs broker open orders<br/>• sweep SUBMITTED orders for late fills<br/>• re-submit quantity-precision failures"]

    HK --> Guard{"Hour guard: a run already exists<br/>for this market hour<br/>(and is not FAILED)?"}
    Guard -->|"yes — scheduled/startup run"| Skip(["SKIPPED — no new run"])
    Guard -->|"no — or manual run, or previous run FAILED"| Targets{"Allocation targets exist?<br/>allocation_targets rows or config seeds"}

    Targets -->|"none anywhere & broker holds positions"| Bootstrap["Bootstrap: current broker position weights<br/>become the initial targets (persisted once,<br/>event TargetsBootstrapped)"]
    Targets -->|"none anywhere & broker empty"| CfgErr(["ConfigurationError — run fails"])
    Targets -->|"yes"| Analysis
    Bootstrap --> Analysis

    Analysis["Market analysis — per universe ticker, 4 analysts<br/>LLM-backed, offline rule-based fallback; FRED macro shared by all.<br/>Per-source failures are contained (null + continue)."]
    Analysis --> Eval["Portfolio evaluation — broker = source of truth:<br/>snapshot (cash, positions, weights) • drift = weight − target<br/>heat = Σ weight × (1 − stopDistancePct) • unitized NAV<br/>(external cash flows mint/redeem units) • SPY alpha"]

    Eval --> Session["Committee session — the ONE decision flow (ADR 0009):<br/>1 PROPOSE — each agent proposes targets + orders<br/>2 FEEDBACK — every agent reviews every other proposal<br/>3 VOTE — one vote each; ties → exclusion run-offs<br/>4 APPLY — winner's targets persisted under the<br/>per-name cap + cash-floor guardrails"]

    Session -->|"session FAILED (LLM error, bad vote, …)"| Contained(["Run completes: no target changes,<br/>no orders this run"])
    Session -->|"winner decided"| Gate["Winner's order intents: priced (live quote + FX)<br/>→ SAME economic gate for every order (chart 2)"]

    Gate -->|"rejected"| Persist1(["Decision persisted with exact reason"])
    Gate -->|"approved"| Exec["Execution (chart 3):<br/>rank by expected benefit, cap maxOrdersPerRun,<br/>two-phase PENDING → submit → fill confirmation"]
```

---

## 2. The economic-correctness gate (`DecisionEngine.evaluate`)

Checks run **in this exact order**; the first failure sets the rejection reason. The gate is identical for every order — the committee never bypasses it.

```mermaid
flowchart TD
    P(["Priced committee order intent + context<br/>(cash, heat, NAV, cooled tickers)"]) --> G1{"action = HOLD?"}
    G1 -->|"yes"| OK(["Approved: ECONOMICALLY_VIABLE"])
    G1 -->|"no"| G2{"quantity > 0?"}
    G2 -->|"no"| R1(["OPPORTUNITY_TOO_SMALL"])
    G2 -->|"yes"| G3{"winner confidence ≥ minConfidence?"}
    G3 -->|"no"| R2(["NO_CONVICTION"])
    G3 -->|"yes"| G4{"order value ≤ maxOrderValue?"}
    G4 -->|"no"| R3(["RISK_LIMIT_EXCEEDED"])
    G4 -->|"yes"| G5{"ticker outside cooldown window?<br/>(tickerCooldownDays, any side)"}
    G5 -->|"no"| R4(["COOLDOWN_ACTIVE"])
    G5 -->|"yes"| G6{"expectedBenefit ≥ minExpectedBenefitPct × orderValue?"}
    G6 -->|"no"| R5(["OPPORTUNITY_TOO_SMALL"])
    G6 -->|"yes"| G7{"expectedBenefit ≥ totalCosts × costBenefitMultiplier?"}
    G7 -->|"no"| R6(["COST_EXCEEDS_BENEFIT"])
    G7 -->|"yes"| G8{"action = BUY?"}
    G8 -->|"no — SELL: no cash/heat checks"| OK
    G8 -->|"yes"| G9{"orderValue ≤ cash?"}
    G9 -->|"no"| R7(["INSUFFICIENT_CASH"])
    G9 -->|"yes"| G10{"heat + orderValue/NAV ≤ maxHeatPct?"}
    G10 -->|"no"| R8(["RISK_LIMIT_EXCEEDED"])
    G10 -->|"yes"| OK
```

Where `expectedBenefit = orderValue × expectedReturnPerTradePct/100 × (0.5 + 0.5 × confidence)`.
Every decision — approved **or** rejected — is persisted with its full rationale.

---

## 3. Execution: approved decisions become orders

```mermaid
flowchart TD
    A(["Approved committee orders"]) --> B["Rank by expected benefit (best first)<br/>cap at maxOrdersPerRun"]
    B --> C["Persist order as PENDING — before anything is sent<br/>(T212 placement is not idempotent: a crash can<br/>never lose or double an intent)"]
    C --> D["Submit market order to Trading212<br/>sell = negative quantity • symbol → instrument id"]
    D --> E{"Broker response"}
    E -->|"quantity-precision-mismatch"| F["Retry with N−1 decimals (floor 0);<br/>write back accepted quantity.<br/>Still failing ⇒ re-tried on next run (400 = never created)"]
    E -->|"accepted"| S{"Broker state"}
    E -->|"error"| FAIL(["FAILED / REJECTED (event OrderRejected/OrderFailed)"])
    F --> S
    S -->|"FILLED"| H["Confirm fill: broker quantity + fill price;<br/>partial fill ⇒ align qty, record details.partialFill;<br/>realized costs recomputed on fillPrice/estimatedPrice"]
    S -->|"NEW / PARTIALLY_FILLED"| I["Poll once after ~1.5 s;<br/>still open ⇒ leave SUBMITTED"]
    I --> J["Next run's housekeeping sweep re-polls;<br/>fills that 404 on the active endpoint are looked up<br/>in /equity/history/orders and confirmed"]
```

Crash recovery: stale PENDING (>15 min) is matched against broker open orders (ticker, side, qty, ±15 min) — match ⇒ adopt broker id, no match ⇒ FAILED. **Never blind re-submission.**
