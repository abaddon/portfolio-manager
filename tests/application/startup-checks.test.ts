import { afterEach, describe, expect, it, vi } from "vitest";
import { runStartupChecks } from "../../src/composition/root.js";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteEventRepository, SqliteRunRepository } from "../../src/adapters/persistence/repositories.js";
import { Run } from "../../src/domain/run.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import type { AppPorts } from "../../src/application/ports.js";
import type { LoadedConfig } from "../../src/config.js";

/** Minimal ports: only the run repository and the event bus matter for the sweep. */
function portsWith(db: ReturnType<typeof openDatabase>): { ports: AppPorts; published: string[] } {
  const published: string[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((e) => published.push(e.type));
  const ports = {
    clock: new FixedClock(new Date("2026-09-14T12:00:00Z")),
    logger: new NullLogger(),
    events: bus,
    runs: new SqliteRunRepository(db),
    eventRepo: new SqliteEventRepository(db),
  } as unknown as AppPorts;
  return { ports, published };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A provider list that does NOT contain the configured model. */
function stubModelsMissing(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "vendor/other-model" }] }), { status: 200 })));
}

function config(mode: "paper" | "live", model = "test/m1"): LoadedConfig {
  return {
    config: {
      mode,
      llm: { providers: {} },
      committee: {
        agents: [
          { id: "a1", name: "A", provider: "openrouter", model },
          { id: "a2", name: "B", provider: "openrouter", model },
          { id: "a3", name: "C", provider: "openrouter", model },
        ],
      },
    },
    llmApiKey: null,
    broker: { env: "demo", apiKey: null, apiSecret: null },
    providerKeys: {},
  } as unknown as LoadedConfig;
}

describe("runStartupChecks (WP-P0.5)", () => {
  it("closes runs an interrupted process left RUNNING and records why", async () => {
    const db = openDatabase(":memory:");
    const { ports, published } = portsWith(db);
    const stuck = Run.start("run_stuck", "2026-09-13T14:00:00Z", true);
    await ports.runs.save(stuck);
    const finished = Run.start("run_ok", "2026-09-13T13:00:00Z", true);
    finished.complete("2026-09-13T13:05:00Z", {});
    await ports.runs.save(finished);

    const report = await runStartupChecks(config("paper"), config("paper").config, ports, new NullLogger());
    expect(report.orphanRuns).toBe(1);

    const closed = await ports.runs.get("run_stuck");
    expect(closed?.status).toBe("FAILED");
    expect(closed?.error).toContain("orphaned by an interrupted process");
    // The completed run is untouched.
    expect((await ports.runs.get("run_ok"))?.status).toBe("COMPLETED");
    expect(published).toContain("PipelineFailed");
    db.close();
  });

  it("is a no-op when nothing was left running", async () => {
    const db = openDatabase(":memory:");
    const { ports } = portsWith(db);
    const report = await runStartupChecks(config("paper"), config("paper").config, ports, new NullLogger());
    expect(report.orphanRuns).toBe(0);
    db.close();
  });

  it("refuses to start a live run on a model id the provider does not list", async () => {
    const db = openDatabase(":memory:");
    const { ports } = portsWith(db);
    stubModelsMissing();
    const live = config("live");
    live.providerKeys = { openrouter: "key" };
    await expect(runStartupChecks(live, live.config, ports, new NullLogger())).rejects.toThrow(/committee model\(s\) not available/);
    db.close();
  });

  it("only warns about a missing model in paper mode (and says why sessions will fail)", async () => {
    const db = openDatabase(":memory:");
    const { ports } = portsWith(db);
    stubModelsMissing();
    const paper = config("paper");
    paper.providerKeys = { openrouter: "key" };
    const report = await runStartupChecks(paper, paper.config, ports, new NullLogger());
    expect(report.flaggedModels).toBe(3);
    expect(report.probes[0]!.verdict).toBe("missing");
    db.close();
  });

  it("does not flag models when the provider is unreachable (a probe never blocks a start)", async () => {
    const db = openDatabase(":memory:");
    const { ports } = portsWith(db);
    // No API key in providerKeys → the probe reports "unreachable", not "missing".
    const report = await runStartupChecks(config("paper"), config("paper").config, ports, new NullLogger());
    expect(report.flaggedModels).toBe(0);
    expect(report.probes.every((p) => p.verdict === "unreachable")).toBe(true);
    db.close();
  });
});
