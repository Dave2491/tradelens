import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Activity, BarChart3, Moon, ScanLine, Sun } from "lucide-react";
import { TradeChart } from "./components/TradeChart";
import { fetchAiOutcomeReview } from "./lib/aiOutcome";
import { fetchAiParse, toSignalInput } from "./lib/aiParse";
import { fetchAiReview, type AiReview } from "./lib/aiReview";
import { fetchMarketSnapshot, fetchMarketSymbols, resolveMarketSymbol, suggestMarketSymbols } from "./lib/bitget";
import { buildEvidenceReport, isCompletedOutcome, tradeReturnR } from "./lib/evidence";
import { formatUsdAmount, formatUsdPrice } from "./lib/formatters";
import { calculateTradingFee, createPaperTrade, PAPER_TAKER_FEE_RATE_PCT, updatePaperTradeWithMarket, type PaperTradeConfig } from "./lib/paperTrading";
import { createEntryGuidance, createRiskReport } from "./lib/riskEngine";
import { parseLocalSignalDraft, parseSignal, toLocalSignalInput } from "./lib/signalParser";
import { inferTimeframe, resolveTimeframe, TIMEFRAME_OPTIONS, timeframeSourceLabel, type TimeframeSelection } from "./lib/timeframes";
import type { AnalysisTimeframe, MarketSnapshot, PaperTrade, PostTp1Action, RiskFinding, RiskReport, SignalInput, Verdict } from "./lib/types";

const SAMPLE_SIGNAL = `LONG BTCUSDT
around current
TP: 64650 / 65400
SL: 63480
Leverage: 5x`;
const PAPER_LEDGER_KEY = "tradelens.paperTrades.v1";
const THEME_KEY = "tradelens.theme.v1";

type Theme = "dark" | "light";

function loadTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const requestedTheme = new URLSearchParams(window.location.search).get("theme");
  if (requestedTheme === "light" || requestedTheme === "dark") return requestedTheme;
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

type PaperSetupDraft = {
  plans: Array<"original" | "safer">;
  balance: string;
  riskPct: string;
  leverages: Record<"original" | "safer", string>;
  orderTypes: Record<"original" | "safer", PaperTrade["orderType"]>;
  allocations: Record<"original" | "safer", string[]>;
  managementRules: Record<"original" | "safer", PostTp1Action>;
  expires: boolean;
  expiryMinutes: string;
  feeRatePct: string;
};

type DeletePrompt =
  | { kind: "trade"; tradeId: string }
  | { kind: "all" };

function formatMoney(value: number) {
  return formatUsdPrice(value);
}

function formatCompactMoney(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatFunding(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "Unavailable";
  return `${value.toFixed(4)}%`;
}

function formatBookTilt(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "Unavailable";
  if (Math.abs(value) < 5) return "Balanced";
  return `${value > 0 ? "Bid-heavy" : "Ask-heavy"} ${Math.abs(value).toFixed(0)}%`;
}

function formatPct(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(2)}%`;
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}% model confidence`;
}

function formatDataAge(ageSeconds: number) {
  if (ageSeconds < 2) return "under 2s old";
  if (ageSeconds < 60) return `${ageSeconds}s old`;
  return `${Math.ceil(ageSeconds / 60)}m old`;
}

function findingClass(finding: RiskFinding) {
  return `finding finding-${finding.level}`;
}

function verdictTone(report?: RiskReport) {
  if (!report) return "neutral";
  return report.verdict.toLowerCase();
}

function verdictRank(verdict: Verdict) {
  return verdict === "Accept" ? 3 : verdict === "Modify" ? 2 : 1;
}

function capScoreForVerdict(score: number, verdict: Verdict) {
  if (verdict === "Avoid") return Math.min(score, 47);
  if (verdict === "Modify") return Math.min(score, 74);
  return score;
}

function resolveHybridReport(report: RiskReport, review: AiReview): RiskReport {
  if (!review.recommendedVerdict) {
    return {
      ...report,
      engineVerdict: report.engineVerdict ?? report.verdict,
      engineScore: report.engineScore ?? report.score,
    };
  }

  const engineVerdict = report.engineVerdict ?? report.verdict;
  const engineScore = report.engineScore ?? report.score;
  const finalVerdict = verdictRank(review.recommendedVerdict) < verdictRank(engineVerdict) ? review.recommendedVerdict : engineVerdict;
  const finalScore = capScoreForVerdict(engineScore, finalVerdict);
  const finalRiskPct =
    finalVerdict === "Avoid"
      ? 0
      : finalVerdict === "Modify"
        ? Math.min(report.saferPlan.riskPct, 0.75)
        : report.saferPlan.riskPct;

  return {
    ...report,
    verdict: finalVerdict,
    score: finalScore,
    engineVerdict,
    engineScore,
    aiVerdict: review.recommendedVerdict,
    aiConfidence: review.confidence,
    entryGuidance: createEntryGuidance(report.signal, report.market, finalVerdict),
    saferPlan: {
      ...report.saferPlan,
      riskPct: finalRiskPct,
      rationale:
        finalVerdict === "Avoid" && report.saferPlan.riskPct > 0
          ? "The safer plan is to stay flat unless price resets and the setup becomes clearer."
          : report.saferPlan.rationale,
    },
  };
}

function noTradeReason(report: RiskReport) {
  const invalidPlacement = report.findings.some((finding) => finding.label.includes("wrong side"));
  if (invalidPlacement) return "The original setup has invalid risk placement.";
  if (report.aiVerdict === "Avoid") return "The AI risk review recommends staying out of this setup.";
  return "The current setup does not offer enough safety to justify a position.";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatQuantity(value: number) {
  return value >= 1 ? value.toFixed(3) : value.toFixed(6);
}

function calculateRiskReward(entry: number, stopLoss?: number, takeProfit?: number) {
  if (!stopLoss || !takeProfit) return undefined;
  const risk = Math.abs(entry - stopLoss);
  if (!risk) return undefined;
  return Math.abs(takeProfit - entry) / risk;
}

function calculateDistancePct(entry: number, level?: number) {
  if (!level || !entry) return undefined;
  return (Math.abs(level - entry) / entry) * 100;
}

function paperTradePnl(trade: PaperTrade) {
  return trade.realizedPnl + trade.unrealizedPnl;
}

function paperTradeGrossPnl(trade: PaperTrade) {
  return trade.grossRealizedPnl + trade.grossUnrealizedPnl;
}

function paperTradeFees(trade: PaperTrade) {
  return trade.entryFee + trade.exitFees + trade.estimatedExitFee;
}

function formatCostEffect(value: number) {
  const rounded = Math.round(value * 100) / 100;
  if (!rounded) return "$0.00";
  return `${rounded > 0 ? "-" : "+"}${formatUsdAmount(Math.abs(rounded))}`;
}

function paperTradeReturnR(trade: PaperTrade) {
  const riskCash = Math.abs(trade.entry - trade.stopLoss) * trade.quantity;
  return riskCash ? paperTradePnl(trade) / riskCash : 0;
}

function formatR(value?: number) {
  return value === undefined || Number.isNaN(value) ? "n/a" : `${value.toFixed(2)}R`;
}

function formatProfitFactor(value?: number) {
  return value === undefined ? "Not enough data" : value.toFixed(2);
}

function evidenceQualityLabel(quality: "insufficient" | "early" | "developing") {
  if (quality === "insufficient") return "Insufficient sample";
  if (quality === "early") return "Early evidence";
  return "Developing evidence";
}

function formatTradeStatus(status: PaperTrade["status"]) {
  if (status === "take-profit") return "TP hit";
  if (status === "stop-loss") return "SL hit";
  if (status === "waiting-entry") return "Waiting entry";
  if (status === "active") return "Active";
  if (status === "expired") return "Expired";
  return "Stale";
}

function isMonitorableTrade(status: PaperTrade["status"]) {
  return status === "waiting-entry" || status === "active";
}

function isTerminalTrade(status: PaperTrade["status"]) {
  return status === "take-profit" || status === "stop-loss" || status === "expired" || status === "stale";
}

function formatPlanName(plan: PaperTrade["plan"]) {
  return plan === "safer" ? "TradeLens" : "Original";
}

function formatTimeLeft(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";

  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes}m left`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m left` : `${hours}h left`;
}

function marketPulseCopy(report: RiskReport) {
  const pulse = report.marketPulse;
  if (pulse.trend === "bullish") return `Bullish ${report.market.timeframe} pulse. RSI ${pulse.rsi.toFixed(1)} and ATR ${formatPct(pulse.atrPct)}.`;
  if (pulse.trend === "bearish") return `Bearish ${report.market.timeframe} pulse. RSI ${pulse.rsi.toFixed(1)} and ATR ${formatPct(pulse.atrPct)}.`;
  return `Mixed ${report.market.timeframe} pulse. RSI ${pulse.rsi.toFixed(1)} and ATR ${formatPct(pulse.atrPct)}.`;
}

