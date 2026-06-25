import { ema, wilderAtrPercent, wilderRsi } from "./indicators.ts";
import { roundUsdPrice } from "./formatters.ts";
import type { BtcMarketContext, Candle, EntryGuidance, MarketPulse, MarketSnapshot, RiskFinding, RiskReport, SignalInput, TradeSide, Verdict } from "./types";

function pctDistance(from: number, to: number) {
  return ((to - from) / from) * 100;
}

function absPctDistance(from: number, to: number) {
  return Math.abs(pctDistance(from, to));
}

function recentMove(candles: Candle[]) {
  const recent = candles.slice(-6);
  if (recent.length < 2) return 0;
  return pctDistance(recent[0].open, recent[recent.length - 1].close);
}

function marketPulse(market: MarketSnapshot): MarketPulse {
  const closes = market.candles.map((candle) => candle.close).filter(Boolean);
  const emaFast = ema(closes, 20) ?? market.price;
  const emaSlow = ema(closes, 50) ?? market.price;
  const currentRsi = wilderRsi(closes) ?? 50;
  const currentAtrPct = wilderAtrPercent(market.candles, market.price) ?? 0;
  const trend =
    market.price > emaFast && emaFast > emaSlow
      ? "bullish"
      : market.price < emaFast && emaFast < emaSlow
        ? "bearish"
        : "mixed";

  return {
    trend,
    rsi: Number(currentRsi.toFixed(1)),
    emaFast: Number(emaFast.toFixed(2)),
    emaSlow: Number(emaSlow.toFixed(2)),
    atrPct: Number(currentAtrPct.toFixed(2)),
    bias:
      trend === "bullish"
        ? "Price is trading above the fast and slow trend averages."
        : trend === "bearish"
          ? "Price is trading below the fast and slow trend averages."
          : "Trend averages are tangled, so direction is not clean yet.",
  };
}

function createBtcContext(signal: SignalInput, btcMarket?: MarketSnapshot): BtcMarketContext | undefined {
  if (!btcMarket) return undefined;

  const pulse = marketPulse(btcMarket);
  const sameMarket = signal.pair === "BTCUSDT";
  const supports =
    (signal.side === "long" && pulse.trend === "bullish")
    || (signal.side === "short" && pulse.trend === "bearish");
  const conflicts =
    (signal.side === "long" && pulse.trend === "bearish")
    || (signal.side === "short" && pulse.trend === "bullish");
  const alignment = sameMarket ? "same-market" : supports ? "supports" : conflicts ? "conflicts" : "neutral";
  const summary = sameMarket
    ? `This signal is Bitcoin itself, so its ${pulse.trend} pulse is already included in the main analysis.`
    : alignment === "supports"
      ? `Bitcoin's ${pulse.trend} ${btcMarket.timeframe} pulse moves in the same direction as this ${signal.side} idea.`
      : alignment === "conflicts"
        ? `Bitcoin's ${pulse.trend} ${btcMarket.timeframe} pulse moves against this ${signal.side} idea, which can make an altcoin setup less stable.`
        : `Bitcoin's ${btcMarket.timeframe} pulse is mixed, so it provides no clear support for either direction.`;

  return {
    pair: "BTCUSDT",
    timeframe: btcMarket.timeframe,
    price: btcMarket.price,
    pulse,
    alignment,
    summary,
    fetchedAt: btcMarket.fetchedAt,
  };
}

