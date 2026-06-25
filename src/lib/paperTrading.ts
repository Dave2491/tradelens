import type { Candle, MarketSnapshot, PaperTarget, PaperTrade, PostTp1Action, RiskReport } from "./types";

const DECIMALS = 2;
export const PAPER_TAKER_FEE_RATE_PCT = 0.06;
const FUNDING_INTERVAL_HOURS = 8;

export type PaperTradeConfig = {
  paperBalance: number;
  riskPct: number;
  leverage: number;
  orderType: PaperTrade["orderType"];
  targetAllocations: number[];
  entryExpiryMinutes?: number;
  feeRatePct: number;
  postTp1Action: PostTp1Action;
};

function round(value: number, decimals = DECIMALS) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function directionMultiplier(side: "long" | "short") {
  return side === "long" ? 1 : -1;
}

function adverseFill(price: number, side: PaperTrade["side"], isEntry: boolean, spreadBps = 0) {
  const halfSpread = spreadBps / 20_000;
  const direction = directionMultiplier(side) * (isEntry ? 1 : -1);
  return price * (1 + direction * halfSpread);
}

export function calculateTradingFee(price: number, quantity: number, feeRatePct = PAPER_TAKER_FEE_RATE_PCT) {
  return round(Math.abs(price * quantity) * (feeRatePct / 100));
}

function estimateExitFee(trade: PaperTrade, price: number, spreadBps: number) {
  if (!trade.remainingQuantity) return 0;
  const exitFill = adverseFill(price, trade.side, false, spreadBps);
  return calculateTradingFee(exitFill, trade.remainingQuantity, trade.feeRatePct);
}

function accrueFunding(trade: PaperTrade, market: MarketSnapshot, until: string) {
  if (trade.status !== "active" || !trade.entryHitAt || market.derivatives.fundingRatePct === undefined) return trade;

  const fromMs = new Date(trade.fundingUpdatedAt ?? trade.entryHitAt).getTime();
  const untilMs = new Date(until).getTime();
  const elapsedHours = Math.max(0, untilMs - fromMs) / 3_600_000;
  if (!elapsedHours || !trade.remainingQuantity) return { ...trade, fundingUpdatedAt: until };

  const markPrice = market.derivatives.markPrice ?? market.price;
  const notional = Math.abs(markPrice * trade.remainingQuantity);
  const sideDirection = trade.side === "long" ? 1 : -1;
  const fundingDelta = notional
    * (market.derivatives.fundingRatePct / 100)
    * (elapsedHours / FUNDING_INTERVAL_HOURS)
    * sideDirection;

  return {
    ...trade,
    fundingCost: round(trade.fundingCost + fundingDelta, 8),
    fundingUpdatedAt: until,
  };
}

function withNetPnl(trade: PaperTrade, livePrice: number, spreadBps: number) {
  const grossUnrealizedPnl = trade.status === "active"
    ? calculatePnl(trade, livePrice, trade.remainingQuantity, spreadBps)
    : 0;
  const projectedExitFee = trade.status === "active" ? estimateExitFee(trade, livePrice, spreadBps) : 0;
  const realizedPnl = round(trade.grossRealizedPnl - trade.entryFee - trade.exitFees - trade.fundingCost);
  const unrealizedPnl = round(grossUnrealizedPnl - projectedExitFee);

  return {
    ...trade,
    grossUnrealizedPnl,
    unrealizedPnl,
    realizedPnl,
    estimatedExitFee: projectedExitFee,
    balanceAfter: round(trade.balanceBefore + realizedPnl),
  };
}

export function calculatePnl(
  trade: Pick<PaperTrade, "side" | "entry" | "fillEntry" | "quantity">,
  price: number,
  quantity = trade.quantity,
  spreadBps = 0,
) {
  const entry = trade.fillEntry || trade.entry;
  const exit = adverseFill(price, trade.side, false, spreadBps);
  return round((exit - entry) * quantity * directionMultiplier(trade.side));
}

