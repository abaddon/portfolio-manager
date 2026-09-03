import { SystemClock, type Clock } from "../shared/clock.js";
import { ConsoleLogger, type Logger } from "../shared/logger.js";
import { InMemoryEventBus, type EventBus } from "../shared/events.js";
import { ConfigurationError } from "../shared/errors.js";
import { loadConfig, type LoadedConfig } from "../config.js";
import type { MarketSession } from "../domain/calendar.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../domain/decision.js";
import type { AppPorts, FxPort, PriceDataPort, SentimentPort } from "../application/ports.js";
import type { AllocationTarget } from "../domain/portfolio.js";
import { buildAnalysts } from "../application/services/analysts.js";
import { MarketAnalysisService } from "../application/services/market-analysis.js";
import { PortfolioEvaluationService } from "../application/services/portfolio-evaluation.js";
import { DecisionService } from "../application/services/decisions.js";
import { AllocationTargetsService } from "../application/services/allocation-targets.js";
import { AllocationBootstrapService } from "../application/services/target-bootstrap.js";
import { ExecutionService } from "../application/services/execution.js";
import { PipelineOrchestrator } from "../application/services/pipeline.js";
import { openDatabase } from "../adapters/persistence/sqlite.js";
import {
  SqliteAnalysisRepository,
  SqliteDecisionRepository,
  SqliteEventRepository,
  SqliteOrderRepository,
  SqlitePortfolioRepository,
  SqliteRunRepository,
  SqliteSettingsRepository,
} from "../adapters/persistence/repositories.js";
import { SqliteMarketDataRepository } from "../adapters/persistence/market-data.js";
import { SqliteAllocationTargetRepository } from "../adapters/persistence/allocation-targets.js";
import { SqliteCommitteeRepository } from "../adapters/persistence/committee.js";
import { CommitteeService } from "../application/services/committee.js";
import { HttpLlmClient, makeLlmClient, UnavailableLlmClient, PROVIDER_PROFILES, type LlmProviderProfile } from "../adapters/llm/http-llm-client.js";
import { FinnhubAdapter } from "../adapters/marketdata/finnhub.js";
import { FredAdapter } from "../adapters/marketdata/fred.js";
import { DemoFxAdapter, DemoMarketDataAdapter } from "../adapters/marketdata/demo.js";
import { ErApiFxAdapter, FallbackFxAdapter } from "../adapters/marketdata/fx.js";
import { CombinedPriceDataAdapter, YahooCandlesAdapter } from "../adapters/marketdata/yahoo.js";
import { FallbackSentimentPort, NewsSentimentPort } from "../application/services/news-sentiment.js";
import { PaperBroker } from "../adapters/broker/paper-broker.js";
import { Trading212Broker } from "../adapters/broker/trading212.js";
import { ConfigMarketCalendar, PipelineScheduler, type SchedulableCalendar } from "../adapters/scheduler/scheduler.js";

export interface App {
  ports: AppPorts;
  orchestrator: PipelineOrchestrator;
  scheduler: PipelineScheduler;
  committee: CommitteeService;
  config: LoadedConfig["config"];
  /** Broker environment for display: "paper" | "demo" | "live". */
  brokerEnvironment: "paper" | "demo" | "live";
  /** Awaits all in-flight event persistence (tests, graceful shutdown). */
  flushEvents(): Promise<void>;
  close(): void;
}

