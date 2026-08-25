import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppPorts } from "../../application/ports.js";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../shared/logger.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

/**
 * Dashboard API + static UI. Read-only: it never mutates state, so the
 * dashboard can never trade by accident.
 */
export function buildWebServer(ports: AppPorts, config: AppConfig, logger: Logger): WebServer {
  const server: FastifyInstance = Fastify({ logger: false });
  const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/public");

  server.get("/api/overview", async () => {
    const [snapshot, nav, lastRun, decisions, orders, events] = await Promise.all([
      ports.portfolio.latest(),
      ports.portfolio.latestNav(),
      ports.runs.latest(1),
      ports.decisions.latest(20),
      ports.orders.latest(20),
      ports.eventRepo.recent(30),
    ]);
    const reportsByTicker = await Promise.all(
      config.universe.tickers.map((t) => ports.analysis.latestByTicker(t, 8)),
    );
    return {
      mode: config.mode,
      accountCurrency: config.account.currency,
      universe: config.universe,
      allocation: config.allocation,
      snapshot,
      nav,
      positions: snapshot?.positions ?? [],
      analysisReports: reportsByTicker.flat(),
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

  server.get("/api/events", async (req) => {
    const q = req.query as { limit?: string };
    return { events: await ports.eventRepo.recent(clampInt(q.limit, 100, 1, 1000)) };
  });

  server.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

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
