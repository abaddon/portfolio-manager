import { buildApp } from "../src/composition/root.js";
import { FixedClock } from "../src/shared/clock.js";
import { NullLogger } from "../src/shared/logger.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const app = buildApp({
    configPath: resolve(process.cwd(), "tests/fixtures/test-config.json"),
    env: {} as NodeJS.ProcessEnv,
    dbPath: ":memory:",
    logger: new NullLogger(),
    clock: new FixedClock(new Date("2026-08-26T14:30:00Z")),
  });
  const run = await app.orchestrator.runOnce();
  await app.flushEvents();
  console.log("status", run.status, run.error ?? "");
  console.log("snapshots MSFT:", await app.ports.marketData.snapshotsByTicker("MSFT"));
  console.log("news:", (await app.ports.marketData.latestNews(100)).length);
  console.log("sentiment:", (await app.ports.marketData.latestSentiment(100)).length);
  app.close();
}
void main();
