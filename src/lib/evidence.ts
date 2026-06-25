import type { PaperTrade } from "./types";

export type PlanEvidence = {
  plan: PaperTrade["plan"];
  completed: number;
  profitable: number;
  losing: number;
  winRatePct?: number;
  grossPnl: number;
  netPnl: number;
  netCosts: number;
  averageReturnR?: number;
  profitFactor?: number;
  maxDrawdown: number;
};

export type EvidenceReport = {
  generatedAt: string;
  trackedTrades: number;
  monitoringTrades: number;
  expiredOrStale: number;
  completedOutcomes: number;
  completedPairs: number;
  sampleQuality: "insufficient" | "early" | "developing";
  sampleMessage: string;
  original: PlanEvidence;
  safer: PlanEvidence;
  paired: {
    saferLed: number;
    originalLed: number;
    tied: number;
    averageSaferEdgeR?: number;
  };
};

export function isCompletedOutcome(trade: PaperTrade) {
  return trade.status === "take-profit" || trade.status === "stop-loss";
}

export function tradeNetPnl(trade: PaperTrade) {
  return trade.realizedPnl + trade.unrealizedPnl;
}

export function tradeReturnR(trade: PaperTrade) {
  const riskCash = Math.abs(trade.entry - trade.stopLoss) * trade.quantity;
  return riskCash ? tradeNetPnl(trade) / riskCash : 0;
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function planEvidence(trades: PaperTrade[], plan: PaperTrade["plan"]): PlanEvidence {
  const completed = trades
    .filter((trade) => trade.plan === plan && isCompletedOutcome(trade))
    .sort((a, b) => new Date(a.exitAt ?? a.updatedAt).getTime() - new Date(b.exitAt ?? b.updatedAt).getTime());
  const returns = completed.map(tradeNetPnl);
  const profits = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = profits.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let cumulativePnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;

  returns.forEach((value) => {
    cumulativePnl += value;
    peakPnl = Math.max(peakPnl, cumulativePnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumulativePnl);
  });

  const totalReturnR = completed.reduce((sum, trade) => sum + tradeReturnR(trade), 0);
  const grossPnl = completed.reduce((sum, trade) => sum + trade.grossRealizedPnl, 0);
  const netPnl = returns.reduce((sum, value) => sum + value, 0);
  const netCosts = completed.reduce(
    (sum, trade) => sum + trade.entryFee + trade.exitFees + trade.fundingCost,
    0,
  );

  return {
    plan,
    completed: completed.length,
    profitable: profits.length,
    losing: losses.length,
    winRatePct: completed.length ? round((profits.length / completed.length) * 100) : undefined,
    grossPnl: round(grossPnl),
    netPnl: round(netPnl),
    netCosts: round(netCosts),
    averageReturnR: completed.length ? round(totalReturnR / completed.length) : undefined,
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : undefined,
    maxDrawdown: round(maxDrawdown),
  };
}

function sampleQuality(completedPairs: number): Pick<EvidenceReport, "sampleQuality" | "sampleMessage"> {
  if (completedPairs < 10) {
    return {
      sampleQuality: "insufficient",
      sampleMessage: `${completedPairs} completed pair${completedPairs === 1 ? "" : "s"}. TradeLens policy requires at least 10 before the comparison becomes directionally useful.`,
    };
  }

  if (completedPairs < 30) {
    return {
      sampleQuality: "early",
      sampleMessage: `${completedPairs} completed pairs provide early evidence, but the result can still change sharply with more trades.`,
    };
  }

  return {
    sampleQuality: "developing",
    sampleMessage: `${completedPairs} completed pairs form a useful developing sample. This is evidence, not a guarantee of future performance.`,
  };
}

export function buildEvidenceReport(trades: PaperTrade[]): EvidenceReport {
  const grouped = new Map<string, PaperTrade[]>();
  trades.forEach((trade) => grouped.set(trade.reportId, [...(grouped.get(trade.reportId) ?? []), trade]));

  const pairs = [...grouped.values()]
    .map((items) => ({
      original: items.find((trade) => trade.plan === "original" && isCompletedOutcome(trade)),
      safer: items.find((trade) => trade.plan === "safer" && isCompletedOutcome(trade)),
    }))
    .filter((pair): pair is { original: PaperTrade; safer: PaperTrade } => Boolean(pair.original && pair.safer));

  const paired = pairs.reduce(
    (summary, pair) => {
      const edge = tradeReturnR(pair.safer) - tradeReturnR(pair.original);
      return {
        saferLed: summary.saferLed + (edge > 0.01 ? 1 : 0),
        originalLed: summary.originalLed + (edge < -0.01 ? 1 : 0),
        tied: summary.tied + (Math.abs(edge) <= 0.01 ? 1 : 0),
        totalEdgeR: summary.totalEdgeR + edge,
      };
    },
    { saferLed: 0, originalLed: 0, tied: 0, totalEdgeR: 0 },
  );
  const quality = sampleQuality(pairs.length);

  return {
    generatedAt: new Date().toISOString(),
    trackedTrades: trades.length,
    monitoringTrades: trades.filter((trade) => trade.status === "active" || trade.status === "waiting-entry").length,
    expiredOrStale: trades.filter((trade) => trade.status === "expired" || trade.status === "stale").length,
    completedOutcomes: trades.filter(isCompletedOutcome).length,
    completedPairs: pairs.length,
    ...quality,
    original: planEvidence(trades, "original"),
    safer: planEvidence(trades, "safer"),
    paired: {
      saferLed: paired.saferLed,
      originalLed: paired.originalLed,
      tied: paired.tied,
      averageSaferEdgeR: pairs.length ? round(paired.totalEdgeR / pairs.length) : undefined,
    },
  };
}
