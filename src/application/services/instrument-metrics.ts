import { computeInstrumentMetrics, concentration, type InstrumentMetrics } from "../../domain/risk.js";
import type { Candle } from "../../domain/analysis.js";
import type { PortfolioSnapshot } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

export interface InstrumentMetricsResult {
  metrics: InstrumentMetrics[];
  /** Benchmark bars actually used (0 → beta/correlation are null for every name). */
  benchmarkBars: number;
  /** Portfolio concentration from the snapshot's weights (WP-P2.1). */
  concentration: { largestWeight: number; effectivePositions: number; top3Weight: number };
}

/**
 * Per-instrument risk metrics (WP-P2.1) from the candles the analysis step
 * already fetches, plus ONE extra benchmark series per run (Yahoo, free). Every
 * failure is contained: missing candles mean null metrics for that name, and a
 * missing benchmark means beta/correlation stay null while everything else is
 * still computed — never a run failure and never an invented number.
 */
export class InstrumentMetricsService {
  private readonly candlesPort: AppPorts["prices"];
  private readonly logger: AppPorts["logger"];

  constructor(
    ports: Pick<AppPorts, "prices" | "logger">,
    private readonly universe: { tickers: readonly string[]; benchmark: string },
    private readonly opts: { interval?: string; count?: number } = {},
  ) {
    this.candlesPort = ports.prices;
    this.logger = ports.logger;
  }

  async collect(snapshot: PortfolioSnapshot): Promise<InstrumentMetricsResult> {
    const interval = this.opts.interval ?? "60";
    const count = this.opts.count ?? 40;
    const tickers = [...new Set([...this.universe.tickers, ...snapshot.positions.map((p) => p.ticker)])];

    let benchmarkCandles: Candle[] = [];
    try {
      benchmarkCandles = await this.candlesPort.candles(this.universe.benchmark, { interval, count });
    } catch (err) {
      this.logger.warn(`benchmark candles unavailable for ${this.universe.benchmark} — beta/correlation disabled this run`, {
        error: String(err),
      });
    }

    const metrics: InstrumentMetrics[] = [];
    for (const ticker of tickers) {
      let candles: Candle[] = [];
      try {
        candles = await this.candlesPort.candles(ticker, { interval, count });
      } catch (err) {
        this.logger.warn(`candles unavailable for ${ticker} — risk metrics skipped`, { error: String(err) });
      }
      metrics.push(computeInstrumentMetrics(ticker, candles, benchmarkCandles));
    }

    return {
      metrics,
      benchmarkBars: benchmarkCandles.length,
      concentration: concentration({ weights: snapshot.positions.map((p) => p.weight) }),
    };
  }
}
