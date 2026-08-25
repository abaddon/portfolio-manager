import { buildApp } from "../src/composition/root.js";
import { NullLogger } from "../src/shared/logger.js";

async function main(): Promise<void> {
  const app = buildApp({ env: {} as NodeJS.ProcessEnv, logger: new NullLogger() });
  const run = await app.orchestrator.runOnce({ force: true });
  await app.flushEvents();
  console.log("run", run.id, run.status, "started", run.startedAt);
  console.log("snapshots MSFT:", (await app.ports.marketData.snapshotsByTicker("MSFT")).length);
  console.log("news:", (await app.ports.marketData.latestNews(1000)).length);
  console.log("sentiment:", (await app.ports.marketData.latestSentiment(1000)).length);
  app.close();
}
void main();