function calculatePnlFromFill(
  trade: Pick<PaperTrade, "side" | "entry" | "fillEntry">,
  exitFill: number,
  quantity: number,
) {
  const entry = trade.fillEntry || trade.entry;
  return round((exitFill - entry) * quantity * directionMultiplier(trade.side));
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangeTouches(candle: Pick<Candle, "low" | "high">, price: number) {
  return candle.low <= price && candle.high >= price;
}

function rangeTouchesEntry(
  trade: Pick<PaperTrade, "entry" | "side" | "orderType">,
  candle: Pick<Candle, "low" | "high">,
) {
  if (trade.orderType === "market") return true;
  if (trade.orderType === "limit") return trade.side === "long" ? candle.low <= trade.entry : candle.high >= trade.entry;
  return trade.side === "long" ? candle.high >= trade.entry : candle.low <= trade.entry;
}

function isEntryLive(trade: Pick<PaperTrade, "entry" | "side" | "orderType">, price: number) {
  if (trade.orderType === "market") return true;
  if (trade.orderType === "limit") return trade.side === "long" ? price <= trade.entry : price >= trade.entry;
  return trade.side === "long" ? price >= trade.entry : price <= trade.entry;
}

function isTerminal(status: PaperTrade["status"]) {
  return status === "take-profit" || status === "stop-loss" || status === "expired" || status === "stale";
}

function allocateTargets(prices: number[], allocations: number[]): PaperTarget[] {
  const unique = [...new Set(prices.filter((price) => Number.isFinite(price) && price > 0))];
  if (!unique.length) return [];
  if (allocations.length !== unique.length) throw new Error("Every target needs an explicit allocation.");
  const totalAllocation = round(allocations.reduce((sum, value) => sum + value, 0));
  if (Math.abs(totalAllocation - 100) > 0.01) throw new Error("Target allocations must total 100%.");

  return unique.map((price, index) => ({ price, allocationPct: allocations[index] }));
}

function applyActiveRange(
  trade: PaperTrade,
  candle: Pick<Candle, "low" | "high" | "time">,
  spreadBps: number,
): PaperTrade {
  const stopTouched = rangeTouches(candle, trade.stopLoss);
  const targetsTouched = trade.targets.filter((target) => !target.hitAt && rangeTouches(candle, target.price));
  const eventAt = new Date(candle.time).toISOString();

  if (stopTouched) {
    const remainingPnl = calculatePnl(trade, trade.stopLoss, trade.remainingQuantity, spreadBps);
    const stopFill = adverseFill(trade.stopLoss, trade.side, false, spreadBps);
    const stopFee = calculateTradingFee(stopFill, trade.remainingQuantity, trade.feeRatePct);
    const ambiguous = targetsTouched.length > 0;
    const next = {
      ...trade,
      currentPrice: trade.stopLoss,
      exitPrice: trade.stopLoss,
      exitAt: eventAt,
      remainingQuantity: 0,
      unrealizedPnl: 0,
      grossUnrealizedPnl: 0,
      grossRealizedPnl: round(trade.grossRealizedPnl + remainingPnl),
      exitFees: round(trade.exitFees + stopFee),
      estimatedExitFee: 0,
      status: "stop-loss" as const,
      lifecycleNote: ambiguous
        ? "Stop and target appeared inside the same completed candle. TradeLens recorded the stop first as the conservative outcome."
        : "A completed Bitget candle crossed the stop-loss.",
    };
    return withNetPnl(next, trade.stopLoss, spreadBps);
  }

  if (!targetsTouched.length) return trade;

  let realizedPnl = trade.grossRealizedPnl;
  let remainingQuantity = trade.remainingQuantity;
  const targets = trade.targets.map((target) => {
    if (target.hitAt || !targetsTouched.includes(target)) return target;
    const allocatedQuantity = Math.min(trade.quantity * (target.allocationPct / 100), remainingQuantity);
    const targetFill = target.price;
    const targetPnl = calculatePnlFromFill(trade, targetFill, allocatedQuantity);
    const exitFee = calculateTradingFee(targetFill, allocatedQuantity, trade.feeRatePct);
    realizedPnl += targetPnl;
    remainingQuantity = Math.max(0, remainingQuantity - allocatedQuantity);
    return { ...target, hitAt: eventAt, realizedPnl: targetPnl, exitFee };
  });
  const allTargetsHit = targets.every((target) => Boolean(target.hitAt));
  const firstTargetHitNow = !trade.targets[0]?.hitAt && Boolean(targets[0]?.hitAt);
  const shouldMoveStop = firstTargetHitNow
    && !allTargetsHit
    && trade.postTp1Action === "move-stop-to-entry";
  const roundedRealized = round(realizedPnl);

  const next: PaperTrade = {
    ...trade,
    targets,
    stopLoss: shouldMoveStop ? trade.fillEntry : trade.stopLoss,
    stopMovedAt: shouldMoveStop ? eventAt : trade.stopMovedAt,
    takeProfit: targets.find((target) => !target.hitAt)?.price ?? targets[targets.length - 1].price,
    currentPrice: targetsTouched[targetsTouched.length - 1].price,
    exitPrice: allTargetsHit ? targets[targets.length - 1].price : undefined,
    exitAt: allTargetsHit ? eventAt : undefined,
    remainingQuantity,
    unrealizedPnl: 0,
    grossUnrealizedPnl: 0,
    grossRealizedPnl: roundedRealized,
    exitFees: round(targets.reduce((sum, target) => sum + (target.exitFee ?? 0), 0)),
    estimatedExitFee: 0,
    status: allTargetsHit ? "take-profit" : "active",
    lifecycleNote: allTargetsHit
      ? "Every paper target was crossed by completed Bitget candle data."
      : shouldMoveStop
        ? "TP1 was reached, so the remaining stop moved to the entry fill as the user configured. Fees can still make that exit a small net loss."
      : `${targets.filter((target) => target.hitAt).length} of ${targets.length} targets hit; the remaining paper position stays open.`,
  };
  return withNetPnl(next, next.currentPrice, spreadBps);
}

export function createPaperTrade(report: RiskReport, plan: "original" | "safer", config: PaperTradeConfig): PaperTrade {
  if (plan === "original" && (!report.signal.stopLoss || !report.signal.takeProfits.length)) {
    throw new Error("The original signal needs its own stop and target before it can be paper-tracked.");
  }
  const source =
    plan === "original"
      ? {
          entry: report.signal.entry,
          stopLoss: report.signal.stopLoss!,
          takeProfits: report.signal.takeProfits,
        }
      : {
          entry: report.saferPlan.entry,
          stopLoss: report.saferPlan.stopLoss,
          takeProfits: [report.saferPlan.takeProfit],
        };
  const targets = allocateTargets(source.takeProfits, config.targetAllocations);
  const spreadBpsAtEntry = report.market.derivatives.spreadBps ?? 0;
  const fillEntry = config.orderType === "limit"
    ? source.entry
    : adverseFill(source.entry, report.signal.side, true, spreadBpsAtEntry);
  const riskBudget = config.paperBalance * (config.riskPct / 100);
  const stopDistance = Math.max(Math.abs(fillEntry - source.stopLoss), source.entry * 0.002);
  const quantity = riskBudget > 0 ? riskBudget / stopDistance : 0;
  const now = new Date().toISOString();
  const expiresAt = config.entryExpiryMinutes
    ? addMinutes(new Date(now), config.entryExpiryMinutes).toISOString()
    : undefined;
  const currentPrice = report.market.price;
  const draftTrade = { entry: source.entry, side: report.signal.side, orderType: config.orderType };
  const isActive = isEntryLive(draftTrade, currentPrice);
  const initialStatus = isActive ? "active" : "waiting-entry";
  const roundedQuantity = Number(quantity.toFixed(6));
  const feeRatePct = config.feeRatePct;
  const entryFee = isActive ? calculateTradingFee(fillEntry, roundedQuantity, feeRatePct) : 0;

  const trade: PaperTrade = {
    costModelVersion: 1,
    executionModelVersion: 3,
    id: crypto.randomUUID(),
    reportId: report.id,
    createdAt: now,
    updatedAt: now,
    plan,
    pair: report.signal.pair,
    side: report.signal.side,
    entry: source.entry,
    fillEntry,
    initialStopLoss: source.stopLoss,
    stopLoss: source.stopLoss,
    takeProfit: targets[0]?.price ?? report.saferPlan.takeProfit,
    targets,
    leverage: config.leverage,
    orderType: config.orderType,
    configuredRiskPct: config.riskPct,
    quantity: roundedQuantity,
    remainingQuantity: roundedQuantity,
    currentPrice,
    unrealizedPnl: 0,
    realizedPnl: 0,
    grossUnrealizedPnl: 0,
    grossRealizedPnl: 0,
    feeRatePct,
    entryFee,
    exitFees: 0,
    estimatedExitFee: 0,
    fundingCost: 0,
    fundingUpdatedAt: isActive ? now : undefined,
    balanceBefore: round(config.paperBalance),
    balanceAfter: round(config.paperBalance),
    status: initialStatus,
    timeframeLabel: report.market.timeframe,
    timeframe: report.market.timeframe,
    expiresAt,
    entryHitAt: isActive ? now : undefined,
    lastEvaluatedCandleTime: report.market.candles.at(-1)?.time,
    spreadBpsAtEntry,
    postTp1Action: config.postTp1Action,
    provenance: {
      balance: "user",
      risk: "user",
      orderType: "user",
      targetAllocation: "user",
      expiry: config.entryExpiryMinutes ? "user" : "none",
      management: "user",
      fees: "user-confirmed-estimate",
      funding: "bitget-live-estimate",
    },
    lifecycleNote: isActive
      ? "Entry zone is live. Net paper PnL includes spread, estimated taker fees, and funding accrued from Bitget's live rate."
      : "Waiting for price to reach the entry zone before paper PnL starts.",
  };
  return withNetPnl(trade, currentPrice, spreadBpsAtEntry);
}

export function updatePaperTradeWithMarket(trade: PaperTrade, market: MarketSnapshot): PaperTrade {
  const now = new Date().toISOString();
  if (isTerminal(trade.status)) return { ...trade, currentPrice: market.price, updatedAt: now };

  const spreadBps = market.derivatives.spreadBps ?? trade.spreadBpsAtEntry ?? 0;
  const expiryMs = trade.expiresAt ? new Date(trade.expiresAt).getTime() : undefined;
  const unseenCandles = market.candles.filter((candle) => candle.time > (trade.lastEvaluatedCandleTime ?? 0));
  let next: PaperTrade = accrueFunding({ ...trade }, market, now);

  for (const candle of unseenCandles) {
    if (isTerminal(next.status)) break;

    if (next.status === "waiting-entry") {
      if (expiryMs && candle.time > expiryMs) {
        next = {
          ...next,
          status: "expired",
          unrealizedPnl: 0,
          lifecycleNote: "The user-configured entry deadline passed before the order filled.",
        };
        break;
      }
      if (!rangeTouchesEntry(next, candle)) {
        if (rangeTouches(candle, next.stopLoss) || next.targets.some((target) => rangeTouches(candle, target.price))) {
          next = {
            ...next,
            status: "stale",
            unrealizedPnl: 0,
            lifecycleNote: "A completed candle crossed an exit level before the entry zone, so the opportunity is recorded as stale.",
          };
        }
        continue;
      }

      const entryHitAt = new Date(candle.time).toISOString();
      next = {
        ...next,
        status: "active",
        entryHitAt,
        fundingUpdatedAt: entryHitAt,
        entryFee: calculateTradingFee(next.fillEntry, next.quantity, next.feeRatePct),
      };
    }

    next = applyActiveRange(next, candle, spreadBps);
  }

  const lastEvaluatedCandleTime = market.candles.at(-1)?.time ?? next.lastEvaluatedCandleTime;
  if (!isTerminal(next.status) && next.status === "waiting-entry" && expiryMs && Date.now() > expiryMs) {
    next = {
      ...next,
      status: "expired",
      unrealizedPnl: 0,
      lifecycleNote: "The user-configured entry deadline passed before the order filled.",
    };
  }

  if (!isTerminal(next.status) && next.status === "waiting-entry" && isEntryLive(next, market.price)) {
    next = {
      ...next,
      status: "active",
      entryHitAt: now,
      fundingUpdatedAt: now,
      entryFee: calculateTradingFee(next.fillEntry, next.quantity, next.feeRatePct),
      lifecycleNote: "Live price entered the paper entry zone.",
    };
  }

  if (!isTerminal(next.status) && next.status === "active") {
    const livePoint: Candle = {
      time: Date.now(),
      open: market.price,
      high: market.price,
      low: market.price,
      close: market.price,
      volume: 0,
    };
    next = applyActiveRange(next, livePoint, spreadBps);
    if (next.status === "active") {
      next = withNetPnl({
        ...next,
        currentPrice: market.price,
        lifecycleNote: next.lifecycleNote?.includes("targets hit") || next.lifecycleNote?.includes("remaining stop moved")
          ? next.lifecycleNote
          : "Open paper trade remains between its stop and next target.",
      }, market.price, spreadBps);
    }
  }

  return {
    ...next,
    currentPrice: isTerminal(next.status) ? next.currentPrice : market.price,
    lastEvaluatedCandleTime,
    updatedAt: now,
  };
}
