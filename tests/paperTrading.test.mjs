import assert from "node:assert/strict";
import test from "node:test";
import { calculatePnl, calculateTradingFee, updatePaperTradeWithMarket } from "../src/lib/paperTrading.ts";

function tradeFixture(overrides = {}) {
  const now = Date.now();
  return {
    costModelVersion: 1,
    executionModelVersion: 2,
    id: "trade-1",
    reportId: "report-1",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    plan: "original",
    pair: "TESTUSDT",
    side: "long",
    entry: 100,
    fillEntry: 100,
    initialStopLoss: 95,
    stopLoss: 95,
    takeProfit: 110,
    targets: [
      { price: 110, allocationPct: 50 },
      { price: 120, allocationPct: 50 },
    ],
    leverage: 2,
    orderType: "limit",
    configuredRiskPct: 1,
    quantity: 10,
    remainingQuantity: 10,
    currentPrice: 100,
    unrealizedPnl: 0,
    realizedPnl: 0,
    grossUnrealizedPnl: 0,
    grossRealizedPnl: 0,
    feeRatePct: 0,
    entryFee: 0,
    exitFees: 0,
    estimatedExitFee: 0,
    fundingCost: 0,
    fundingUpdatedAt: new Date(now - 60_000).toISOString(),
    balanceBefore: 10_000,
    balanceAfter: 10_000,
    status: "active",
    timeframeLabel: "5m",
    timeframe: "5m",
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    entryHitAt: new Date(now - 60_000).toISOString(),
    lastEvaluatedCandleTime: now - 10 * 60_000,
    spreadBpsAtEntry: 0,
    postTp1Action: "hold-stop",
    provenance: {
      balance: "user",
      risk: "user",
      orderType: "user",
      targetAllocation: "user",
      expiry: "none",
      management: "user",
      fees: "user-confirmed-estimate",
      funding: "bitget-live-estimate",
    },
    ...overrides,
  };
}

function marketFixture(candles, price = 100, derivatives = { spreadBps: 0 }) {
  return {
    pair: "TESTUSDT",
    price,
    candles,
    timeframe: "5m",
    timeframeSource: "selected",
    derivatives,
    dataQuality: {
      marketTimestamp: new Date().toISOString(),
      latestClosedCandleAt: new Date().toISOString(),
      ageSeconds: 0,
      closedCandles: candles.length,
    },
    source: "bitget",
    fetchedAt: new Date().toISOString(),
  };
}

function candle(time, low, high, close = 100) {
  return { time, open: close, high, low, close, volume: 1_000 };
}

test("a completed candle detects a target wick missed by the current price", () => {
  const trade = tradeFixture();
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 111)], 100),
  );

  assert.equal(next.status, "active");
  assert.equal(next.targets[0].hitAt !== undefined, true);
  assert.equal(next.targets[1].hitAt, undefined);
  assert.equal(next.remainingQuantity, 5);
  assert.equal(next.realizedPnl, 50);
});

test("a completed candle activates an entry crossed between refreshes", () => {
  const trade = tradeFixture({ status: "waiting-entry", entryHitAt: undefined, currentPrice: 102 });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 102, 101)], 101),
  );

  assert.equal(next.status, "active");
  assert.ok(next.entryHitAt);
});

test("an exact long limit entry does not fill before price reaches it", () => {
  const trade = tradeFixture({ status: "waiting-entry", entryHitAt: undefined, currentPrice: 102, expiresAt: undefined });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 101, 103, 102)], 102),
  );

  assert.equal(next.status, "waiting-entry");
  assert.equal(next.entryHitAt, undefined);
});

test("a good-till-cancelled entry remains pending without an expiry", () => {
  const trade = tradeFixture({ status: "waiting-entry", entryHitAt: undefined, currentPrice: 105, expiresAt: undefined });
  const next = updatePaperTradeWithMarket(trade, marketFixture([], 105));

  assert.equal(next.status, "waiting-entry");
});

test("active trades keep evaluating candles after the entry deadline", () => {
  const trade = tradeFixture({ expiresAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 121)], 120),
  );

  assert.equal(next.status, "take-profit");
});

test("multiple targets realize their allocated quantities", () => {
  const trade = tradeFixture();
  const firstTime = Date.now() - 6 * 60_000;
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(firstTime, 99, 111), candle(firstTime + 5 * 60_000, 108, 121)], 120),
  );

  assert.equal(next.status, "take-profit");
  assert.equal(next.remainingQuantity, 0);
  assert.equal(next.realizedPnl, 150);
  assert.equal(next.targets.every((target) => target.hitAt), true);
});

test("TP1 moves the remaining stop to entry only when the trader chose that rule", () => {
  const trade = tradeFixture({ postTp1Action: "move-stop-to-entry" });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 111)], 110),
  );

  assert.equal(next.status, "active");
  assert.equal(next.stopLoss, next.fillEntry);
  assert.ok(next.stopMovedAt);
  assert.match(next.lifecycleNote, /remaining stop moved to the entry fill/i);
});

test("TP1 keeps the original stop when the trader chose hold-stop", () => {
  const trade = tradeFixture({ postTp1Action: "hold-stop" });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 111)], 110),
  );

  assert.equal(next.status, "active");
  assert.equal(next.stopLoss, next.initialStopLoss);
  assert.equal(next.stopMovedAt, undefined);
});

test("a candle touching stop and target records the conservative stop outcome", () => {
  const trade = tradeFixture();
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 94, 111)], 100),
  );

  assert.equal(next.status, "stop-loss");
  assert.equal(next.realizedPnl, -50);
  assert.match(next.lifecycleNote, /same completed candle/i);
});

test("spread-adjusted fills reduce simulated PnL", () => {
  const trade = tradeFixture({ fillEntry: 100.05, quantity: 1 });
  assert.ok(calculatePnl(trade, 110, 1, 10) < 10);
});

test("taker fees are charged from the executed notional", () => {
  assert.equal(calculateTradingFee(100, 10, 0.06), 0.6);
});

test("completed trades report net PnL after entry and exit fees", () => {
  const trade = tradeFixture({
    quantity: 1,
    remainingQuantity: 1,
    targets: [{ price: 110, allocationPct: 100 }],
    feeRatePct: 0.06,
    entryFee: 0.06,
  });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([candle(Date.now() - 5 * 60_000, 99, 111)], 110),
  );

  assert.equal(next.grossRealizedPnl, 10);
  assert.equal(next.exitFees, 0.07);
  assert.equal(next.realizedPnl, 9.87);
});

test("open trades accrue an estimated funding cost from Bitget's live rate", () => {
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60_000).toISOString();
  const trade = tradeFixture({
    entryHitAt: eightHoursAgo,
    fundingUpdatedAt: eightHoursAgo,
  });
  const next = updatePaperTradeWithMarket(
    trade,
    marketFixture([], 100, { spreadBps: 0, fundingRatePct: 0.01, markPrice: 100 }),
  );

  assert.ok(next.fundingCost >= 0.09 && next.fundingCost <= 0.11);
  assert.equal(next.realizedPnl, -0.1);
});
