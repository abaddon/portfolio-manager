import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppPorts } from "../../application/ports.js";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../shared/logger.js";
import { RunInProgressError, type Run } from "../../domain/run.js";
import type { CommitteeService } from "../../application/services/committee.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Minimal surface the dashboard needs to trigger the pipeline. */
export interface RunTrigger {
  runOnce(opts?: { force?: boolean; skipHourGuard?: boolean }): Promise<Run>;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  /** Exposed for contract tests (Fastify inject). */
  readonly instance: FastifyInstance;
}

/**
 * Dashboard API + static UI. Every GET endpoint is read-only. The one
 * mutating surface is POST /api/run — the manual "Run now" button — which
 * executes the exact same pipeline (and the same cost/risk gates) as the
 * hourly scheduler, never a bypass.
 */
export function buildWebServer(
  ports: AppPorts,
  config: AppConfig,
  logger: Logger,
  brokerEnvironment: "paper" | "demo" | "live" = "paper",
  runTrigger?: RunTrigger,
  committee?: CommitteeService,
): WebServer {
  const server: FastifyInstance = Fastify({ logger: false });
  const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public");
  let runInFlight: { id: string; startedAt: string } | null = null;

  server.get("/api/overview", async () => {
    const [snapshot, nav, lastRun, decisions, orders, events, news, sentiment] = await Promise.all([
      ports.portfolio.latest(),
      ports.portfolio.latestNav(),
      ports.runs.latest(1),
      ports.decisions.latest(20),
      ports.orders.latest(20),
      ports.eventRepo.recent(30),
      ports.marketData.latestNews(15),
      ports.marketData.latestSentiment(10),
    ]);
    const reportsByTicker = await Promise.all(
      config.universe.tickers.map((t) => ports.analysis.latestByTicker(t, 8)),
    );
    const snapshotsByTicker = await Promise.all(
      config.universe.tickers.map((t) => ports.marketData.snapshotsByTicker(t, 50)),
    );
    return {
      mode: config.mode,
      broker: { kind: ports.broker.kind, environment: brokerEnvironment },
      accountCurrency: config.account.currency,
      universe: config.universe,
      allocation: config.allocation,
      risk: config.risk,
      snapshot,
      nav,
      positions: snapshot?.positions ?? [],
      analysisReports: reportsByTicker.flat(),
      priceHistory: Object.fromEntries(config.universe.tickers.map((t, i) => [t, snapshotsByTicker[i] ?? []])),
      news,
      sentiment,
      lastRun: lastRun[0] ?? null,
      decisions,
      orders,
      events: [...events].reverse(),
      generatedAt: new Date().toISOString(),
    };
  });

  server.get("/api/runs", async (req) => {
    const q = req.query as { limit?: string };
    const limit = clampInt(q.limit, 20, 1, 200);
    return { runs: await ports.runs.latest(limit) };
  });

  server.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await ports.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const [analysis, decisions, orders, events] = await Promise.all([
      ports.analysis.byRun(id),
      ports.decisions.byRun(id),
      ports.orders.byRun(id),
      ports.eventRepo.byRun(id),
    ]);
    return { run, analysis, decisions, orders, events };
  });

  server.get("/api/portfolio/history", async (req) => {
    const q = req.query as { limit?: string };
    return { history: await ports.portfolio.history(clampInt(q.limit, 100, 1, 1000)) };
  });

  server.get("/api/decisions", async (req) => {
    const q = req.query as { limit?: string };
    return { decisions: await ports.decisions.latest(clampInt(q.limit, 50, 1, 500)) };
  });

  server.get("/api/orders", async (req) => {
    const q = req.query as { limit?: string };
    return { orders: await ports.orders.latest(clampInt(q.limit, 50, 1, 500)) };
  });

  server.get("/api/analysis", async (req) => {
    const q = req.query as { ticker?: string; limit?: string };
    if (!q.ticker) return { reports: [] };
    return { reports: await ports.analysis.latestByTicker(q.ticker, clampInt(q.limit, 40, 1, 200)) };
  });

  // Aggregated analysis outcome per run (bullish/neutral/bearish mix, average
  // confidence and target adjustment, per-ticker dominant conclusion).
  server.get("/api/runs-analysis", async (req) => {
    const q = req.query as { limit?: string };
    const runs = await ports.runs.latest(clampInt(q.limit, 10, 1, 50));
    const out: unknown[] = [];
    for (const run of runs) {
      const reports = await ports.analysis.byRun(run.id);
      if (reports.length === 0) continue;
      const counts = { bullish: 0, bearish: 0, neutral: 0 };
      let confSum = 0;
      let adjSum = 0;
      const byTicker = new Map<string, { concl: Record<string, number>; conf: number; count: number }>();
      for (const r of reports) {
        counts[r.conclusion] = (counts[r.conclusion] ?? 0) + 1;
        confSum += r.confidence;
        adjSum += r.signals.targetWeightAdjustment;
        const t = byTicker.get(r.ticker) ?? { concl: { bullish: 0, bearish: 0, neutral: 0 }, conf: 0, count: 0 };
        t.concl[r.conclusion] = (t.concl[r.conclusion] ?? 0) + 1;
        t.conf += r.confidence;
        t.count++;
        byTicker.set(r.ticker, t);
      }
      const tickers = [...byTicker.entries()].map(([ticker, t]) => ({
        ticker,
        dominant:
          (t.concl.bullish ?? 0) >= (t.concl.bearish ?? 0) && (t.concl.bullish ?? 0) >= (t.concl.neutral ?? 0)
            ? "bullish"
            : (t.concl.bearish ?? 0) >= (t.concl.neutral ?? 0)
              ? "bearish"
              : "neutral",
        avgConfidence: round2(t.conf / t.count),
      }));
      out.push({
        runId: run.id,
        startedAt: run.startedAt,
        status: run.status,
        marketOpen: run.marketOpen,
        counts,
        avgConfidence: round2(confSum / reports.length),
        avgAdjustment: round4(adjSum / reports.length),
        tickers,
      });
    }
    return { runs: out };
  });

  server.get("/api/events", async (req) => {
    const q = req.query as { limit?: string };
    return { events: await ports.eventRepo.recent(clampInt(q.limit, 100, 1, 1000)) };
  });

  server.get("/api/news", async (req) => {
    const q = req.query as { limit?: string };
    return { news: await ports.marketData.latestNews(clampInt(q.limit, 20, 1, 200)) };
  });

  server.get("/api/sentiment", async (req) => {
    const q = req.query as { limit?: string };
    return { sentiment: await ports.marketData.latestSentiment(clampInt(q.limit, 20, 1, 200)) };
  });

  server.get("/api/macro", async (req) => {
    const q = req.query as { limit?: string };
    const history = await ports.marketData.latestMacro(clampInt(q.limit, 60, 1, 500));
    return { history, latest: history[0]?.snapshot ?? null };
  });

  server.get("/api/snapshots", async (req) => {
    const q = req.query as { ticker?: string; limit?: string };
    if (!q.ticker) return { snapshots: [] };
    return { snapshots: await ports.marketData.snapshotsByTicker(q.ticker, clampInt(q.limit, 100, 1, 1000)) };
  });

  server.get("/api/targets", async () => {
    const current = await ports.allocationTargets.current();
    const byTicker = new Map(current.map((t) => [t.ticker, t.weight]));
    const base = config.allocation.targets.map((t) => ({ ticker: t.ticker, weight: t.weight }));
    const merged = base.map((t) => ({ ticker: t.ticker, weight: byTicker.get(t.ticker) ?? t.weight }));
    for (const t of current) {
      if (!merged.some((m) => m.ticker === t.ticker)) merged.push({ ticker: t.ticker, weight: t.weight });
    }
    // Enrich recent updates with the previous weight per ticker (the seed
    // weight for the first change), so the panel can show "from → to".
    const updates = await ports.allocationTargets.recentUpdates(200);
    const chrono = [...updates].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    const previous = new Map<string, number>();
    const enriched = chrono.map((u) => {
      const from = previous.get(u.ticker) ?? u.originalWeight;
      previous.set(u.ticker, u.weight);
      return { ...u, from };
    });
    return {
      base,
      current: merged,
      adaptation: config.allocation.adaptation,
      recent: enriched.reverse().slice(0, 10),
    };
  });

  // Asset Allocation Committee: state, latest session (proposals, feedback,
  // votes/points, winner) and the dashboard enable/disable toggle.
  server.get("/api/committee", async () => {
    const [enabled, latestSession] = await Promise.all([
      committee ? committee.isEnabled() : config.committee.enabled,
      committee ? committee.latest() : null,
    ]);
    return {
      enabled,
      configured: config.committee.enabled,
      maxVoteRounds: committee?.maxVoteRounds ?? config.committee.maxVoteRounds,
      agents: committee?.agentDefs() ?? config.committee.agents,
      latestSession,
    };
  });

  server.post("/api/committee/enable", async (req, reply) => {
    if (!committee) return reply.code(501).send({ error: "committee not wired" });
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "body.enabled must be a boolean" });
    }
    await committee.setEnabled(body.enabled);
    logger.info(`asset allocation committee ${body.enabled ? "enabled" : "disabled"} from the dashboard`);
    return { enabled: body.enabled };
  });

  server.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  // Manual trigger: runs the same pipeline as the hourly scheduler.
  server.post("/api/run", async (req, reply) => {
    if (!runTrigger) return reply.code(501).send({ error: "manual trigger not wired" });
    if (runInFlight) {
      return reply.code(409).send({ error: "a run is already in progress", run: runInFlight });
    }
    const body = (req.body ?? {}) as { force?: boolean };
    const force = body.force === true;
    logger.info(`manual run requested (force=${force})`);

    // Reserve the slot BEFORE the async work; the orchestrator's own
    // per-hour idempotency guard covers re-entrant calls as well.
    runInFlight = { id: "pending", startedAt: new Date().toISOString() };
    try {
      // Manual requests always run a fresh cycle: the per-hour guard is
      // skipped by design (user explicitly pressed the button).
      const run = await runTrigger.runOnce({ force, skipHourGuard: true });
      return {
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        marketOpen: run.marketOpen,
        details: run.details,
        error: run.error,
      };
    } catch (err) {
      // The orchestrator is single-flight: a manual run while ANY run (manual
      // or scheduled) is executing fails fast with the in-flight run's id.
      if (err instanceof RunInProgressError) {
        return reply.code(409).send({ error: err.message, runId: err.runId });
      }
      logger.error("manual run failed", { error: String(err) });
      return reply.code(500).send({ error: String(err) });
    } finally {
      runInFlight = null;
    }
  });

  server.setNotFoundHandler((req, reply) => {
    if ((req.url ?? "").startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    const path = (req.url ?? "/").split("?")[0]!;
    const file = normalize(join(staticRoot, path === "/" ? "index.html" : path));
    if (!file.startsWith(staticRoot) || !existsSync(file)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    const ext = file.slice(file.lastIndexOf("."));
    reply.type(MIME[ext] ?? "application/octet-stream").send(readFileSync(file));
  });

  const port = config.web.port;
  const host = config.web.host;
  return {
    url: `http://${host}:${port}`,
    instance: server,
    async start() {
      await server.listen({ port, host });
      logger.info(`dashboard listening on http://${host}:${port}`);
    },
    async stop() {
      await server.close();
    },
  };
}

function clampInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
