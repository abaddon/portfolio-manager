import { buildApp } from "./composition/root.js";
import { buildWebServer } from "./adapters/web/server.js";

/** Long-running entrypoint: hourly scheduler + dashboard. */
async function main(): Promise<void> {
  const app = buildApp();
  const web = buildWebServer(app.ports, app.config, app.ports.logger);

  await web.start();
  app.scheduler.start();

  const shutdown = async () => {
    app.ports.logger.info("shutting down…");
    app.scheduler.stop();
    await web.stop();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  app.ports.logger.info(
    `trading-portfolio-manager running (mode=${app.config.mode}, universe=${app.config.universe.tickers.join(",")})`,
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