export function createEntryGuidance(signal: SignalInput, market: MarketSnapshot, verdict: Verdict): EntryGuidance {
  const atrPct = Math.max(marketPulse(market).atrPct, 0.01);
  const entryDistancePct = absPctDistance(market.price, signal.entry);
  const distanceInAtr = Number((entryDistancePct / atrPct).toFixed(2));

  if (verdict === "Avoid") {
    return {
      action: "do-not-enter",
      title: "Do not enter this version",
      detail: "The final risk verdict is Avoid. Rebuild the setup before choosing any market, limit, or breakout entry.",
      distanceInAtr,
    };
  }

  if (signal.entryMode === "current") {
    return {
      action: "enter-now",
      title: "Current-price entry requested",
      detail: "The signal asks to enter around the live price. A market order enters immediately, but the final verdict and position size still matter.",
      suggestedOrderType: "market",
      distanceInAtr,
    };
  }

  if (distanceInAtr <= 0.5) {
    return {
      action: "enter-now",
      title: "Entry zone is live",
      detail: "Live price is within half of a normal ATR candle range from the stated entry, so the entry is not meaningfully stale.",
      suggestedOrderType: "market",
      distanceInAtr,
    };
  }

  if (distanceInAtr > 3) {
    return {
      action: "do-not-enter",
      title: "Recheck the signal before entering",
      detail: `The stated entry is ${distanceInAtr.toFixed(1)} normal ATR ranges from live price. Do not chase it or leave an indefinite order without confirming the setup is still valid.`,
      distanceInAtr,
    };
  }

  const isPullback = signal.side === "long" ? signal.entry < market.price : signal.entry > market.price;
  if (isPullback) {
    return {
      action: "wait-limit",
      title: "Wait for the pullback price",
      detail: "A limit order can wait at the stated entry instead of chasing the live price. Choose an expiry so an old setup does not remain open indefinitely.",
      suggestedOrderType: "limit",
      distanceInAtr,
    };
  }

  return {
    action: "wait-breakout",
    title: "Wait for price confirmation",
    detail: "The entry sits beyond live price in the trade direction. A stop-entry order waits for price to cross that level before the paper position opens.",
    suggestedOrderType: "stop",
    distanceInAtr,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function directionMultiplier(side: TradeSide) {
  return side === "long" ? 1 : -1;
}

function isProtectiveStop(signal: SignalInput) {
  if (!signal.stopLoss) return false;
  return (signal.stopLoss - signal.entry) * directionMultiplier(signal.side) < 0;
}

function isProfitTarget(signal: SignalInput, target: number) {
  return (target - signal.entry) * directionMultiplier(signal.side) > 0;
}

function riskReward(signal: SignalInput) {
  if (!signal.stopLoss || !signal.takeProfits.length) return undefined;
  if (!isProtectiveStop(signal)) return undefined;

  const target = signal.takeProfits[0];
  if (!isProfitTarget(signal, target)) return undefined;

  const risk = absPctDistance(signal.entry, signal.stopLoss);
  const reward = absPctDistance(signal.entry, target);
  if (!risk) return undefined;
  return reward / risk;
}

export function createRiskReport(signal: SignalInput, market: MarketSnapshot, btcMarket?: MarketSnapshot): RiskReport {
  const findings: RiskFinding[] = [];
  const leverage = signal.leverage ?? 1;
  const move = recentMove(market.candles);
  const pulse = marketPulse(market);
  const btcContext = createBtcContext(signal, btcMarket);
  const marketVolatility = pulse.atrPct;
  const entryDistancePct = absPctDistance(market.price, signal.entry);
  const stopDistancePct = signal.stopLoss ? absPctDistance(signal.entry, signal.stopLoss) : undefined;
  const hasProtectiveStop = isProtectiveStop(signal);
  const firstTarget = signal.takeProfits[0];
  const hasProfitTarget = firstTarget ? isProfitTarget(signal, firstTarget) : false;
  const rr = riskReward(signal);
  const hasThinRiskReward = rr !== undefined && rr < 2;
  let score = 100;

  if (signal.leverage === undefined) {
    score -= 5;
    findings.push({
      level: "warn",
      label: "Leverage was not supplied",
      detail: "TradeLens will not treat missing leverage as a confirmed 1x position. Confirm leverage before paper tracking.",
    });
  } else if (leverage >= 25) {
    score -= 52;
    findings.push({
      level: "danger",
      label: "Extreme leverage",
      detail: `${leverage}x can turn a normal market wiggle into a forced exit. TradeLens treats this as avoid-level risk.`,
    });
  } else if (leverage >= 15) {
    score -= 34;
    findings.push({
      level: "danger",
      label: "Extreme leverage",
      detail: `${leverage}x leaves very little room for normal crypto volatility.`,
    });
  } else if (leverage >= 8) {
    score -= 14;
    findings.push({
      level: "warn",
      label: "High leverage",
      detail: `${leverage}x can force an exit before the trade thesis has time to play out.`,
    });
  } else {
    findings.push({
      level: "good",
      label: "Leverage is contained",
      detail: `${leverage}x is easier to manage than typical high-leverage signal calls.`,
    });
  }

  if (!signal.stopLoss) {
    score -= 22;
    findings.push({
      level: "danger",
      label: "No stop-loss detected",
      detail: "TradeLens needs an invalidation level before the signal can be treated as structured.",
    });
  } else if (!hasProtectiveStop) {
    score -= 58;
    findings.push({
      level: "danger",
      label: "Stop is on the wrong side",
      detail:
        signal.side === "long"
          ? "For a long trade, the stop-loss must sit below the entry. This stop would not protect the setup."
          : "For a short trade, the stop-loss must sit above the entry. This stop would not protect the setup.",
    });
  } else if (stopDistancePct && stopDistancePct < marketVolatility * 1.6) {
    score -= 12;
    findings.push({
      level: "warn",
      label: "Stop is inside normal noise",
      detail: `The stop is ${stopDistancePct.toFixed(2)}% away while ${market.timeframe} ATR is ${marketVolatility.toFixed(2)}% of price.`,
    });
  } else {
    findings.push({
      level: "good",
      label: "Stop-loss is present",
      detail: "The signal includes a defined invalidation level.",
    });
  }

  if (firstTarget && !hasProfitTarget) {
    score -= 28;
    findings.push({
      level: "danger",
      label: "Target is on the wrong side",
      detail:
        signal.side === "long"
          ? "For a long trade, the first take-profit should be above the entry."
          : "For a short trade, the first take-profit should be below the entry.",
    });
  }

  if (!rr) {
    score -= 14;
    findings.push({
      level: "warn",
      label: firstTarget ? "Risk/reward is invalid" : "Reward is unclear",
      detail: firstTarget
        ? "TradeLens could not score risk/reward because the stop or target is not placed correctly for this trade direction."
        : "Add a take-profit level so the risk/reward can be measured.",
    });
  } else if (rr < 1.4) {
    score -= 16;
    findings.push({
      level: "danger",
      label: "Poor risk/reward",
      detail: `The first target offers only ${rr.toFixed(2)}R before fees and slippage.`,
    });
  } else if (rr < 2) {
    score -= 7;
    findings.push({
      level: "warn",
      label: "Thin risk/reward",
      detail: `${rr.toFixed(2)}R is tradable but leaves limited margin for bad fills.`,
    });
  } else {
    findings.push({
      level: "good",
      label: "Risk/reward is reasonable",
      detail: `The first target offers about ${rr.toFixed(2)}R.`,
    });
  }

  if (entryDistancePct > 1.2) {
    score -= 10;
    findings.push({
      level: "warn",
      label: "Entry is away from live price",
      detail: `The signal entry is ${entryDistancePct.toFixed(2)}% away from the current Bitget price.`,
    });
  }

  const directionalMove = move * directionMultiplier(signal.side);
  if (directionalMove > 2.2) {
    score -= 12;
    findings.push({
      level: "danger",
      label: "Chase risk",
      detail: `Price has already moved ${directionalMove.toFixed(2)}% in the trade direction over recent candles.`,
    });
  } else if (Math.abs(move) > 1.4) {
    score -= 6;
    findings.push({
      level: "warn",
      label: "Fast market",
      detail: `Recent candles moved ${move.toFixed(2)}%, so slippage and fakeout risk are elevated.`,
    });
  }

  if (marketVolatility > 0.65) {
    score -= 9;
    findings.push({
      level: "warn",
      label: "Elevated ATR volatility",
      detail: `${market.timeframe} ATR is ${marketVolatility.toFixed(2)}% of price, so each normal candle can cover more ground.`,
    });
  }

  const fundingRatePct = market.derivatives.fundingRatePct;
  const directionalFunding = fundingRatePct === undefined ? undefined : fundingRatePct * directionMultiplier(signal.side);
  if (directionalFunding !== undefined && directionalFunding > 0.03) {
    score -= 6;
    findings.push({
      level: "warn",
      label: `${signal.side === "long" ? "Longs" : "Shorts"} are paying for the crowd`,
      detail: `Funding is ${fundingRatePct!.toFixed(4)}%, which suggests positioning is becoming crowded in this trade direction.`,
    });
  }

  const spreadBps = market.derivatives.spreadBps;
  if (spreadBps !== undefined && spreadBps > 5) {
    score -= 6;
    findings.push({
      level: "warn",
      label: "Wide execution spread",
      detail: `The best bid and ask are ${spreadBps.toFixed(2)} basis points apart, increasing entry and exit friction.`,
    });
  }

  const bookImbalancePct = market.derivatives.bookImbalancePct;
  const directionalBook = bookImbalancePct === undefined ? undefined : bookImbalancePct * directionMultiplier(signal.side);
  if (directionalBook !== undefined && directionalBook < -35) {
    score -= 5;
    findings.push({
      level: "warn",
      label: "Order book leans against the signal",
      detail: `Visible near-market depth is tilted ${Math.abs(bookImbalancePct!).toFixed(0)}% toward the opposing side.`,
    });
  }

  const basisPct = market.derivatives.basisPct;
  const directionalBasis = basisPct === undefined ? undefined : basisPct * directionMultiplier(signal.side);
  if (directionalBasis !== undefined && directionalBasis > 0.15) {
    score -= 4;
    findings.push({
      level: "warn",
      label: "Perpetual price is stretched",
      detail: `Mark price is ${basisPct!.toFixed(3)}% away from the index in the signal direction.`,
    });
  }

  const trendAgainstSignal =
    (signal.side === "long" && pulse.trend === "bearish") || (signal.side === "short" && pulse.trend === "bullish");
  const rsiChaseRisk = (signal.side === "long" && pulse.rsi >= 70) || (signal.side === "short" && pulse.rsi <= 30);

  if (trendAgainstSignal) {
    score -= 9;
    findings.push({
      level: "warn",
      label: "Trend is against the signal",
      detail:
        signal.side === "long"
          ? "The short-term market pulse is bearish, so a long needs stronger confirmation."
          : "The short-term market pulse is bullish, so a short needs stronger confirmation.",
    });
  } else if (pulse.trend !== "mixed") {
    findings.push({
      level: "good",
      label: "Trend does not fight the idea",
      detail: `The candle pulse is ${pulse.trend}, which is not immediately hostile to this ${signal.side} setup.`,
    });
  }

  if (rsiChaseRisk) {
    score -= 6;
    findings.push({
      level: "warn",
      label: "Momentum is stretched",
      detail: `RSI is ${pulse.rsi.toFixed(1)}, so this setup may be late unless price resets first.`,
    });
  }

  if (btcContext?.alignment === "conflicts") {
    score -= 8;
    findings.push({
      level: "warn",
      label: "Bitcoin context conflicts",
      detail: btcContext.summary,
    });
  } else if (btcContext?.alignment === "supports") {
    findings.push({
      level: "good",
      label: "Bitcoin context supports the idea",
      detail: btcContext.summary,
    });
  }

  const volatilityLeverage = clamp(Math.floor(4 / Math.max(marketVolatility, 0.4)), 1, 5);
  const safeLeverage = signal.leverage === undefined ? 1 : clamp(Math.min(leverage, volatilityLeverage), 1, 5);
  const stopBuffer = Math.max(marketVolatility * 2.6, 0.8) / 100;
  const targetBuffer = Math.max(marketVolatility * 4.4, 1.6) / 100;
  const sideDirection = directionMultiplier(signal.side);
  const saferEntry = market.price;
  const saferStop = saferEntry * (1 - sideDirection * stopBuffer);
  const saferTarget = saferEntry * (1 + sideDirection * targetBuffer);
  const hasDangerFinding = findings.some((finding) => finding.level === "danger");
  const cappedScore = !hasProtectiveStop
    ? Math.min(score, 42)
    : leverage >= 25
      ? Math.min(score, 47)
      : leverage >= 15 || hasDangerFinding || hasThinRiskReward
        ? Math.min(score, 74)
        : score;
  const finalScore = Math.round(clamp(cappedScore, 0, 100));
  const verdict: Verdict = finalScore >= 76 ? "Accept" : finalScore >= 48 ? "Modify" : "Avoid";
  const entryGuidance = createEntryGuidance(signal, market, verdict);

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    signal,
    market,
    verdict,
    score: finalScore,
    engineVerdict: verdict,
    engineScore: finalScore,
    riskReward: rr,
    stopDistancePct,
    entryDistancePct,
    volatilityPct: marketVolatility,
    recentMovePct: move,
    marketPulse: pulse,
    btcContext,
    entryGuidance,
    findings,
    saferPlan: {
      leverage: safeLeverage,
      entry: roundUsdPrice(saferEntry),
      stopLoss: roundUsdPrice(saferStop),
      takeProfit: roundUsdPrice(saferTarget),
      riskPct: finalScore >= 76 ? 1.5 : finalScore >= 48 ? 0.75 : 0,
      rationale:
        verdict === "Avoid"
          ? "The safer plan is to stay flat unless price resets and volatility cools."
          : "The safer plan uses live price, lower leverage, ATR-aware stop placement, and capped paper risk.",
    },
  };
}
