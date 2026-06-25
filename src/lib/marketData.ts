import type { AnalysisTimeframe, Candle } from "./types";

const TIMEFRAME_MS: Record<AnalysisTimeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1H": 60 * 60_000,
  "4H": 4 * 60 * 60_000,
  "1D": 24 * 60 * 60_000,
};

const MAX_TICKER_AGE_MS = 2 * 60_000;
const MAX_CLOCK_LEAD_MS = 30_000;

export function timeframeDurationMs(timeframe: AnalysisTimeframe) {
  return TIMEFRAME_MS[timeframe];
}

function isValidCandle(candle: Candle) {
  return (
    Number.isFinite(candle.time) &&
    candle.time > 0 &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0 &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= candle.low
  );
}

export function prepareClosedCandles(
  input: Candle[],
  timeframe: AnalysisTimeframe,
  referenceTimeMs = Date.now(),
  minimumCandles = 60,
) {
  const durationMs = timeframeDurationMs(timeframe);
  const unique = new Map<number, Candle>();

  for (const candle of input) {
    if (isValidCandle(candle) && candle.time + durationMs <= referenceTimeMs) {
      unique.set(candle.time, candle);
    }
  }

  const candles = [...unique.values()].sort((a, b) => a.time - b.time);
  if (candles.length < minimumCandles) {
    throw new Error(`Bitget returned only ${candles.length} valid closed ${timeframe} candles; at least ${minimumCandles} are required.`);
  }

  const latestClosedAtMs = candles[candles.length - 1].time + durationMs;
  if (referenceTimeMs - latestClosedAtMs > durationMs * 2) {
    throw new Error(`Bitget's latest closed ${timeframe} candle is stale.`);
  }

  return { candles, latestClosedAtMs };
}

export function validateTickerTimestamp(timestampMs: number, referenceTimeMs = Date.now()) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    throw new Error("Bitget did not provide a valid market timestamp.");
  }

  const ageMs = referenceTimeMs - timestampMs;
  if (ageMs > MAX_TICKER_AGE_MS) {
    throw new Error("Bitget's ticker is stale. TradeLens refused to analyze an outdated price.");
  }
  if (ageMs < -MAX_CLOCK_LEAD_MS) {
    throw new Error("Bitget's ticker timestamp is unexpectedly ahead of the analysis clock.");
  }

  return Math.max(0, ageMs);
}
