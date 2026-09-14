import { buildApp } from "./composition/root.js";
import { buildWebServer } from "./adapters/web/server.js";
import { ConfigurationError } from "./shared/errors.js";

const command = process.argv[2] ?? "help";

/** Extracts `--config <path>` (or `--config=<path>`) from the remaining argv. */
function configArg(): string | undefined {
  const idx = process.argv.findIndex((a) => a.startsWith("--config"));
  if (idx === -1) return undefined;
  const arg = process.argv[idx]!;
  if (arg.includes("=")) {
    const value = arg.slice(arg.indexOf("=") + 1);
    if (!value) throw new ConfigurationError("--config requires a path (e.g. --config config/paper-real-data.json)");
    return value;
  }
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigurationError("--config requires a path (e.g. --config config/paper-real-data.json)");
  }
  return value;
}

function buildArgs() {
  const configPath = configArg();
  return configPath === undefined ? {} : { overlayPath: configPath };
}

async function runOnce(force: boolean): Promise<void> {
  const app = buildApp(buildArgs());
  // Never trigger a run before the startup hardening has finished: it closes
  // orphaned RUNNING runs and refuses a live start on a missing model id.
  await app.startupChecks();
  const run = await app.orchestrator.runOnce({ force });
  await app.flushEvents();
  app.close();
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        marketOpen: run.marketOpen,
        details: run.details,
        error: run.error,
      },
      null,
      2,
    ),
  );
  process.exit(run.status === "FAILED" ? 1 : 0);
}

async function verifyModels(): Promise<void> {
  const app = buildApp(buildArgs());
  const report = await app.startupChecks();
  const lines = [
    `orphaned RUNNING runs closed: ${report.orphanRuns}`,
    ...report.probes.map((p) => `${p.verdict.toUpperCase().padEnd(11)} ${p.provider}/${p.model} — ${p.detail}`),
  ];
  console.log(lines.join("\n"));
  app.close();
  process.exit(report.flaggedModels > 0 ? 1 : 0);
}

async function serve(): Promise<void> {
  const app = buildApp(buildArgs());
  await app.startupChecks();
  const web = buildWebServer(app.ports, app.config, app.ports.logger, app.brokerEnvironment, app.orchestrator, app.committee);
  await web.start();
  app.scheduler.start();
  const shutdown = async () => {
    app.scheduler.stop();
    await web.stop();
    await app.flushEvents();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function status(): Promise<void> {
  const app = buildApp(buildArgs());
  const [snapshot, nav, runs, decisions, orders] = await Promise.all([
    app.ports.portfolio.latest(),
    app.ports.portfolio.latestNav(),
    app.ports.runs.latest(5),
    app.ports.decisions.latest(10),
    app.ports.orders.latest(10),
  ]);
  app.close();
  console.log(JSON.stringify({ snapshot, nav, runs, decisions, orders }, null, 2));
}

function help(): void {
  console.log(`trading-portfolio-manager
usage: tsx src/cli.ts <command>

commands:
  run-once [--force]   run the hourly pipeline once now (force: even if market closed)
  serve                start scheduler + dashboard (same as "npm start")
  status               print latest snapshot, runs, decisions and orders
  verify-models        check every committee model id at its provider, then exit
  help                 this help
`);
}

const cmd = command.replace(/^--/, "");
switch (cmd) {
  case "run-once":
    await runOnce(process.argv.includes("--force"));
    break;
  case "serve":
    await serve();
    break;
  case "status":
    await status();
    break;
  case "verify-models":
    await verifyModels();
    break;
  default:
    help();
}
