import type { Candle } from "./types";

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function ema(values: number[], period: number) {
  if (period <= 0 || values.length < period) return undefined;

  const smoothing = 2 / (period + 1);
  let value = average(values.slice(0, period));

  for (const next of values.slice(period)) {
    value = next * smoothing + value * (1 - smoothing);
  }

  return value;
}

export function wilderRsi(closes: number[], period = 14) {
  if (period <= 0 || closes.length <= period) return undefined;

  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  let averageGain = average(changes.slice(0, period).map((change) => Math.max(change, 0)));
  let averageLoss = average(changes.slice(0, period).map((change) => Math.max(-change, 0)));

  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (!averageGain && !averageLoss) return 50;
  if (!averageLoss) return 100;

  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function wilderAtr(candles: Candle[], period = 14) {
  if (period <= 0 || candles.length <= period) return undefined;

  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  let value = average(trueRanges.slice(0, period));
  for (const trueRange of trueRanges.slice(period)) {
    value = (value * (period - 1) + trueRange) / period;
  }

  return value;
}

export function wilderAtrPercent(candles: Candle[], price: number, period = 14) {
  const value = wilderAtr(candles, period);
  return value !== undefined && price > 0 ? (value / price) * 100 : undefined;
}
