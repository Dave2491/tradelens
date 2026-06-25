import assert from "node:assert/strict";
import test from "node:test";
import { createEntryGuidance, createRiskReport } from "../src/lib/riskEngine.ts";

function marketFixture() {
  const duration = 15 * 60_000;
  const start = Date.now() - 121 * duration;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const close = 98 + index * 0.017;
    return {
      time: start + index * duration,
      open: close - 0.02,
      high: close + 0.25,
      low: close - 0.25,
      close,
      volume: 1_000,
    };
  });

  return {
    pair: "TESTUSDT",
    price: 100,
    candles,
    timeframe: "15m",
    timeframeSource: "inferred",
    derivatives: {},
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

test("the safer plan never increases supplied leverage", () => {
  const report = createRiskReport(
    {
      pair: "TESTUSDT",
      side: "long",
      entry: 100,
      entryMode: "exact",
      stopLoss: 99,
      takeProfits: [103],
      leverage: 3,
      timeframe: "15m",
      timeframeSource: "inferred",
      raw: "test fixture",
    },
    marketFixture(),
  );

  assert.ok(report.saferPlan.leverage <= 3);
});

test("the safer plan preserves meaningful precision for sub-dollar tokens", () => {
  const market = marketFixture();
  market.price = 0.7277;
  market.candles = market.candles.map((candle) => ({
    ...candle,
    open: candle.open / 137,
    high: candle.high / 137,
    low: candle.low / 137,
    close: candle.close / 137,
  }));

  const report = createRiskReport(
    {
      pair: "SUIUSDT",
      side: "long",
      entry: 0.7277,
      entryMode: "exact",
      stopLoss: 0.7256,
      takeProfits: [0.7472],
      leverage: 3,
      timeframe: "5m",
      timeframeSource: "inferred",
      raw: "test fixture",
    },
    market,
  );

  assert.notEqual(report.saferPlan.stopLoss, Number(report.saferPlan.stopLoss.toFixed(2)));
  assert.notEqual(report.saferPlan.takeProfit, Number(report.saferPlan.takeProfit.toFixed(2)));
});

test("current-price signals receive immediate market-entry guidance", () => {
  const market = marketFixture();
  const guidance = createEntryGuidance(
    {
      pair: "TESTUSDT",
      side: "long",
      entry: market.price,
      entryMode: "current",
      stopLoss: 98,
      takeProfits: [104],
      leverage: 2,
      timeframe: "15m",
      timeframeSource: "inferred",
      raw: "test fixture",
    },
    market,
    "Accept",
  );

  assert.equal(guidance.action, "enter-now");
  assert.equal(guidance.suggestedOrderType, "market");
});

test("a stale exact entry is rejected instead of being chased", () => {
  const market = marketFixture();
  const guidance = createEntryGuidance(
    {
      pair: "TESTUSDT",
      side: "long",
      entry: 120,
      entryMode: "exact",
      stopLoss: 115,
      takeProfits: [130],
      leverage: 2,
      timeframe: "15m",
      timeframeSource: "inferred",
      raw: "test fixture",
    },
    market,
    "Modify",
  );

  assert.equal(guidance.action, "do-not-enter");
  assert.ok(guidance.distanceInAtr > 3);
});

test("bearish Bitcoin context penalizes an altcoin long without pretending to predict it", () => {
  const signalMarket = marketFixture();
  const btcMarket = marketFixture();
  btcMarket.pair = "BTCUSDT";
  btcMarket.candles = btcMarket.candles.map((candle, index) => {
    const close = 102 - index * 0.017;
    return {
      ...candle,
      open: close + 0.02,
      high: close + 0.25,
      low: close - 0.25,
      close,
    };
  });
  btcMarket.price = 100;

  const signal = {
    pair: "TESTUSDT",
    side: "long",
    entry: 100,
    entryMode: "current",
    stopLoss: 97,
    takeProfits: [106],
    leverage: 2,
    timeframe: "15m",
    timeframeSource: "inferred",
    raw: "test fixture",
  };
  const withoutBtc = createRiskReport(signal, signalMarket);
  const withBtc = createRiskReport(signal, signalMarket, btcMarket);

  assert.equal(withBtc.btcContext?.alignment, "conflicts");
  assert.equal(withBtc.score, withoutBtc.score - 8);
  assert.ok(withBtc.findings.some((finding) => finding.label === "Bitcoin context conflicts"));
});
