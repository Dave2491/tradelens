export type TradeSide = "long" | "short";

export type Verdict = "Accept" | "Modify" | "Avoid";

export type AnalysisTimeframe = "5m" | "15m" | "30m" | "1H" | "4H" | "1D";

export type TimeframeSource = "signal" | "selected" | "inferred" | "default";

export type SignalInput = {
  pair: string;
  side: TradeSide;
  entry: number;
  stopLoss?: number;
  takeProfits: number[];
  leverage?: number;
  entryMode: "current" | "exact";
  timeframe: AnalysisTimeframe;
  timeframeSource: TimeframeSource;
  raw: string;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type DerivativesSnapshot = {
  fundingRatePct?: number;
  openInterestUsd?: number;
  spreadBps?: number;
  bidDepthUsd?: number;
  askDepthUsd?: number;
  bookImbalancePct?: number;
  markPrice?: number;
  indexPrice?: number;
  basisPct?: number;
};

export type MarketSnapshot = {
  pair: string;
  price: number;
  change24h?: number;
  high24h?: number;
  low24h?: number;
  candles: Candle[];
  timeframe: AnalysisTimeframe;
  timeframeSource: TimeframeSource;
  derivatives: DerivativesSnapshot;
  dataQuality: {
    marketTimestamp: string;
    latestClosedCandleAt: string;
    ageSeconds: number;
    closedCandles: number;
  };
  source: "bitget";
  fetchedAt: string;
};

export type MarketSymbol = {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
};

export type RiskFinding = {
  level: "good" | "warn" | "danger";
  label: string;
  detail: string;
};

export type MarketPulse = {
  trend: "bullish" | "bearish" | "mixed";
  rsi: number;
  emaFast: number;
  emaSlow: number;
  atrPct: number;
  bias: string;
};

export type BtcMarketContext = {
  pair: "BTCUSDT";
  timeframe: AnalysisTimeframe;
  price: number;
  pulse: MarketPulse;
  alignment: "supports" | "conflicts" | "neutral" | "same-market";
  summary: string;
  fetchedAt: string;
};

export type EntryGuidance = {
  action: "enter-now" | "wait-limit" | "wait-breakout" | "do-not-enter";
  title: string;
  detail: string;
  suggestedOrderType?: "market" | "limit" | "stop";
  distanceInAtr: number;
};

export type RiskReport = {
  id: string;
  createdAt: string;
  signal: SignalInput;
  market: MarketSnapshot;
  verdict: Verdict;
  score: number;
  engineVerdict?: Verdict;
  engineScore?: number;
  aiVerdict?: Verdict;
  aiConfidence?: number;
  riskReward?: number;
  stopDistancePct?: number;
  entryDistancePct: number;
  volatilityPct: number;
  recentMovePct: number;
  marketPulse: MarketPulse;
  btcContext?: BtcMarketContext;
  entryGuidance: EntryGuidance;
  findings: RiskFinding[];
  saferPlan: {
    leverage: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskPct: number;
    rationale: string;
  };
};

export type OutcomeReview = {
  generatedAt: string;
  headline: string;
  summary: string;
  lesson: string;
  nextAction: string;
};

export type PaperTarget = {
  price: number;
  allocationPct: number;
  hitAt?: string;
  realizedPnl?: number;
  exitFee?: number;
};

export type PostTp1Action = "hold-stop" | "move-stop-to-entry";

export type PaperTrade = {
  costModelVersion: number;
  executionModelVersion: number;
  id: string;
  reportId: string;
  createdAt: string;
  updatedAt: string;
  plan: "original" | "safer";
  pair: string;
  side: TradeSide;
  entry: number;
  fillEntry: number;
  initialStopLoss: number;
  stopLoss: number;
  takeProfit: number;
  targets: PaperTarget[];
  leverage: number;
  orderType: "market" | "limit" | "stop";
  configuredRiskPct: number;
  quantity: number;
  remainingQuantity: number;
  currentPrice: number;
  exitPrice?: number;
  exitAt?: string;
  unrealizedPnl: number;
  realizedPnl: number;
  grossUnrealizedPnl: number;
  grossRealizedPnl: number;
  feeRatePct: number;
  entryFee: number;
  exitFees: number;
  estimatedExitFee: number;
  fundingCost: number;
  fundingUpdatedAt?: string;
  balanceBefore: number;
  balanceAfter: number;
  status: "waiting-entry" | "active" | "take-profit" | "stop-loss" | "expired" | "stale";
  timeframeLabel: string;
  timeframe: AnalysisTimeframe;
  expiresAt?: string;
  entryHitAt?: string;
  lastEvaluatedCandleTime?: number;
  spreadBpsAtEntry?: number;
  postTp1Action: PostTp1Action;
  stopMovedAt?: string;
  provenance: {
    balance: "user" | "legacy-default";
    risk: "user" | "legacy-default";
    orderType: "user" | "legacy-inferred";
    targetAllocation: "user" | "legacy-equal";
    expiry: "user" | "none" | "legacy-removed";
    management: "user" | "legacy-hold";
    fees: "user-confirmed-estimate" | "legacy-estimate";
    funding: "bitget-live-estimate";
  };
  lifecycleNote?: string;
  outcomeReview?: OutcomeReview;
};
