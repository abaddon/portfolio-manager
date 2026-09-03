import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteAllocationTargetRepository } from "../../src/adapters/persistence/allocation-targets.js";
import { AllocationTargetsService } from "../../src/application/services/allocation-targets.js";
import type { AllocationTarget } from "../../src/domain/portfolio.js";
import type { AppPorts } from "../../src/application/ports.js";

function makePorts(): AppPorts {
  const db = openDatabase(":memory:");
  return { allocationTargets: new SqliteAllocationTargetRepository(db) } as unknown as AppPorts;
}

describe("AllocationTargetsService.currentTargets", () => {
  it("returns the configured seeds when nothing has been persisted", async () => {
    const ports = makePorts();
    const seeds: AllocationTarget[] = [
      { ticker: "MSFT", weight: 0.2 },
      { ticker: "NVDA", weight: 0.05 },
    ];
    const svc = new AllocationTargetsService(ports, seeds);
    expect(await svc.currentTargets()).toEqual(seeds);
  });

  it("overrides seeds with the persisted committee updates", async () => {
    const ports = makePorts();
    await ports.allocationTargets.saveUpdates([
      { id: "tg1", runId: "run1", ticker: "MSFT", weight: 0.25, originalWeight: 0.2, rationale: "committee winner", conviction: 0.8, updatedAt: "2026-08-26T14:00:00Z" },
    ]);
    const svc = new AllocationTargetsService(ports, [
      { ticker: "MSFT", weight: 0.2 },
      { ticker: "NVDA", weight: 0.05 },
    ]);
    const targets = await svc.currentTargets();
    expect(targets.find((t) => t.ticker === "MSFT")?.weight).toBeCloseTo(0.25, 4);
    expect(targets.find((t) => t.ticker === "NVDA")?.weight).toBeCloseTo(0.05, 4);
  });

  it("ignores persisted rows for tickers no longer in the seeds", async () => {
    const ports = makePorts();
    await ports.allocationTargets.saveUpdates([
      { id: "tg1", runId: "run1", ticker: "OLD", weight: 0.3, originalWeight: 0.3, rationale: "stale", conviction: 0.5, updatedAt: "2026-08-26T14:00:00Z" },
    ]);
    const svc = new AllocationTargetsService(ports, [{ ticker: "MSFT", weight: 0.2 }]);
    const targets = await svc.currentTargets();
    expect(targets).toEqual([{ ticker: "MSFT", weight: 0.2 }]);
  });

  it("bootstrapped allocation (empty seeds): the repo rows ARE the targets", async () => {
    const ports = makePorts();
    await ports.allocationTargets.saveUpdates([
      { id: "tg1", runId: "run1", ticker: "RTX", weight: 0.1871, originalWeight: 0.1871, rationale: "bootstrapped", conviction: 1, updatedAt: "2026-08-26T13:00:00Z" },
    ]);
    const svc = new AllocationTargetsService(ports, []);
    expect(await svc.currentTargets()).toEqual([{ ticker: "RTX", weight: 0.1871 }]);
  });
});

describe("SqliteAllocationTargetRepository", () => {
  it("returns the latest target per ticker", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteAllocationTargetRepository(db);
    await repo.saveUpdates([
      { id: "tg1", runId: "run1", ticker: "MSFT", weight: 0.21, originalWeight: 0.2, rationale: "r1", conviction: 0.6, updatedAt: "2026-08-26T14:01:00Z" },
      { id: "tg2", runId: "run2", ticker: "MSFT", weight: 0.23, originalWeight: 0.2, rationale: "r2", conviction: 0.7, updatedAt: "2026-08-26T15:01:00Z" },
      { id: "tg3", runId: "run2", ticker: "NVDA", weight: 0.06, originalWeight: 0.05, rationale: "r3", conviction: 0.8, updatedAt: "2026-08-26T15:01:00Z" },
    ]);
    const current = await repo.current();
    expect(current).toHaveLength(2);
    expect(current.find((t) => t.ticker === "MSFT")?.weight).toBeCloseTo(0.23, 4);
    expect((await repo.recentUpdates(10))).toHaveLength(3);
    db.close();
  });
});
