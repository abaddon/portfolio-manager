import { buildApp } from "./composition/root.js";
import { buildWebServer } from "./adapters/web/server.js";

const command = process.argv[2] ?? "help";

async function runOnce(force: boolean): Promise<void> {
  const app = buildApp();
  const run = await app.orchestrator.runOnce({ force });
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

async function serve(): Promise<void> {
  const app = buildApp();
  const web = buildWebServer(app.ports, app.config, app.ports.logger);
  await web.start();
  app.scheduler.start();
  const shutdown = async () => {
    app.scheduler.stop();
    await web.stop();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function status(): Promise<void> {
  const app = buildApp();
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
  default:
    help();
}