export function buildApp(args: { configPath?: string; overlayPath?: string; env?: NodeJS.ProcessEnv; dbPath?: string; logger?: Logger; clock?: Clock; committeeLlms?: ReadonlyMap<string, AppPorts["llm"]> } = {}): App {
  const loadArgs: { configPath?: string; overlayPath?: string; env?: NodeJS.ProcessEnv } = {};
  if (args.configPath !== undefined) loadArgs.configPath = args.configPath;
  if (args.overlayPath !== undefined) loadArgs.overlayPath = args.overlayPath;
  if (args.env !== undefined) loadArgs.env = args.env;
  const loaded = loadConfig(loadArgs);
  const config = loaded.config;
  const logger = args.logger ?? new ConsoleLogger("info");
  const clock = args.clock ?? new SystemClock();
  const bus: EventBus = new InMemoryEventBus();

  const db = openDatabase(args.dbPath ?? config.database.path);
  const runs = new SqliteRunRepository(db);
  const analysis = new SqliteAnalysisRepository(db);
  const portfolio = new SqlitePortfolioRepository(db);
  const decisions = new SqliteDecisionRepository(db);
  const orders = new SqliteOrderRepository(db);
  const eventRepo = new SqliteEventRepository(db);
  const marketData = new SqliteMarketDataRepository(db);
  const allocationTargets = new SqliteAllocationTargetRepository(db);
  const settings = new SqliteSettingsRepository(db);
  const committeeRepo = new SqliteCommitteeRepository(db);

  // Persist every published event (append-only decision trail). The promise
  // chain keeps ordering and lets callers await in-flight persistence.
  let pendingEvents: Promise<void> = Promise.resolve();
  bus.subscribe((event) => {
    pendingEvents = pendingEvents
      .then(() => eventRepo.append([event]))
      .catch((err) => logger.error("failed to persist event", { error: String(err) }));
  });

  const llm = buildLlm(loaded, config);

  const finnhubKey = loaded.providerKeys.finnhub ?? null;
  const wantsFinnhub = Object.values(config.dataProviders).includes("finnhub");
  const finnhub = wantsFinnhub && finnhubKey ? new FinnhubAdapter(finnhubKey) : null;
  if (wantsFinnhub && finnhubKey === null) {
    logger.warn("FINNHUB_API_KEY missing — falling back to demo market data");
  }

  // FRED macro context (rates, VIX, CPI, S&P 500) — optional input for the analysts.
  const fredKey = loaded.providerKeys.fred ?? null;
  const wantsFred = config.dataProviders.macro === "fred";
  const fred = wantsFred && fredKey ? new FredAdapter(fredKey) : null;
  if (wantsFred && fredKey === null) {
    logger.warn("FREED_API_KEY missing — macro context disabled");
  }

  const demoData = new DemoMarketDataAdapter({ now: clock.now() });
  const erApiFx = new ErApiFxAdapter();
  const demoFx = new DemoFxAdapter();
  const fx: FxPort = config.dataProviders.fx === "erapi" ? new FallbackFxAdapter([erApiFx, demoFx]) : demoFx;
  const yahooCandles = new YahooCandlesAdapter();
  const candlesSource = config.dataProviders.candles === "yahoo" ? yahooCandles : demoData;
  const basePrices = config.dataProviders.prices === "finnhub" && finnhub ? finnhub : demoData;
  const prices: PriceDataPort = finnhub && config.dataProviders.prices === "finnhub"
    ? new CombinedPriceDataAdapter(basePrices, candlesSource)
    : demoData;
  const news = config.dataProviders.news === "finnhub" && finnhub ? finnhub : demoData;
  const fundamentals = config.dataProviders.fundamentals === "finnhub" && finnhub ? finnhub : demoData;
  // Finnhub's social sentiment is not on the free plan — fall back to scoring
  // the news headlines (LLM when available, keyword heuristic otherwise).
  const sentiment: SentimentPort =
    config.dataProviders.sentiment === "finnhub" && finnhub
      ? new FallbackSentimentPort([finnhub, new NewsSentimentPort(news, llm, logger)])
      : demoData;

  const broker =
    config.mode === "live"
      ? (() => {
          if (!loaded.broker.apiKey) {
            throw new ConfigurationError(
              'mode=live requires TRADING212_API_KEY (+ TRADING212_API_SECRET for key-pair auth). ' +
                'Set TRADING212_ACCOUNT_DEMO=1 to use the practice account.',
            );
          }
          return new Trading212Broker({
            environment: loaded.broker.env,
            apiKey: loaded.broker.apiKey,
            apiSecret: loaded.broker.apiSecret,
            baseUrl: config.trading212.baseUrl,
            liveBaseUrl: config.trading212.liveBaseUrl,
          });
        })()
      : new PaperBroker({
          currency: config.account.currency,
          initialCash: config.account.initialCash,
          initialPositions: config.account.initialPositions,
          fx,
          prices,
          spreadBps: config.costs.spreadBps,
          fxFeePct: config.costs.fxFeePct,
        });
  logger.info(`broker: ${broker.kind}${config.mode === "live" ? ` (${loaded.broker.env})` : " — simulated fills, no real money"}`);

  const marketCfg = config.schedule.markets[config.schedule.primaryMarket];
  if (!marketCfg) throw new Error(`unknown primary market: ${config.schedule.primaryMarket}`);
  const session: MarketSession = {
    tz: marketCfg.tz,
    open: marketCfg.open,
    close: marketCfg.close,
    holidays: marketCfg.holidays,
    earlyCloses: marketCfg.earlyCloses,
  };
  if (marketCfg.earlyClose !== undefined) session.earlyClose = marketCfg.earlyClose;
  const calendar: SchedulableCalendar = new ConfigMarketCalendar(config.schedule.primaryMarket, session);

  const ports: AppPorts = {
    clock,
    logger,
    events: bus,
    calendar,
    llm,
    prices,
    news,
    fundamentals,
    sentiment,
    macro: fred,
    fx,
    broker,
    runs,
    analysis,
    portfolio,
    decisions,
    orders,
    eventRepo,
    marketData,
    allocationTargets,
    settings,
    committee: committeeRepo,
  };

  const costModel: CostModel = {
    spreadBps: config.costs.spreadBps,
    fxFeePct: config.costs.fxFeePct,
    stampDutyPct: config.costs.stampDutyPct,
    platformFeePct: config.costs.platformFeePct,
  };
  const riskLimits: RiskLimits = {
    maxOrderValue: config.risk.maxOrderValue,
    maxHeatPct: config.risk.maxHeatPct,
    minExpectedBenefitPct: config.risk.minExpectedBenefitPct,
    costBenefitMultiplier: config.risk.costBenefitMultiplier,
    maxOrdersPerRun: config.risk.maxOrdersPerRun,
    tickerCooldownDays: config.risk.tickerCooldownDays,
    minConfidence: config.risk.minConfidence,
  };
  const engine = new DecisionEngine(costModel, riskLimits);

  const analysts = buildAnalysts(ports);
  const analysisService = new MarketAnalysisService(ports, analysts);
  const seedTargets: AllocationTarget[] = config.allocation.targets.map((t) => ({ ticker: t.ticker, weight: t.weight }));
  const allocationBootstrap = new AllocationBootstrapService(ports, seedTargets);
  const targetsService = new AllocationTargetsService(ports, seedTargets);
  const portfolioService = new PortfolioEvaluationService(
    ports,
    seedTargets,
    config.allocation.rebalanceBand,
    config.risk.stopDistancePct,
    config.universe.benchmark,
  );
  const decisionService = new DecisionService(ports, engine, {
    expectedReturnPerTradePct: config.risk.expectedReturnPerTradePct,
    tickerCooldownDays: config.risk.tickerCooldownDays,
  });
  const executionService = new ExecutionService(ports, engine, config.risk.maxOrdersPerRun);

  // Asset Allocation Committee: one LLM client per agent (its own provider +
  // model, usually OpenRouter). Missing keys degrade to unavailable clients —
  // sessions fail with a clear error instead of crashing the pipeline. Tests
  // inject scripted clients through `args.committeeLlms`.
  const committeeLlms = new Map<string, AppPorts["llm"]>();
  for (const agent of config.committee.agents) {
    const injected = args.committeeLlms?.get(agent.id);
    if (injected) {
      committeeLlms.set(agent.id, injected);
      continue;
    }
    const apiKey = loaded.providerKeys[agent.provider] ?? null;
    if (!apiKey) {
      logger.warn(`committee agent ${agent.id} (${agent.provider}/${agent.model}) has no API key — committee sessions will fail`);
      committeeLlms.set(agent.id, new UnavailableLlmClient());
    } else {
      committeeLlms.set(
        agent.id,
        makeLlmClient({
          provider: agent.provider,
          config: { model: agent.model },
          apiKey,
          temperature: agent.temperature ?? config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          timeoutMs: config.llm.timeoutMs,
          thinking: config.llm.thinking,
        }),
      );
    }
  }
  const committee = new CommitteeService(
    ports,
    committeeLlms,
    {
      maxVoteRounds: config.committee.maxVoteRounds,
      agents: config.committee.agents.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        model: a.model,
        ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
      })),
      maxTarget: config.committee.maxTarget,
      minCashBuffer: config.committee.minCashBuffer,
    },
    decisionService,
  );

  const orchestrator = new PipelineOrchestrator(
    ports,
    { analysis: analysisService, allocationBootstrap, targets: targetsService, portfolio: portfolioService, execution: executionService, committee },
    { tickers: config.universe.tickers, benchmark: config.universe.benchmark },
  );

  const scheduler = new PipelineScheduler(calendar, clock, logger, () => orchestrator.runOnce(), {
    runAtMinutePastHour: config.schedule.runAtMinutePastHour,
    runOnStartup: config.schedule.runOnStartup,
  });

  return {
    ports,
    orchestrator,
    scheduler,
    committee,
    config,
    brokerEnvironment: config.mode === "live" ? loaded.broker.env : "paper",
    flushEvents: () => pendingEvents,
    close() {
      scheduler.stop();
      db.close();
    },
  };
}

