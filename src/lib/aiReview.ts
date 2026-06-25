import type { RiskReport, Verdict } from "./types";

export type AiReview = {
  recommendedVerdict?: Verdict;
  confidence: number;
  summary: string;
  mainRisks: string[];
  saferPlan: string;
  missingInfo: string[];
};

export async function fetchAiReview(report: RiskReport): Promise<AiReview> {
  const response = await fetch("/api/ai-review", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      signal: report.signal,
      market: {
        pair: report.market.pair,
        price: report.market.price,
        change24h: report.market.change24h,
        high24h: report.market.high24h,
        low24h: report.market.low24h,
        timeframe: report.market.timeframe,
        timeframeSource: report.market.timeframeSource,
        derivatives: report.market.derivatives,
        dataQuality: report.market.dataQuality,
        fetchedAt: report.market.fetchedAt,
      },
      report: {
        verdict: report.verdict,
        score: report.score,
        engineVerdict: report.engineVerdict ?? report.verdict,
        engineScore: report.engineScore ?? report.score,
        riskReward: report.riskReward,
        stopDistancePct: report.stopDistancePct,
        entryDistancePct: report.entryDistancePct,
        volatilityPct: report.volatilityPct,
        recentMovePct: report.recentMovePct,
        marketPulse: report.marketPulse,
        btcContext: report.btcContext,
        entryGuidance: report.entryGuidance,
        findings: report.findings,
        saferPlan: report.saferPlan,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "AI review is not available yet.");
  }

  return payload.review as AiReview;
}
