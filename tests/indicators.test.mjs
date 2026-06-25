import assert from "node:assert/strict";
import test from "node:test";
import { ema, wilderAtr, wilderAtrPercent, wilderRsi } from "../src/lib/indicators.ts";
import { prepareClosedCandles, validateTickerTimestamp } from "../src/lib/marketData.ts";

test("EMA uses an SMA seed and standard exponential smoothing", () => {
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
});

test("Wilder RSI matches the canonical 14-period example", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(wilderRsi(closes, 14) - 70.4641) < 0.001);
});

test("Wilder ATR remains stable for a constant true range", () => {
  const candles = Array.from({ length: 16 }, (_, index) => ({
    time: index * 60_000,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1,
  }));

  assert.equal(wilderAtr(candles, 14), 2);
  assert.equal(wilderAtrPercent(candles, 10, 14), 20);
});

test("market preparation removes the unfinished candle", () => {
  const duration = 5 * 60_000;
  const reference = 100 * duration;
  const candles = Array.from({ length: 4 }, (_, index) => ({
    time: (97 + index) * duration,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1,
  }));

  const prepared = prepareClosedCandles(candles, "5m", reference, 3);
  assert.equal(prepared.candles.length, 3);
  assert.equal(prepared.latestClosedAtMs, reference);
});

test("stale ticker timestamps are rejected", () => {
  assert.throws(() => validateTickerTimestamp(1_000, 122_001), /stale/i);
  assert.equal(validateTickerTimestamp(121_000, 122_000), 1_000);
});