function pnlClass(value: number) {
  if (value > 0) return "pnl-positive";
  if (value < 0) return "pnl-negative";
  return "pnl-flat";
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toCsvValue(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function migratePaperTrade(value: Partial<PaperTrade>): PaperTrade | undefined {
  if (!value.id || !value.reportId || !value.createdAt || !value.plan || !value.pair || !value.side) return undefined;
  if (typeof value.entry !== "number" || typeof value.stopLoss !== "number" || typeof value.takeProfit !== "number") return undefined;
  if (typeof value.quantity === "number" && value.quantity <= 0) return undefined;

  const balanceBefore = value.balanceBefore ?? 10_000;
  const createdAt = value.createdAt;
  const previousStatus = value.status as PaperTrade["status"] | "tracking" | undefined;
  const status =
    previousStatus === "tracking"
      ? "active"
      : previousStatus === "waiting-entry" ||
          previousStatus === "active" ||
          previousStatus === "take-profit" ||
          previousStatus === "stop-loss" ||
          previousStatus === "expired" ||
          previousStatus === "stale"
        ? previousStatus
        : "active";
  const timeframeCandidate = value.timeframe ?? value.timeframeLabel;
  const timeframe: AnalysisTimeframe =
    timeframeCandidate === "5m" ||
    timeframeCandidate === "15m" ||
    timeframeCandidate === "30m" ||
    timeframeCandidate === "1H" ||
    timeframeCandidate === "4H" ||
    timeframeCandidate === "1D"
      ? timeframeCandidate
      : "1H";
  const targets = value.targets?.length
    ? value.targets
    : [{ price: value.takeProfit, allocationPct: 100, hitAt: status === "take-profit" ? value.exitAt : undefined }];
  const quantity = value.quantity ?? 0;
  const fillEntry = value.fillEntry ?? value.entry;
  const feeRatePct = value.feeRatePct ?? PAPER_TAKER_FEE_RATE_PCT;
  const grossRealizedPnl = value.grossRealizedPnl ?? value.realizedPnl ?? 0;
  const grossUnrealizedPnl = value.grossUnrealizedPnl ?? value.unrealizedPnl ?? 0;
  const usesCurrentCostModel = value.costModelVersion === 1;
  const entryFee = usesCurrentCostModel
    ? value.entryFee ?? 0
    : value.entryHitAt
      ? calculateTradingFee(fillEntry, quantity, feeRatePct)
      : 0;
  const targetExitFees = targets.reduce((sum, target) => {
    if (!target.hitAt) return sum;
    const targetQuantity = quantity * (target.allocationPct / 100);
    return sum + calculateTradingFee(target.price, targetQuantity, feeRatePct);
  }, 0);
  const hitTargetQuantity = targets.reduce(
    (sum, target) => sum + (target.hitAt ? quantity * (target.allocationPct / 100) : 0),
    0,
  );
  const stopExitFee = status === "stop-loss"
    ? calculateTradingFee(value.exitPrice ?? value.stopLoss, Math.max(0, quantity - hitTargetQuantity), feeRatePct)
    : 0;
  const exitFees = usesCurrentCostModel ? value.exitFees ?? 0 : targetExitFees + stopExitFee;
  const estimatedExitFee = usesCurrentCostModel
    ? value.estimatedExitFee ?? 0
    : status === "active"
      ? calculateTradingFee(value.currentPrice ?? value.entry, value.remainingQuantity ?? quantity, feeRatePct)
      : 0;
  const fundingCost = value.fundingCost ?? 0;
  const realizedPnl = grossRealizedPnl - entryFee - exitFees - fundingCost;
  const unrealizedPnl = grossUnrealizedPnl - estimatedExitFee;

  return {
    costModelVersion: 1,
    executionModelVersion: 3,
    id: value.id,
    reportId: value.reportId,
    createdAt,
    updatedAt: value.updatedAt ?? createdAt,
    plan: value.plan,
    pair: value.pair,
    side: value.side,
    entry: value.entry,
    fillEntry,
    initialStopLoss: value.initialStopLoss ?? value.stopLoss,
    stopLoss: value.stopLoss,
    takeProfit: value.takeProfit,
    targets,
    leverage: value.leverage ?? 1,
    orderType: value.orderType ?? "market",
    configuredRiskPct: value.configuredRiskPct
      ?? (balanceBefore && quantity ? (Math.abs(value.entry - value.stopLoss) * quantity / balanceBefore) * 100 : 0),
    quantity,
    remainingQuantity: value.remainingQuantity ?? (status === "take-profit" || status === "stop-loss" ? 0 : quantity),
    currentPrice: value.currentPrice ?? value.entry,
    exitPrice: value.exitPrice,
    exitAt: value.exitAt,
    unrealizedPnl: usesCurrentCostModel ? value.unrealizedPnl ?? unrealizedPnl : unrealizedPnl,
    realizedPnl: usesCurrentCostModel ? value.realizedPnl ?? realizedPnl : realizedPnl,
    grossUnrealizedPnl,
    grossRealizedPnl,
    feeRatePct,
    entryFee,
    exitFees,
    estimatedExitFee,
    fundingCost,
    fundingUpdatedAt: value.fundingUpdatedAt ?? value.updatedAt ?? value.entryHitAt,
    balanceBefore,
    balanceAfter: usesCurrentCostModel ? value.balanceAfter ?? balanceBefore : balanceBefore + realizedPnl,
    status,
    timeframeLabel: value.timeframeLabel ?? timeframe,
    timeframe,
    expiresAt: (value.executionModelVersion ?? 0) >= 2 ? value.expiresAt : undefined,
    entryHitAt: value.entryHitAt,
    lastEvaluatedCandleTime: value.lastEvaluatedCandleTime ?? Date.now(),
    spreadBpsAtEntry: value.spreadBpsAtEntry,
    postTp1Action: value.postTp1Action ?? "hold-stop",
    stopMovedAt: value.stopMovedAt,
    provenance: {
      balance: "legacy-default",
      risk: "legacy-default",
      orderType: "legacy-inferred",
      targetAllocation: "legacy-equal",
      expiry: "legacy-removed",
      fees: "legacy-estimate",
      funding: "bitget-live-estimate",
      ...value.provenance,
      management: value.provenance?.management ?? "legacy-hold",
    },
    lifecycleNote: value.lifecycleNote ?? (status === "active" ? "Migrated from an earlier tracking session." : undefined),
    outcomeReview: value.outcomeReview,
  };
}

function loadStoredPaperTrades() {
  const stored = localStorage.getItem(PAPER_LEDGER_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.map(migratePaperTrade).filter((trade): trade is PaperTrade => Boolean(trade)) : [];
  } catch {
    localStorage.removeItem(PAPER_LEDGER_KEY);
    return [];
  }
}

export default function App() {
  const location = useLocation();
  const [rawSignal, setRawSignal] = useState("");
  const [report, setReport] = useState<RiskReport | undefined>();
  const [history, setHistory] = useState<RiskReport[]>([]);
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>(loadStoredPaperTrades);
  const [aiReview, setAiReview] = useState<AiReview | undefined>();
  const [aiError, setAiError] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isRefreshingLedger, setIsRefreshingLedger] = useState(false);
  const [ledgerError, setLedgerError] = useState("");
  const [error, setError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [marketCount, setMarketCount] = useState(0);
  const [timeframeSelection, setTimeframeSelection] = useState<TimeframeSelection>("auto");
  const [isTimeframeMenuOpen, setIsTimeframeMenuOpen] = useState(false);
  const [isReviewingOutcomes, setIsReviewingOutcomes] = useState(false);
  const [lastLedgerRefreshAt, setLastLedgerRefreshAt] = useState<string>();
  const [paperSetup, setPaperSetup] = useState<PaperSetupDraft>();
  const [paperSetupError, setPaperSetupError] = useState("");
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt>();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const refreshInFlight = useRef(false);
  const isTradeMonitor = location.pathname === "/monitor";
  const isEvidenceReport = location.pathname === "/evidence";
  const isSignalDesk = !isTradeMonitor && !isEvidenceReport;
  const viewMeta = isTradeMonitor
    ? { kicker: "Paper execution", title: "Track live outcomes" }
    : isEvidenceReport
      ? { kicker: "Decision evidence", title: "Measure what happened" }
      : { kicker: "Signal intelligence", title: "Review before you follow" };

  const latestPrice = report?.market.price;
  const saferPlanIsTradeable = Boolean(report && report.saferPlan.riskPct > 0);
  const selectedDeleteTrade = deletePrompt?.kind === "trade"
    ? paperTrades.find((trade) => trade.id === deletePrompt.tradeId)
    : undefined;
  const selectedDeletePairCount = selectedDeleteTrade
    ? paperTrades.filter((trade) => trade.reportId === selectedDeleteTrade.reportId).length
    : 0;
  const planComparison = useMemo(() => {
    if (!report) return undefined;

    const originalLeverage = report.signal.leverage ?? 1;
    const saferRiskReward = calculateRiskReward(
      report.saferPlan.entry,
      report.saferPlan.stopLoss,
      report.saferPlan.takeProfit,
    );
    const leverageReduction = originalLeverage > report.saferPlan.leverage
      ? ((originalLeverage - report.saferPlan.leverage) / originalLeverage) * 100
      : 0;

    return {
      originalLeverage,
      saferRiskReward,
      originalStopDistance: report.stopDistancePct,
      saferStopDistance: calculateDistancePct(report.saferPlan.entry, report.saferPlan.stopLoss),
      leverageReduction,
    };
  }, [report]);
  const ledgerSummary = useMemo(() => {
    return paperTrades.reduce(
      (summary, trade) => ({
        monitoring: summary.monitoring + (isMonitorableTrade(trade.status) ? 1 : 0),
        wins: summary.wins + (trade.status === "take-profit" ? 1 : 0),
        losses: summary.losses + (trade.status === "stop-loss" ? 1 : 0),
        deadSignals: summary.deadSignals + (trade.status === "expired" || trade.status === "stale" ? 1 : 0),
        realizedPnl: summary.realizedPnl + trade.realizedPnl,
        unrealizedPnl: summary.unrealizedPnl + trade.unrealizedPnl,
      }),
      { monitoring: 0, wins: 0, losses: 0, deadSignals: 0, realizedPnl: 0, unrealizedPnl: 0 },
    );
  }, [paperTrades]);
  const pairedComparisons = useMemo(() => {
    const grouped = new Map<string, PaperTrade[]>();

    paperTrades.forEach((trade) => {
      grouped.set(trade.reportId, [...(grouped.get(trade.reportId) ?? []), trade]);
    });

    return [...grouped.values()]
      .map((trades) => ({
        original: trades.find((trade) => trade.plan === "original"),
        safer: trades.find((trade) => trade.plan === "safer"),
      }))
      .filter((pair): pair is { original: PaperTrade; safer: PaperTrade } => Boolean(pair.original && pair.safer));
  }, [paperTrades]);
  const evidenceReport = useMemo(() => buildEvidenceReport(paperTrades), [paperTrades]);
  const completedEvidenceTrades = useMemo(
    () => paperTrades
      .filter(isCompletedOutcome)
      .sort((a, b) => new Date(b.exitAt ?? b.updatedAt).getTime() - new Date(a.exitAt ?? a.updatedAt).getTime()),
    [paperTrades],
  );
  const pendingEvidenceTrades = useMemo(
    () => paperTrades
      .filter((trade) => !isCompletedOutcome(trade))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [paperTrades],
  );

  useEffect(() => {
    localStorage.setItem(PAPER_LEDGER_KEY, JSON.stringify(paperTrades));
  }, [paperTrades]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!ledgerSummary.monitoring) return undefined;

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshPaperLedger(true);
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [ledgerSummary.monitoring, paperTrades]);

  async function analyzeSignal() {
    setError("");
    setAiError("");
    setAiReview(undefined);
    setIsAnalyzing(true);
    setIsReviewing(false);
    setIsParsing(true);

    try {
      const symbols = await fetchMarketSymbols();
      setMarketCount(symbols.length);

      let signal: SignalInput;
      let market: MarketSnapshot;
      let entryUsesLivePrice = false;

      try {
        const localDraft = parseLocalSignalDraft(rawSignal, symbols, timeframeSelection);

        if (localDraft) {
          market = await fetchMarketSnapshot(localDraft.pair, localDraft.timeframe, localDraft.timeframeSource);
          signal = toLocalSignalInput(localDraft, rawSignal, market.price);
          entryUsesLivePrice = localDraft.entryMode === "current";
        } else {
          try {
            const parsed = await fetchAiParse(rawSignal);
            const pair = resolveMarketSymbol(parsed.pair, symbols);
            if (!pair) {
              const suggestions = suggestMarketSymbols(parsed.pair, symbols);
              throw new Error(
                suggestions.length
                  ? `I could not find that Bitget futures pair. Did you mean ${suggestions.join(", ")}?`
                  : "I could not find that pair on Bitget USDT futures.",
              );
            }

            const resolvedTimeframe = resolveTimeframe(rawSignal, timeframeSelection, parsed.timeframe);
            market = await fetchMarketSnapshot(pair, resolvedTimeframe.timeframe, resolvedTimeframe.source);
            signal = toSignalInput({ ...parsed, pair }, rawSignal, market.price, timeframeSelection);
            entryUsesLivePrice = parsed.entryMode === "current";
          } catch {
            signal = parseSignal(rawSignal, symbols, timeframeSelection);
            market = await fetchMarketSnapshot(signal.pair, signal.timeframe, signal.timeframeSource);
          }
        }

        if (signal.timeframeSource === "default") {
          const inferredTimeframe = inferTimeframe(signal, market.candles, market.price);
          if (inferredTimeframe !== market.timeframe) {
            market = await fetchMarketSnapshot(signal.pair, inferredTimeframe, "inferred");
          } else {
            market = { ...market, timeframeSource: "inferred" };
          }
          signal = {
            ...signal,
            entry: entryUsesLivePrice ? market.price : signal.entry,
            timeframe: inferredTimeframe,
            timeframeSource: "inferred",
          };
        }
      } finally {
        setIsParsing(false);
      }

      const btcMarket: MarketSnapshot | undefined = signal.pair === "BTCUSDT"
        ? market
        : await fetchMarketSnapshot("BTCUSDT", signal.timeframe, "selected", false).catch(() => undefined);
      const nextReport = createRiskReport(signal, market, btcMarket);
      setReport(nextReport);
      setHistory((current) => [nextReport, ...current].slice(0, 8));
      setIsReviewing(true);

      try {
        const review = await fetchAiReview(nextReport);
        const resolvedReport = resolveHybridReport(nextReport, review);
        setAiReview(review);
        setReport(resolvedReport);
        setHistory((current) => [resolvedReport, ...current.slice(1)].slice(0, 8));
      } catch (caught) {
        setAiError(caught instanceof Error ? caught.message : "AI review is not available yet.");
      } finally {
        setIsReviewing(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "TradeLens could not analyze this signal.");
      setIsParsing(false);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function suggestedOrderType(plan: "original" | "safer"): PaperTrade["orderType"] {
    if (!report || plan === "safer" || report.signal.entryMode === "current") return "market";
    const entryBelowMarket = report.signal.entry < report.market.price;
    const isLimit = report.signal.side === "long" ? entryBelowMarket : !entryBelowMarket;
    return isLimit ? "limit" : "stop";
  }

  function evenAllocations(count: number) {
    if (count <= 1) return ["100"];
    const equal = Math.floor((100 / count) * 100) / 100;
    return Array.from({ length: count }, (_, index) => String(index === count - 1 ? 100 - equal * index : equal));
  }

  function openPaperSetup(plans: Array<"original" | "safer">) {
    if (!report) return;
    setLedgerError("");
    setPaperSetupError("");

    if (plans.includes("safer") && report.saferPlan.riskPct <= 0) {
      setLedgerError("This safer plan is a no-trade recommendation, so TradeLens did not create a zero-size paper position.");
      return;
    }
    if (plans.includes("original") && (!report.signal.stopLoss || !report.signal.takeProfits.length)) {
      setLedgerError("The original signal needs its own stop-loss and take-profit before it can be paper-tracked.");
      return;
    }
    setPaperSetup({
      plans,
      balance: "1000",
      riskPct: "1",
      leverages: {
        original: report.signal.leverage ? String(report.signal.leverage) : "",
        safer: String(report.saferPlan.leverage),
      },
      orderTypes: { original: suggestedOrderType("original"), safer: "market" },
      allocations: {
        original: evenAllocations(report.signal.takeProfits.length || 1),
        safer: ["100"],
      },
      managementRules: {
        original: "hold-stop",
        safer: "hold-stop",
      },
      expires: false,
      expiryMinutes: "",
      feeRatePct: String(PAPER_TAKER_FEE_RATE_PCT),
    });
  }

  function confirmPaperSetup() {
    if (!report || !paperSetup) return;
    const paperBalance = Number(paperSetup.balance);
    const riskPct = Number(paperSetup.riskPct);
    const feeRatePct = Number(paperSetup.feeRatePct);
    const entryExpiryMinutes = paperSetup.expires ? Number(paperSetup.expiryMinutes) : undefined;

    if (!Number.isFinite(paperBalance) || paperBalance <= 0) {
      setPaperSetupError("Enter the paper balance you want to simulate.");
      return;
    }
    if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 5) {
      setPaperSetupError("Choose a shared risk between 0.01% and 5%. TradeLens uses the same risk for both plans so the comparison stays fair.");
      return;
    }
    if (!Number.isFinite(feeRatePct) || feeRatePct < 0) {
      setPaperSetupError("Enter a valid fee percentage per fill.");
      return;
    }
    if (paperSetup.expires && (!entryExpiryMinutes || entryExpiryMinutes <= 0)) {
      setPaperSetupError("Enter how many minutes the unfilled entry should remain valid.");
      return;
    }

    const configs = new Map<"original" | "safer", PaperTradeConfig>();
    for (const plan of paperSetup.plans) {
      const leverage = Number(paperSetup.leverages[plan]);
      const targetAllocations = paperSetup.allocations[plan].map(Number);
      if (!Number.isFinite(leverage) || leverage < 1) {
        setPaperSetupError(`Confirm leverage of at least 1x for the ${plan} plan.`);
        return;
      }
      if (targetAllocations.some((value) => !Number.isFinite(value) || value < 0)) {
        setPaperSetupError(`Enter valid target allocations for the ${plan} plan.`);
        return;
      }
      const allocationTotal = targetAllocations.reduce((sum, value) => sum + value, 0);
      if (Math.abs(allocationTotal - 100) > 0.01) {
        setPaperSetupError(`The ${plan} target allocations must total 100%.`);
        return;
      }
      configs.set(plan, {
        paperBalance,
        riskPct,
        leverage,
        orderType: paperSetup.orderTypes[plan],
        targetAllocations,
        entryExpiryMinutes,
        feeRatePct,
        postTp1Action: paperSetup.managementRules[plan],
      });
    }

    setPaperTrades((current) => {
      const created = paperSetup.plans.map((plan) => createPaperTrade(report, plan, configs.get(plan)!));
      const withoutDuplicates = current.filter(
        (trade) => !(trade.reportId === report.id && paperSetup.plans.includes(trade.plan)),
      );
      return [...created, ...withoutDuplicates].slice(0, 12);
    });
    setPaperSetup(undefined);
    setPaperSetupError("");
  }

  function requestDeletePaperTrade(tradeId: string) {
    if (!import.meta.env.DEV || !paperTrades.some((item) => item.id === tradeId)) return;
    setDeletePrompt({ kind: "trade", tradeId });
  }

  function requestClearPaperLedger() {
    if (!import.meta.env.DEV || !paperTrades.length) return;
    setDeletePrompt({ kind: "all" });
  }

  function confirmPaperTradeDeletion(scope: "single" | "pair" | "all") {
    if (!deletePrompt) return;

    if (scope === "all" || deletePrompt.kind === "all") {
      setPaperTrades([]);
    } else {
      const selected = paperTrades.find((trade) => trade.id === deletePrompt.tradeId);
      if (!selected) {
        setDeletePrompt(undefined);
        return;
      }
      setPaperTrades((current) => current.filter((trade) => scope === "pair" ? trade.reportId !== selected.reportId : trade.id !== selected.id));
    }
    setLedgerError("");
    setDeletePrompt(undefined);
  }

  async function generateOutcomeReviews(newlyTerminal: PaperTrade[], updatedTrades: PaperTrade[]) {
    setIsReviewingOutcomes(true);

    try {
      const reviewedTrades = await Promise.all(
        newlyTerminal.map(async (trade) => {
          const counterpart = updatedTrades.find(
            (candidate) => candidate.reportId === trade.reportId && candidate.plan !== trade.plan,
          );
          try {
            const outcomeReview = await fetchAiOutcomeReview(trade, counterpart);
            return { tradeId: trade.id, outcomeReview };
          } catch {
            return undefined;
          }
        }),
      );

      const completedReviews = reviewedTrades.filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (completedReviews.length) {
        const reviewByTradeId = new Map(completedReviews.map((item) => [item.tradeId, item.outcomeReview]));
        setPaperTrades((current) =>
          current.map((trade) => {
            const outcomeReview = reviewByTradeId.get(trade.id);
            return outcomeReview ? { ...trade, outcomeReview } : trade;
          }),
        );
      }
    } finally {
      setIsReviewingOutcomes(false);
    }
  }

  async function refreshPaperLedger(automatic = false) {
    if (refreshInFlight.current) return;
    const trackingTrades = paperTrades.filter((trade) => isMonitorableTrade(trade.status));
    if (!trackingTrades.length) return;

    refreshInFlight.current = true;
    if (!automatic) setLedgerError("");
    setIsRefreshingLedger(true);

    try {
      const markets = [...new Map(trackingTrades.map((trade) => [`${trade.pair}:${trade.timeframe}`, trade])).values()];
      const snapshots = await Promise.all(
        markets.map((trade) => fetchMarketSnapshot(trade.pair, trade.timeframe, "selected", true)),
      );
      const snapshotByMarket = new Map(snapshots.map((snapshot) => [`${snapshot.pair}:${snapshot.timeframe}`, snapshot]));
      const previousById = new Map(paperTrades.map((trade) => [trade.id, trade]));
      const updatedTrades = paperTrades.map((trade) => {
        const snapshot = snapshotByMarket.get(`${trade.pair}:${trade.timeframe}`);
        return snapshot ? updatePaperTradeWithMarket(trade, snapshot) : trade;
      });
      const newlyTerminal = updatedTrades.filter((trade) => {
        const previous = previousById.get(trade.id);
        return previous && isMonitorableTrade(previous.status) && isTerminalTrade(trade.status) && !trade.outcomeReview;
      });

      setPaperTrades(updatedTrades);
      setLastLedgerRefreshAt(new Date().toISOString());

      if (newlyTerminal.length) {
        void generateOutcomeReviews(newlyTerminal, updatedTrades);
      }
    } catch (caught) {
      if (!automatic) setLedgerError(caught instanceof Error ? caught.message : "Unable to refresh paper ledger.");
    } finally {
      refreshInFlight.current = false;
      setIsRefreshingLedger(false);
    }
  }

  function exportPaperLedger(format: "json" | "csv") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "json") {
      downloadFile(`tradelens-paper-ledger-${timestamp}.json`, JSON.stringify(paperTrades, null, 2), "application/json");
      return;
    }

    const headers = [
      "createdAt",
      "updatedAt",
      "plan",
      "executionModelVersion",
      "pair",
      "side",
      "entry",
      "fillEntry",
      "initialStopLoss",
      "stopLoss",
      "takeProfit",
      "targets",
      "leverage",
      "orderType",
      "configuredRiskPct",
      "quantity",
      "remainingQuantity",
      "currentPrice",
      "status",
      "timeframeLabel",
      "expiresAt",
      "entryHitAt",
      "postTp1Action",
      "stopMovedAt",
      "spreadBpsAtEntry",
      "feeRatePct",
      "entryFee",
      "exitFees",
      "estimatedExitFee",
      "fundingCost",
      "grossRealizedPnl",
      "grossUnrealizedPnl",
      "exitPrice",
      "realizedPnl",
      "unrealizedPnl",
      "balanceBefore",
      "balanceAfter",
      "lifecycleNote",
      "provenance",
      "outcomeHeadline",
      "outcomeSummary",
      "outcomeLesson",
      "outcomeNextAction",
    ];
    const rows = paperTrades.map((trade) => {
      const values: Record<string, unknown> = {
        ...trade,
        targets: JSON.stringify(trade.targets),
        provenance: JSON.stringify(trade.provenance),
        outcomeHeadline: trade.outcomeReview?.headline,
        outcomeSummary: trade.outcomeReview?.summary,
        outcomeLesson: trade.outcomeReview?.lesson,
        outcomeNextAction: trade.outcomeReview?.nextAction,
      };
      return headers.map((header) => toCsvValue(values[header])).join(",");
    });

    downloadFile(`tradelens-paper-ledger-${timestamp}.csv`, [headers.join(","), ...rows].join("\n"), "text/csv");
  }

  function exportEvidenceReport() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const records = paperTrades
      .map((trade) => ({
        recordId: trade.id,
        comparisonId: trade.reportId,
        createdAt: trade.createdAt,
        updatedAt: trade.updatedAt,
        completedAt: trade.exitAt ?? null,
        plan: formatPlanName(trade.plan),
        status: formatTradeStatus(trade.status),
        market: trade.pair,
        direction: trade.side,
        analysisTimeframe: trade.timeframeLabel,
        entryOrder: trade.orderType,
        entryPrice: trade.entry,
        fillEntryPrice: trade.fillEntry,
        stopLoss: trade.stopLoss,
        initialStopLoss: trade.initialStopLoss,
        takeProfit: trade.takeProfit,
        targets: trade.targets,
        leverage: trade.leverage,
        simulatedBalanceBefore: trade.balanceBefore,
        simulatedBalanceAfter: trade.balanceAfter,
        configuredRiskPct: trade.configuredRiskPct,
        quantity: trade.quantity,
        remainingQuantity: trade.remainingQuantity,
        currentPrice: trade.currentPrice,
        exitPrice: trade.exitPrice ?? null,
        entryHitAt: trade.entryHitAt ?? null,
        grossPnl: paperTradeGrossPnl(trade),
        netPnl: paperTradePnl(trade),
        estimatedFees: paperTradeFees(trade),
        fundingEstimate: trade.fundingCost,
        returnR: tradeReturnR(trade),
        lifecycleNote: trade.lifecycleNote ?? null,
        provenance: trade.provenance,
        outcomeReview: trade.outcomeReview ?? null,
      }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const payload = {
      app: "TradeLens",
      reportType: "paper-trading evidence export",
      exportVersion: 2,
      exportedAt: new Date().toISOString(),
      ...evidenceReport,
      submissionSummary: {
        trackedTrades: evidenceReport.trackedTrades,
        completedOutcomes: evidenceReport.completedOutcomes,
        completedPairs: evidenceReport.completedPairs,
        stillMonitoring: evidenceReport.monitoringTrades,
        expiredOrStale: evidenceReport.expiredOrStale,
        sampleQuality: evidenceReport.sampleQuality,
        note: evidenceReport.completedOutcomes
          ? "Completed TP/SL outcomes are available for audit."
          : "No TP/SL outcomes have completed yet. Active records show what TradeLens is currently monitoring.",
      },
      dataSources: {
        marketData: "Bitget USDT futures public market data.",
        prices: "Live ticker snapshots are used for signal analysis and paper-trade refreshes.",
        candles: "Bitget closed candles are used for timeframe, ATR, RSI, trend, and TP/SL outcome checks.",
        derivatives: "Funding, open interest, spread, order-book depth, mark price, and index price are fetched from Bitget futures market endpoints when available.",
        aiReview: "Qwen is used for natural-language review; TP/SL paper outcomes are still determined from Bitget market levels.",
      },
      methodology: {
        outcomes: "Only paper trades that reached a take-profit or stop-loss count toward performance metrics.",
        comparison: "Original and safer plans are compared only when both plans from the same analyzed signal have completed.",
        costs: "Net PnL includes observed spread, an estimated taker fee per fill, and funding estimated from Bitget's live rate.",
        limitations: "Results are simulated, account-specific fees may differ, and past paper outcomes do not predict future returns.",
      },
      records: {
        all: records,
        monitoring: records.filter((trade) => trade.status === "Active" || trade.status === "Waiting entry"),
        completed: records.filter((trade) => trade.status === "TP hit" || trade.status === "SL hit"),
        expiredOrStale: records.filter((trade) => trade.status === "Expired" || trade.status === "Stale"),
      },
      rawLedger: paperTrades,
    };
    downloadFile(`tradelens-evidence-${timestamp}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  return (
    <main className="app-shell">
      <aside className="terminal-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark"><img src="/tradelens-mark.svg" alt="" aria-hidden="true" /></span>
          <div>
            <strong>TradeLens</strong>
            <span>Risk terminal</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="TradeLens views">
          <NavLink to="/" end>
            <ScanLine aria-hidden="true" />
            <span className="nav-label">Signal Desk</span>
          </NavLink>
          <NavLink to="/monitor">
            <Activity aria-hidden="true" />
            <span className="nav-label">Trade Monitor</span>
            {ledgerSummary.monitoring ? <span className="nav-count">{ledgerSummary.monitoring}</span> : null}
          </NavLink>
          <NavLink to="/evidence">
            <BarChart3 aria-hidden="true" />
            <span className="nav-label">Evidence</span>
            {evidenceReport.completedOutcomes ? <span className="nav-count">{evidenceReport.completedOutcomes}</span> : null}
          </NavLink>
        </nav>

        <div className="sidebar-lower">
          <section className="theme-section" aria-label="Appearance">
            <span>Appearance</span>
            <div className="theme-switch">
              <button type="button" className={theme === "dark" ? "is-active" : ""} onClick={() => setTheme("dark")} aria-pressed={theme === "dark"}>
                <Moon aria-hidden="true" /> Dark
              </button>
              <button type="button" className={theme === "light" ? "is-active" : ""} onClick={() => setTheme("light")} aria-pressed={theme === "light"}>
                <Sun aria-hidden="true" /> Light
              </button>
            </div>
          </section>
          <div className="sidebar-status">
            <span />
            <div><strong>Bitget connected</strong><small>Public market data</small></div>
          </div>
        </div>
      </aside>

      <div className="terminal-stage">
        <header className="topbar">
          <div className="topbar-title">
            <span>{viewMeta.kicker}</span>
            <h1>{viewMeta.title}</h1>
          </div>
          <div className="topbar-actions">
            <div className="live-pill">
              <span />
              {marketCount ? `${marketCount} futures markets` : "Live market checks"}
            </div>
            <button type="button" className="compact-theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </button>
          </div>
        </header>

        <div className="terminal-content">

      {paperSetup && report ? (
        <div className="paper-setup-backdrop" role="presentation">
          <section className="paper-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-setup-title">
            <div className="paper-setup-heading">
              <div>
                <p className="eyebrow">Paper trade setup</p>
                <h2 id="paper-setup-title">Confirm how this trade should behave</h2>
                <p>TradeLens will not create a paper position until you confirm these missing trading decisions.</p>
              </div>
              <button type="button" className="ghost-button tiny" onClick={() => setPaperSetup(undefined)} aria-label="Close paper trade setup">
                Close
              </button>
            </div>

            <div className="paper-beginner-note">
              <strong>Beginner example loaded</strong>
              <p>$1,000 simulated balance and 1% risk means each plan may lose about $10 if its stop is hit. Both plans use the same loss limit so the comparison is fair.</p>
            </div>

            <div className="paper-setup-common">
              <label>
                <span>Simulated account balance</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={paperSetup.balance}
                  placeholder="Amount you want to simulate"
                  onChange={(event) => setPaperSetup((current) => current ? { ...current, balance: event.target.value } : current)}
                />
                <small>Example: $1,000 means the test behaves like an account containing $1,000. No real money is used.</small>
              </label>
              <label>
                <span>Maximum loss if the stop is hit</span>
                <div className="input-suffix"><input
                  type="number"
                  min="0.01"
                  max="5"
                  step="0.01"
                  value={paperSetup.riskPct}
                  onChange={(event) => setPaperSetup((current) => current ? { ...current, riskPct: event.target.value } : current)}
                /><b>%</b></div>
                <small>Shared by both plans. At the loaded $1,000 balance, 1% means about $10 maximum planned loss per plan.</small>
              </label>
              <label>
                <span>Estimated trading fee</span>
                <div className="input-suffix"><input
                  type="number"
                  min="0"
                  step="0.01"
                  value={paperSetup.feeRatePct}
                  onChange={(event) => setPaperSetup((current) => current ? { ...current, feeRatePct: event.target.value } : current)}
                /><b>%</b></div>
                <small>Leave this at 0.06% unless you know your Bitget fee tier. A fill means an order was executed.</small>
              </label>
            </div>

            <div className="paper-plan-configs">
              {paperSetup.plans.map((plan) => {
                const targetPrices = plan === "original"
                  ? (report.signal.takeProfits.length ? report.signal.takeProfits : [report.saferPlan.takeProfit])
                  : [report.saferPlan.takeProfit];
                return (
                  <section className="paper-plan-config" key={plan}>
                    <div>
                      <p className="eyebrow">{plan === "original" ? "Original signal" : "TradeLens plan"}</p>
                      <h2>{report.signal.pair}</h2>
                    </div>
                    <div className="paper-plan-fields">
                      <label>
                        <span>Leverage</span>
                        <div className="input-suffix"><input
                          type="number"
                          min="1"
                          step="1"
                          value={paperSetup.leverages[plan]}
                          placeholder="Confirm leverage"
                          onChange={(event) => setPaperSetup((current) => current ? {
                            ...current,
                            leverages: { ...current.leverages, [plan]: event.target.value },
                          } : current)}
                        /><b>x</b></div>
                        <small>Keep the displayed value to test the signal exactly as analyzed. Leverage multiplies profit, loss, and liquidation pressure.</small>
                      </label>
                      <label>
                        <span>Entry order</span>
                        <select
                          value={paperSetup.orderTypes[plan]}
                          onChange={(event) => setPaperSetup((current) => current ? {
                            ...current,
                            orderTypes: { ...current.orderTypes, [plan]: event.target.value as PaperTrade["orderType"] },
                          } : current)}
                        >
                          <option value="market">Market - enter immediately</option>
                          <option value="limit">Limit - fill at this price or better</option>
                          <option value="stop">Stop entry - enter after price crosses</option>
                        </select>
                        <small>Market enters now. Limit waits for a better price. Stop entry waits for price to cross a trigger.</small>
                      </label>
                    </div>
                    <div className="target-allocation-fields">
                      <span>Position sold at each target</span>
                      {targetPrices.map((target, index) => (
                        <label key={`${plan}-${target}-${index}`}>
                          <span>TP{index + 1} - {formatMoney(target)}</span>
                          <div className="input-suffix"><input
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={paperSetup.allocations[plan][index] ?? ""}
                            onChange={(event) => setPaperSetup((current) => {
                              if (!current) return current;
                              const nextAllocations = [...current.allocations[plan]];
                              nextAllocations[index] = event.target.value;
                              return {
                                ...current,
                                allocations: { ...current.allocations, [plan]: nextAllocations },
                              };
                            })}
                          /><b>%</b></div>
                        </label>
                      ))}
                      <small>These boxes must total 100%. A 50/50 split sells half at the first target and the other half at the second.</small>
                    </div>
                    {targetPrices.length > 1 ? (
                      <label className="post-tp1-control">
                        <span>After TP1 is reached</span>
                        <select
                          value={paperSetup.managementRules[plan]}
                          onChange={(event) => setPaperSetup((current) => current ? {
                            ...current,
                            managementRules: {
                              ...current.managementRules,
                              [plan]: event.target.value as PostTp1Action,
                            },
                          } : current)}
                        >
                          <option value="hold-stop">Keep the original stop</option>
                          <option value="move-stop-to-entry">Move the remaining stop to entry</option>
                        </select>
                        <small>Moving the stop to entry protects the remaining position from a larger price loss, but fees can still leave a small net loss.</small>
                      </label>
                    ) : null}
                  </section>
                );
              })}
            </div>

            <div className="paper-expiry-config">
              {paperSetup.plans.every((plan) => paperSetup.orderTypes[plan] === "market") ? (
                <p>Both market orders enter immediately, so there is no waiting order to expire.</p>
              ) : (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={paperSetup.expires}
                      onChange={(event) => setPaperSetup((current) => current ? { ...current, expires: event.target.checked } : current)}
                    />
                    <span>Cancel any unfilled limit or stop entry after a specific time</span>
                  </label>
                  {paperSetup.expires ? (
                    <label>
                      <span>Entry validity</span>
                      <div className="input-suffix"><input
                        type="number"
                        min="1"
                        step="1"
                        value={paperSetup.expiryMinutes}
                        placeholder="Minutes"
                        onChange={(event) => setPaperSetup((current) => current ? { ...current, expiryMinutes: event.target.value } : current)}
                      /><b>min</b></div>
                    </label>
                  ) : <p>Any waiting order remains good-till-cancelled. Open positions never receive an automatic time exit.</p>}
                </>
              )}
            </div>

            {paperSetupError ? <p className="error-text">{paperSetupError}</p> : null}
            <div className="paper-setup-actions">
              <button type="button" className="ghost-button" onClick={() => setPaperSetup(undefined)}>Cancel</button>
              <button type="button" className="primary-button small" onClick={confirmPaperSetup}>Start paper tracking</button>
            </div>
          </section>
        </div>
      ) : null}

      {deletePrompt ? (
        <div className="paper-setup-backdrop" role="presentation">
          <section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description">
            <p className="eyebrow">Remove paper evidence</p>
            <h2 id="delete-confirm-title">{deletePrompt.kind === "all" ? "Clear every test trade?" : `Delete ${selectedDeleteTrade?.pair ?? "this trade"}?`}</h2>
            <p id="delete-confirm-description">
              {deletePrompt.kind === "all"
                ? `This removes all ${paperTrades.length} locally tracked paper trades and their evidence. It cannot be undone.`
                : `This removes the ${selectedDeleteTrade?.plan === "safer" ? "TradeLens plan" : "original signal"} from the local paper ledger. It does not place or cancel a real Bitget trade.`}
            </p>
            {deletePrompt.kind === "trade" && selectedDeletePairCount > 1 ? (
              <div className="delete-pair-note">
                <strong>This trade belongs to a comparison pair.</strong>
                <span>You can remove only this plan or remove both the original and TradeLens plans together.</span>
              </div>
            ) : null}
            <div className="delete-confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setDeletePrompt(undefined)}>Keep trade</button>
              {deletePrompt.kind === "trade" && selectedDeletePairCount > 1 ? (
                <button type="button" className="delete-button confirm-delete-button" onClick={() => confirmPaperTradeDeletion("single")}>Delete this plan</button>
              ) : null}
              <button type="button" className="delete-button confirm-delete-button" onClick={() => confirmPaperTradeDeletion(deletePrompt.kind === "all" ? "all" : "pair")}>
                {deletePrompt.kind === "all" ? "Delete all test trades" : selectedDeletePairCount > 1 ? "Delete both plans" : "Delete trade"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <section className={`workspace ${isSignalDesk ? "" : "route-hidden"}`}>
        <section className="signal-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Signal scanner</p>
              <h2>Paste a trade before you follow it</h2>
            </div>
            <div className="signal-header-actions">
              <div className="timeframe-menu-wrap">
                <button
                  type="button"
                  className="ghost-button tiny timeframe-trigger"
                  aria-expanded={isTimeframeMenuOpen}
                  onClick={() => setIsTimeframeMenuOpen((current) => !current)}
                >
                  {timeframeSelection === "auto" ? "Auto timeframe" : `${timeframeSelection} timeframe`}
                </button>
                {isTimeframeMenuOpen ? (
                  <div className="timeframe-menu">
                    <span>Analysis timeframe</span>
                    <small>Auto reads the signal or infers a timeframe from its risk and live volatility.</small>
                    <div className="timeframe-options" role="group" aria-label="Analysis timeframe">
                      <button
                        type="button"
                        className={timeframeSelection === "auto" ? "is-selected" : ""}
                        onClick={() => {
                          setTimeframeSelection("auto");
                          setIsTimeframeMenuOpen(false);
                        }}
                      >
                        Auto
                      </button>
                      {TIMEFRAME_OPTIONS.map((timeframe) => (
                        <button
                          type="button"
                          className={timeframeSelection === timeframe ? "is-selected" : ""}
                          onClick={() => {
                            setTimeframeSelection(timeframe);
                            setIsTimeframeMenuOpen(false);
                          }}
                          key={timeframe}
                        >
                          {timeframe}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <button type="button" className="ghost-button" onClick={() => setRawSignal(SAMPLE_SIGNAL)}>
                Load sample
              </button>
            </div>
          </div>
          <textarea
            value={rawSignal}
            onChange={(event) => setRawSignal(event.target.value)}
            placeholder="Paste a signal from Telegram, Discord, X, or anywhere else..."
            spellCheck={false}
          />
          <button type="button" className="primary-button" onClick={analyzeSignal} disabled={isAnalyzing}>
            {isParsing ? "Reading signal..." : isAnalyzing ? "Checking live market..." : "Analyze with TradeLens"}
          </button>
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className={`verdict-panel verdict-${verdictTone(report)}`}>
          <p className="eyebrow">{report && isReviewing ? "Preliminary engine verdict" : "Final verdict"}</p>
          {report ? (
            <>
              <div className="score-row">
                <strong>{report.verdict}</strong>
                <span>{report.score}/100</span>
              </div>
              <p className="score-context">
                {isReviewing
                  ? "Qwen is reviewing this result and may make it stricter."
                  : "Risk-structure score, not estimated win probability."}
              </p>
              <p className="verdict-copy">
                {report.verdict === "Accept"
                  ? "The setup passed the current structural checks. This does not predict profit."
                  : report.verdict === "Modify"
                    ? "The trade has usable intent, but the current version needs safer risk controls."
                    : "This signal is too fragile under current live conditions."}
              </p>
              <dl className="metrics-grid">
                <div>
                  <dt>Live price</dt>
                  <dd>{formatMoney(report.market.price)}</dd>
                </div>
                <div>
                  <dt>Entry gap</dt>
                  <dd>{formatPct(report.entryDistancePct)}</dd>
                </div>
                <div>
                  <dt>ATR volatility</dt>
                  <dd>{formatPct(report.volatilityPct)}</dd>
                </div>
                <div>
                  <dt>Risk/reward</dt>
                  <dd>{report.riskReward ? `${report.riskReward.toFixed(2)}R` : "n/a"}</dd>
                </div>
                <div>
                  <dt>Trend pulse</dt>
                  <dd>{report.marketPulse.trend}</dd>
                </div>
                <div>
                  <dt>RSI</dt>
                  <dd>{report.marketPulse.rsi.toFixed(1)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="empty-state">Run a signal check to see the risk score, verdict, and live price context.</p>
          )}
        </section>
      </section>

      {report ? (
        <section className={`analysis-provenance ${isSignalDesk ? "" : "route-hidden"}`} aria-label="Analysis data sources">
          <div><span>Signal levels</span><strong>User supplied</strong></div>
          <div><span>Market data</span><strong>Live Bitget</strong></div>
          <div>
            <span>Timeframe</span>
            <strong>{report.signal.timeframeSource === "signal" || report.signal.timeframeSource === "selected" ? "User selected" : "TradeLens estimate"}</strong>
          </div>
          <div><span>Risk score + safer plan</span><strong>TradeLens policy</strong></div>
          <div><span>Written review</span><strong>Qwen interpretation</strong></div>
        </section>
      ) : null}

      <section className={`results-grid ${isSignalDesk ? "" : "route-hidden"}`}>
        {report ? <TradeChart report={report} theme={theme} /> : null}
        {report ? (
          <section className={`surface entry-guidance-panel entry-guidance-${report.entryGuidance.action}`}>
            <div>
              <p className="eyebrow">Entry instruction</p>
              <h2>{report.entryGuidance.title}</h2>
              <p>{report.entryGuidance.detail}</p>
            </div>
            <dl>
              <div>
                <dt>Suggested order</dt>
                <dd>{report.entryGuidance.suggestedOrderType?.toUpperCase() ?? "None"}</dd>
              </div>
              <div>
                <dt>Distance from live price</dt>
                <dd>{report.entryGuidance.distanceInAtr.toFixed(2)} ATR</dd>
              </div>
            </dl>
          </section>
        ) : null}
        <section className="surface ai-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">AI analyst</p>
              <h2>AI trade review</h2>
            </div>
            {isReviewing ? <span className="review-status">Thinking</span> : null}
          </div>
          {aiReview ? (
            <div className="ai-review">
              {aiReview.recommendedVerdict ? (
                <div className="ai-verdict-strip">
                  <span>AI recommends</span>
                  <strong>{aiReview.recommendedVerdict}</strong>
                  <em>{formatConfidence(aiReview.confidence)}</em>
                </div>
              ) : null}
              <p className="ai-summary">{aiReview.summary}</p>
              <div>
                <span>{aiReview.recommendedVerdict === "Accept" ? "What to watch" : "Main risks"}</span>
                <ul>
                  {aiReview.mainRisks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span>Safer plan</span>
                <p>{aiReview.saferPlan}</p>
              </div>
              {aiReview.missingInfo.length ? (
                <div>
                  <span>Missing info</span>
                  <ul>
                    {aiReview.missingInfo.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : isReviewing ? (
            <p className="empty-state">TradeLens is turning the risk math into a trader-readable review.</p>
          ) : aiError ? (
            <p className="error-text">{aiError}</p>
          ) : (
            <p className="empty-state">AI review appears here after a live signal check.</p>
          )}
        </section>

        <section className="surface comparison-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Plan comparison</p>
              <h2>Original signal vs TradeLens</h2>
            </div>
          </div>
          {report && planComparison ? (
            <>
              <div className="comparison-grid">
                <article className="comparison-card comparison-original">
                  <div className="comparison-card-heading">
                    <div>
                      <span>As received</span>
                      <strong>Original signal</strong>
                    </div>
                    <b>{report.verdict === "Accept" ? "Usable" : "Needs review"}</b>
                  </div>
                  <dl>
                    <div><dt>Entry</dt><dd>{formatMoney(report.signal.entry)}</dd></div>
                    <div><dt>Stop</dt><dd>{report.signal.stopLoss ? formatMoney(report.signal.stopLoss) : "Missing"}</dd></div>
                    <div><dt>Target</dt><dd>{report.signal.takeProfits[0] ? formatMoney(report.signal.takeProfits[0]) : "Missing"}</dd></div>
                    <div><dt>Leverage</dt><dd>{planComparison.originalLeverage}x</dd></div>
                    <div><dt>Risk/reward</dt><dd>{formatR(report.riskReward)}</dd></div>
                    <div><dt>Live entry gap</dt><dd>{formatPct(report.entryDistancePct)}</dd></div>
                  </dl>
                </article>

                <article className={`comparison-card ${saferPlanIsTradeable ? "comparison-safer" : "comparison-flat"}`}>
                  <div className="comparison-card-heading">
                    <div>
                      <span>Risk-adjusted</span>
                      <strong>{saferPlanIsTradeable ? "TradeLens plan" : "Stay flat"}</strong>
                    </div>
                    <b>{saferPlanIsTradeable ? "Protected" : "No trade"}</b>
                  </div>
                  {saferPlanIsTradeable ? (
                    <dl>
                      <div><dt>Entry</dt><dd>{formatMoney(report.saferPlan.entry)}</dd></div>
                      <div><dt>Stop</dt><dd>{formatMoney(report.saferPlan.stopLoss)}</dd></div>
                      <div><dt>Target</dt><dd>{formatMoney(report.saferPlan.takeProfit)}</dd></div>
                      <div><dt>Max leverage</dt><dd>{report.saferPlan.leverage}x</dd></div>
                      <div><dt>Risk/reward</dt><dd>{formatR(planComparison.saferRiskReward)}</dd></div>
                      <div><dt>Paper risk cap</dt><dd>{formatPct(report.saferPlan.riskPct)}</dd></div>
                    </dl>
                  ) : (
                    <div className="comparison-no-trade">
                      <strong>Capital stays untouched.</strong>
                      <p>{noTradeReason(report)}</p>
                    </div>
                  )}
                </article>
              </div>

              <div className="comparison-impact">
                <div>
                  <span>Leverage change</span>
                  <strong>
                    {saferPlanIsTradeable
                      ? planComparison.leverageReduction
                        ? `-${planComparison.leverageReduction.toFixed(0)}%`
                        : "No increase"
                      : "No leverage"}
                  </strong>
                </div>
                <div>
                  <span>Entry alignment</span>
                  <strong>{saferPlanIsTradeable ? `${formatPct(report.entryDistancePct)} to live price` : "Entry cancelled"}</strong>
                </div>
                <div>
                  <span>Stop buffer</span>
                  <strong>{saferPlanIsTradeable ? `${formatPct(planComparison.originalStopDistance)} to ${formatPct(planComparison.saferStopDistance)}` : "Risk removed"}</strong>
                </div>
                <p>
                  {saferPlanIsTradeable
                    ? "Track both from the same paper balance to see whether the risk adjustments improve survival and outcome quality."
                    : "TradeLens is comparing the original signal against the decision not to expose capital at all."}
                </p>
              </div>
              <div className="button-row comparison-actions">
                <button type="button" className="ghost-button" onClick={() => openPaperSetup(["original"])}>
                  Track original
                </button>
                {saferPlanIsTradeable ? (
                  <>
                    <button type="button" className="ghost-button" onClick={() => openPaperSetup(["safer"])}>
                      Track safer plan
                    </button>
                    <button type="button" className="primary-button small" onClick={() => openPaperSetup(["original", "safer"])}>
                      Paper-track both
                    </button>
                  </>
                ) : (
                  <span className="inactive-action">Stay flat - no paper trade</span>
                )}
              </div>
            </>
          ) : (
            <p className="empty-state">Analyze a signal to compare its risk structure with the TradeLens plan.</p>
          )}
        </section>

        <section className="surface pulse-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Market pulse</p>
              <h2>What the chart is saying</h2>
            </div>
            {report ? (
              <span className="timeframe-badge">
                {report.market.timeframe} - {timeframeSourceLabel(report.market.timeframeSource)}
              </span>
            ) : null}
          </div>
          {report ? (
            <>
              <p className="data-quality-line">
                Bitget snapshot - {formatDataAge(report.market.dataQuality.ageSeconds)} - {report.market.dataQuality.closedCandles} closed candles
              </p>
              <p className="pulse-copy">{marketPulseCopy(report)}</p>
              <div className="pulse-grid">
                <div>
                  <span>Trend</span>
                  <strong>{report.marketPulse.trend}</strong>
                  <p>{report.marketPulse.bias}</p>
                </div>
                <div>
                  <span>Fast EMA</span>
                  <strong>{formatMoney(report.marketPulse.emaFast)}</strong>
                  <p>Short-term average used for momentum context.</p>
                </div>
                <div>
                  <span>Slow EMA</span>
                  <strong>{formatMoney(report.marketPulse.emaSlow)}</strong>
                  <p>Longer average used to spot trend alignment.</p>
                </div>
                <div>
                  <span>ATR range</span>
                  <strong>{formatPct(report.marketPulse.atrPct)}</strong>
                  <p>Wilder ATR estimates a normal candle range as a share of live price.</p>
                </div>
              </div>
              {report.btcContext ? (
                <div className={`btc-context-strip btc-context-${report.btcContext.alignment}`}>
                  <div>
                    <span>Bitcoin context</span>
                    <strong>{report.btcContext.alignment === "same-market" ? "Main market" : report.btcContext.alignment}</strong>
                  </div>
                  <p>{report.btcContext.summary}</p>
                  <small>BTC {report.btcContext.timeframe} pulse from completed Bitget candles.</small>
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty-state">TradeLens will read recent candles after a live check.</p>
          )}
        </section>

        <section className="surface">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Risk reasons</p>
              <h2>What TradeLens found</h2>
            </div>
          </div>
          {report ? (
            <div className="findings">
              {report.findings.map((finding) => (
                <article className={findingClass(finding)} key={`${finding.label}-${finding.detail}`}>
                  <span>{finding.level}</span>
                  <div>
                    <strong>{finding.label}</strong>
                    <p>{finding.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">Risk reasons will appear after the first live check.</p>
          )}
        </section>

        <section className="surface derivatives-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Derivatives pulse</p>
              <h2>How futures traders are positioned</h2>
            </div>
            <span className="derivatives-source">Live Bitget futures</span>
          </div>
          {report ? (
            <div className="derivatives-grid">
              <div>
                <span>Funding rate</span>
                <strong>{formatFunding(report.market.derivatives.fundingRatePct)}</strong>
                <p>Positive means long positions pay shorts; negative means shorts pay longs.</p>
              </div>
              <div>
                <span>Open interest</span>
                <strong>{formatCompactMoney(report.market.derivatives.openInterestUsd)}</strong>
                <p>Approximate value still committed to open futures positions.</p>
              </div>
              <div>
                <span>Bid/ask spread</span>
                <strong>
                  {report.market.derivatives.spreadBps === undefined
                    ? "Unavailable"
                    : `${report.market.derivatives.spreadBps.toFixed(2)} bps`}
                </strong>
                <p>Smaller spreads usually mean cheaper entries and exits.</p>
              </div>
              <div>
                <span>Order-book tilt</span>
                <strong>{formatBookTilt(report.market.derivatives.bookImbalancePct)}</strong>
                <p>A short-lived snapshot of visible buy versus sell liquidity.</p>
              </div>
              <div>
                <span>Mark/index basis</span>
                <strong>
                  {report.market.derivatives.basisPct === undefined
                    ? "Unavailable"
                    : `${report.market.derivatives.basisPct.toFixed(3)}%`}
                </strong>
                <p>Shows how far the perpetual mark price sits from the underlying index.</p>
              </div>
            </div>
          ) : (
            <p className="empty-state">Derivatives positioning appears after a live signal check.</p>
          )}
        </section>

      </section>

      <section className={`view-heading ${isTradeMonitor ? "" : "route-hidden"}`}>
        <div>
          <p className="eyebrow">Trade Monitor</p>
          <h2>Watch every paper decision develop</h2>
        </div>
        <p>Original and safer plans stay paired from entry through outcome review.</p>
      </section>

      <section className={`paper-section ${isTradeMonitor ? "" : "route-hidden"}`}>
        <section className="surface">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Paper tracking</p>
              <h2>Tracked trades</h2>
            </div>
            <div className="ledger-actions">
              {ledgerSummary.monitoring ? (
                <span className="auto-monitor-state">
                  <i />
                  {isReviewingOutcomes
                    ? "Writing outcome review"
                    : lastLedgerRefreshAt
                      ? `Auto monitoring - updated ${formatDate(lastLedgerRefreshAt)}`
                      : "Auto monitoring - every 60s"}
                </span>
              ) : latestPrice ? (
                <span className="muted">Last live price {formatMoney(latestPrice)}</span>
              ) : null}
              <button type="button" className="ghost-button tiny" onClick={() => refreshPaperLedger(false)} disabled={isRefreshingLedger || !ledgerSummary.monitoring}>
                {isRefreshingLedger ? "Refreshing..." : "Refresh outcomes"}
              </button>
              {import.meta.env.DEV && paperTrades.length ? (
                <button type="button" className="delete-button tiny" onClick={requestClearPaperLedger}>
                  Clear test trades
                </button>
              ) : null}
            </div>
          </div>
          <div className="ledger-summary">
            <div>
              <span>Monitoring</span>
              <strong>{ledgerSummary.monitoring}</strong>
            </div>
            <div>
              <span>TP hits</span>
              <strong>{ledgerSummary.wins}</strong>
            </div>
            <div>
              <span>SL hits</span>
              <strong>{ledgerSummary.losses}</strong>
            </div>
            <div>
              <span>Expired/Stale</span>
              <strong>{ledgerSummary.deadSignals}</strong>
            </div>
            <div>
              <span>Realized PnL</span>
              <strong>{formatUsdAmount(ledgerSummary.realizedPnl)}</strong>
            </div>
          </div>
          {pairedComparisons.length ? (
            <div className="outcome-comparisons">
              <div className="outcome-heading">
                <div>
                  <span>Head-to-head evidence</span>
                  <strong>Original vs safer outcomes</strong>
                </div>
                <p>Returns are normalized by each plan's initial risk.</p>
              </div>
              <div className="outcome-grid">
                {pairedComparisons.map(({ original, safer }) => {
                  const originalR = paperTradeReturnR(original);
                  const saferR = paperTradeReturnR(safer);
                  const edge = saferR - originalR;
                  const leader = edge > 0.01 ? "TradeLens leading" : edge < -0.01 ? "Original leading" : "Even so far";

                  return (
                    <article className="outcome-card" key={original.reportId}>
                      <div className="outcome-card-top">
                        <div>
                          <span>{original.pair}</span>
                          <strong>{leader}</strong>
                        </div>
                        <b className={pnlClass(edge)}>{edge >= 0 ? "+" : ""}{edge.toFixed(2)}R edge</b>
                      </div>
                      <div className="outcome-plans">
                        <div>
                          <span>Original</span>
                          <strong className={pnlClass(originalR)}>{originalR >= 0 ? "+" : ""}{originalR.toFixed(2)}R</strong>
                          <small>{formatTradeStatus(original.status)} - {formatUsdAmount(paperTradePnl(original))}</small>
                        </div>
                        <div>
                          <span>TradeLens</span>
                          <strong className={pnlClass(saferR)}>{saferR >= 0 ? "+" : ""}{saferR.toFixed(2)}R</strong>
                          <small>{formatTradeStatus(safer.status)} - {formatUsdAmount(paperTradePnl(safer))}</small>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
          {paperTrades.length ? (
            <>
              <div className="trade-card-grid">
                {paperTrades.map((trade) => {
                  const pnl = paperTradePnl(trade);
                  const grossPnl = paperTradeGrossPnl(trade);
                  const fees = paperTradeFees(trade);
                  const pnlLabel = trade.status === "active" ? "Open PnL" : trade.status === "take-profit" || trade.status === "stop-loss" ? "Final PnL" : "Paper PnL";

                  return (
                    <article className="trade-card" key={trade.id}>
                      <div className="trade-card-top">
                        <div>
                          <span className="trade-plan">{trade.plan} plan</span>
                          <strong>{trade.pair}</strong>
                        </div>
                        <span className={`status-pill status-${trade.status}`}>{formatTradeStatus(trade.status)}</span>
                      </div>

                      <div className="trade-price-row">
                        <div>
                          <span>Entry</span>
                          <strong>{formatMoney(trade.entry)}</strong>
                        </div>
                        <div>
                          <span>Live</span>
                          <strong>{formatMoney(trade.currentPrice)}</strong>
                        </div>
                        <div className={pnlClass(pnl)}>
                          <span>{pnlLabel}</span>
                          <strong>{formatUsdAmount(pnl)}</strong>
                        </div>
                      </div>

                      <div className="trade-lifecycle">
                        <div>
                          <span>Analysis</span>
                          <strong>{trade.timeframeLabel}</strong>
                        </div>
                        <div>
                          <span>Entry</span>
                          <strong>{trade.entryHitAt
                            ? `Hit ${formatDate(trade.entryHitAt)}`
                            : trade.expiresAt
                              ? formatTimeLeft(trade.expiresAt)
                              : "Waiting · GTC"}</strong>
                        </div>
                        <div>
                          <span>Targets</span>
                          <strong>{trade.targets.filter((target) => target.hitAt).length}/{trade.targets.length} hit</strong>
                        </div>
                        {trade.lifecycleNote ? <p>{trade.lifecycleNote}</p> : null}
                        <p>
                          {trade.orderType.toUpperCase()} entry · {trade.configuredRiskPct.toFixed(2)}% user-set risk · {trade.orderType === "market" ? "entered immediately" : trade.expiresAt ? `entry deadline ${formatDate(trade.expiresAt)}` : "good-till-cancelled entry"}.
                        </p>
                        <p>
                          Target allocation: {trade.targets.map((target, index) => `TP${index + 1} ${target.allocationPct}%`).join(" · ")}.
                        </p>
                        {trade.targets.length > 1 ? (
                          <p>
                            After TP1: {trade.postTp1Action === "move-stop-to-entry" ? "move the remaining stop to entry" : "keep the original stop"}
                            {trade.stopMovedAt ? ` (moved ${formatDate(trade.stopMovedAt)})` : ""}.
                          </p>
                        ) : null}
                      </div>

                      {trade.entryHitAt ? (
                        <div className="trade-costs">
                          <div>
                            <span>Gross move</span>
                            <strong className={pnlClass(grossPnl)}>{formatUsdAmount(grossPnl)}</strong>
                          </div>
                          <div>
                            <span>Estimated fees</span>
                            <strong>{formatCostEffect(fees)}</strong>
                          </div>
                          <div>
                            <span>Funding estimate</span>
                            <strong className={pnlClass(-trade.fundingCost)}>{formatCostEffect(trade.fundingCost)}</strong>
                          </div>
                          <div>
                            <span>Net PnL</span>
                            <strong className={pnlClass(pnl)}>{formatUsdAmount(pnl)}</strong>
                          </div>
                          <p>
                            Uses the user-confirmed {trade.feeRatePct.toFixed(2)}% fee estimate per fill, Bitget's live funding rate, and {(trade.spreadBpsAtEntry ?? 0).toFixed(2)} bps observed spread. Exact account fees may differ.
                          </p>
                        </div>
                      ) : null}

                      {trade.outcomeReview ? (
                        <div className="trade-outcome-review">
                          <span>AI outcome review</span>
                          <strong>{trade.outcomeReview.headline}</strong>
                          <p>{trade.outcomeReview.summary}</p>
                          <div>
                            <section>
                              <span>Lesson</span>
                              <p>{trade.outcomeReview.lesson}</p>
                            </section>
                            <section>
                              <span>Next action</span>
                              <p>{trade.outcomeReview.nextAction}</p>
                            </section>
                          </div>
                        </div>
                      ) : null}

                      <div className="trade-rails">
                        <div>
                          <span>Stop</span>
                          <strong>{formatMoney(trade.stopLoss)}</strong>
                        </div>
                        <div>
                          <span>{trade.targets.length > 1 ? "Next target" : "Target"}</span>
                          <strong>{formatMoney(trade.takeProfit)}</strong>
                        </div>
                        <div>
                          <span>Size</span>
                          <strong>{formatQuantity(trade.remainingQuantity)} open</strong>
                        </div>
                        <div>
                          <span>Leverage</span>
                          <strong>{trade.leverage}x</strong>
                        </div>
                      </div>

                      <div className="trade-card-footer">
                        <span>{trade.side.toUpperCase()}</span>
                        <div className="trade-card-meta">
                          <span>Updated {formatDate(trade.updatedAt)}</span>
                          {import.meta.env.DEV ? (
                            <button type="button" className="delete-button tiny" onClick={() => requestDeletePaperTrade(trade.id)}>
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="button-row export-row">
                <button type="button" className="ghost-button" onClick={() => exportPaperLedger("json")}>
                  Export JSON
                </button>
                <button type="button" className="ghost-button" onClick={() => exportPaperLedger("csv")}>
                  Export CSV
                </button>
              </div>
              {ledgerError ? <p className="error-text">{ledgerError}</p> : null}
            </>
          ) : (
            <p className="empty-state">Track a plan to watch how it would perform without placing a real trade.</p>
          )}
        </section>
      </section>

      <section className={`evidence-view ${isEvidenceReport ? "" : "route-hidden"}`}>
        <section className="view-heading">
          <div>
            <p className="eyebrow">Evidence Report</p>
            <h2>Measure decisions, not promises</h2>
          </div>
          <p>Only completed paper outcomes count. Open trades cannot improve or damage the performance statistics.</p>
        </section>

        <section className={`surface evidence-quality evidence-quality-${evidenceReport.sampleQuality}`}>
          <div>
            <p className="eyebrow">Sample quality</p>
            <h2>{evidenceQualityLabel(evidenceReport.sampleQuality)}</h2>
            <p>{evidenceReport.sampleMessage}</p>
          </div>
          <div className="evidence-counts">
            <div><span>Tracked</span><strong>{evidenceReport.trackedTrades}</strong></div>
            <div><span>Completed outcomes</span><strong>{evidenceReport.completedOutcomes}</strong></div>
            <div><span>Completed pairs</span><strong>{evidenceReport.completedPairs}</strong></div>
            <div><span>Still monitoring</span><strong>{evidenceReport.monitoringTrades}</strong></div>
          </div>
          <button type="button" className="ghost-button" onClick={exportEvidenceReport} disabled={!paperTrades.length}>
            Export evidence JSON
          </button>
        </section>

        <section className="surface evidence-proof-trail">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Proof trail</p>
              <h2>What TradeLens can already prove</h2>
            </div>
            <span className="evidence-outcome-count">{pendingEvidenceTrades.length} open record{pendingEvidenceTrades.length === 1 ? "" : "s"}</span>
          </div>
          <div className="proof-point-grid">
            <div>
              <span>1</span>
              <strong>Signal captured</strong>
              <p>Pair, direction, entry, stop, targets, leverage, and timeframe are stored from the pasted signal.</p>
            </div>
            <div>
              <span>2</span>
              <strong>Market checked</strong>
              <p>Prices, candles, spread, funding, open interest, and depth come from Bitget futures data.</p>
            </div>
            <div>
              <span>3</span>
              <strong>Outcome pending</strong>
              <p>Open trades are watched until price reaches take-profit or stop-loss. Only then do stats count.</p>
            </div>
          </div>
          {pendingEvidenceTrades.length ? (
            <div className="evidence-table proof-trail-table">
              <div className="evidence-table-head">
                <span>Updated</span><span>Market</span><span>Plan</span><span>Status</span><span>Live price</span><span>Paper PnL</span>
              </div>
              {pendingEvidenceTrades.map((trade) => (
                <div className="evidence-table-row" key={trade.id}>
                  <span data-label="Updated">{formatDate(trade.updatedAt)}</span>
                  <strong data-label="Market">{trade.pair}</strong>
                  <span data-label="Plan">{formatPlanName(trade.plan)}</span>
                  <span data-label="Status">{formatTradeStatus(trade.status)}</span>
                  <strong data-label="Live price">{formatMoney(trade.currentPrice)}</strong>
                  <strong data-label="Paper PnL" className={pnlClass(paperTradePnl(trade))}>{formatUsdAmount(paperTradePnl(trade))}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">
              {paperTrades.length
                ? "All tracked records have closed, so the completed table below is now the main audit trail."
                : "Start paper tracking from a checked signal and this section will show the live records being watched."}
            </p>
          )}
        </section>

        <div className="evidence-plan-grid">
          {[evidenceReport.original, evidenceReport.safer].map((plan) => (
            <section className="surface evidence-plan" key={plan.plan}>
              <div className="panel-heading compact">
                <div>
                  <p className="eyebrow">{plan.plan === "original" ? "As received" : "Risk-adjusted"}</p>
                  <h2>{plan.plan === "original" ? "Original signals" : "TradeLens plans"}</h2>
                </div>
                <span className="evidence-outcome-count">{plan.completed} completed</span>
              </div>
              <div className="evidence-metrics">
                <div>
                  <span>Net PnL</span>
                  <strong className={pnlClass(plan.netPnl)}>{formatUsdAmount(plan.netPnl)}</strong>
                </div>
                <div>
                  <span>Win rate</span>
                  <strong>{plan.winRatePct === undefined ? "Not enough data" : `${plan.winRatePct.toFixed(1)}%`}</strong>
                </div>
                <div>
                  <span>Profit factor</span>
                  <strong>{formatProfitFactor(plan.profitFactor)}</strong>
                </div>
                <div>
                  <span>Average result</span>
                  <strong>{formatR(plan.averageReturnR)}</strong>
                </div>
                <div>
                  <span>Max drawdown</span>
                  <strong>{formatUsdAmount(plan.maxDrawdown)}</strong>
                </div>
                <div>
                  <span>Estimated costs</span>
                  <strong>{formatCostEffect(plan.netCosts)}</strong>
                </div>
              </div>
              <p className="evidence-footnote">
                {plan.completed
                  ? `${plan.profitable} profitable and ${plan.losing} losing net outcome${plan.completed === 1 ? "" : "s"}.`
                  : "No completed TP or SL outcomes for this plan yet."}
              </p>
            </section>
          ))}
        </div>

        <section className="surface paired-evidence">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Head-to-head</p>
              <h2>Did the risk adjustment improve the result?</h2>
            </div>
            <span className="evidence-outcome-count">{evidenceReport.completedPairs} comparable pairs</span>
          </div>
          <div className="paired-evidence-metrics">
            <div><span>TradeLens led</span><strong>{evidenceReport.paired.saferLed}</strong></div>
            <div><span>Original led</span><strong>{evidenceReport.paired.originalLed}</strong></div>
            <div><span>Tied</span><strong>{evidenceReport.paired.tied}</strong></div>
            <div>
              <span>Average TradeLens edge</span>
              <strong className={pnlClass(evidenceReport.paired.averageSaferEdgeR ?? 0)}>
                {evidenceReport.paired.averageSaferEdgeR === undefined
                  ? "Pending"
                  : `${evidenceReport.paired.averageSaferEdgeR >= 0 ? "+" : ""}${evidenceReport.paired.averageSaferEdgeR.toFixed(2)}R`}
              </strong>
            </div>
          </div>
          <p className="evidence-footnote">A pair becomes comparable only after both the original and TradeLens plan have closed.</p>
        </section>

        <section className="surface evidence-outcomes">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Completed outcomes</p>
              <h2>Auditable paper-trade record</h2>
            </div>
          </div>
          {completedEvidenceTrades.length ? (
            <div className="evidence-table completed-evidence-table">
              <div className="evidence-table-head">
                <span>Closed</span><span>Market</span><span>Plan</span><span>Outcome</span><span>Entry to exit</span><span>Size</span><span>Net PnL</span><span>Return</span>
              </div>
              {completedEvidenceTrades.map((trade) => (
                <div className="evidence-table-row" key={trade.id}>
                  <span data-label="Closed">{formatDate(trade.exitAt ?? trade.updatedAt)}</span>
                  <strong data-label="Market">{trade.pair}</strong>
                  <span data-label="Plan">{formatPlanName(trade.plan)}</span>
                  <span data-label="Outcome">{formatTradeStatus(trade.status)}</span>
                  <span data-label="Entry to exit">{formatMoney(trade.fillEntry)} to {formatMoney(trade.exitPrice ?? trade.currentPrice)}</span>
                  <strong data-label="Size">{formatQuantity(trade.quantity)}</strong>
                  <strong data-label="Net PnL" className={pnlClass(paperTradePnl(trade))}>{formatUsdAmount(paperTradePnl(trade))}</strong>
                  <strong data-label="Return" className={pnlClass(tradeReturnR(trade))}>{tradeReturnR(trade).toFixed(2)}R</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">The report will populate after a tracked plan reaches its target or stop.</p>
          )}
        </section>

        <section className="surface evidence-methodology">
          <div>
            <p className="eyebrow">How to read this</p>
            <h2>Evidence methodology</h2>
          </div>
          <dl>
            <div><dt>Win rate</dt><dd>The percentage of completed trades whose net result was above zero after estimated costs.</dd></div>
            <div><dt>Maximum drawdown</dt><dd>The largest fall from a previous paper-profit peak. Smaller means the strategy lost less during its worst decline.</dd></div>
            <div><dt>Profit factor</dt><dd>Total net profits divided by total net losses. Above 1 means profits outweighed losses in the sample.</dd></div>
            <div><dt>R</dt><dd>Result measured against the trade's planned initial risk. +1R earns one risk unit; -1R loses one risk unit.</dd></div>
          </dl>
          <p>Simulated results use Bitget market data, observed spread, estimated taker fees, and live-rate funding estimates. They do not predict future returns.</p>
        </section>
      </section>

      <section className={`surface ${isSignalDesk ? "" : "route-hidden"}`}>
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Analysis history</p>
            <h2>Recent live checks</h2>
          </div>
        </div>
        {history.length ? (
          <div className="history-grid">
            {history.map((item) => (
              <article key={item.id}>
                <strong>{item.signal.pair}</strong>
                <span>{item.signal.side} at {formatMoney(item.signal.entry)}</span>
                <b>{item.verdict} - {item.score}</b>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">Recent checks will show here after you analyze a trade.</p>
        )}
      </section>
        </div>
      </div>
    </main>
  );
}