function buildLlm(loaded: LoadedConfig, config: LoadedConfig["config"]): AppPorts["llm"] {
  const profileCfg = config.llm.providers[config.llm.provider];
  const apiKey = loaded.llmApiKey ?? null;
  const thinking: "enabled" | "disabled" = config.llm.thinking ?? "disabled";
  if (!apiKey) {
    const fallback = Object.entries(loaded.providerKeys).find(([, v]) => v && v.length > 0);
    if (fallback) {
      const name = fallback[0];
      const base = PROVIDER_PROFILES[name as keyof typeof PROVIDER_PROFILES];
      if (base) {
        const profile: LlmProviderProfile = {
          name,
          baseUrl: base.baseUrl,
          model: config.llm.providers[name]?.model ?? base.model,
          apiKey: fallback[1],
          wireFormat: base.wireFormat as LlmProviderProfile["wireFormat"],
        };
        if (thinking) profile.thinking = thinking;
        return new HttpLlmClient(profile, {
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          timeoutMs: config.llm.timeoutMs,
        });
      }
    }
    return new UnavailableLlmClient();
  }
  const clientArgs: {
    provider: string;
    config?: { baseUrl?: string; model?: string };
    apiKey: string | null;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    thinking?: "enabled" | "disabled";
  } = { provider: config.llm.provider, apiKey, thinking };
  if (profileCfg) clientArgs.config = { baseUrl: profileCfg.baseUrl, model: profileCfg.model };
  return makeLlmClient({
    ...clientArgs,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    timeoutMs: config.llm.timeoutMs,
  });
}
