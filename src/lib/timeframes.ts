import { wilderAtrPercent } from "./indicators.ts";
import type { AnalysisTimeframe, Candle, SignalInput, TimeframeSource } from "./types";

export const DEFAULT_TIMEFRAME: AnalysisTimeframe = "15m";
export const TIMEFRAME_OPTIONS: AnalysisTimeframe[] = ["5m", "15m", "30m", "1H", "4H", "1D"];

export type TimeframeSelection = "auto" | AnalysisTimeframe;

export function normalizeTimeframe(value: unknown): AnalysisTimeframe | undefined {
  if (typeof value !== "string") return undefined;

  const cleaned = value.trim().toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, AnalysisTimeframe> = {
    "5m": "5m",
    "5min": "5m",
    "5mins": "5m",
    "5minute": "5m",
    "5minutes": "5m",
    "15m": "15m",
    "15min": "15m",
    "15mins": "15m",
    "15minute": "15m",
    "15minutes": "15m",
    "30m": "30m",
    "30min": "30m",
    "30mins": "30m",
    "30minute": "30m",
    "30minutes": "30m",
    "1h": "1H",
    "1hr": "1H",
    "1hour": "1H",
    hourly: "1H",
    "4h": "4H",
    "4hr": "4H",
    "4hour": "4H",
    "4hours": "4H",
    "1d": "1D",
    "1day": "1D",
    daily: "1D",
  };

  return aliases[cleaned];
}

export function detectTimeframe(raw: string) {
  const match = raw.match(/\b(5\s*(?:m|min|mins|minute|minutes)|15\s*(?:m|min|mins|minute|minutes)|30\s*(?:m|min|mins|minute|minutes)|1\s*(?:h|hr|hour)|4\s*(?:h|hr|hour|hours)|1\s*(?:d|day)|hourly|daily)\b/i);
  return normalizeTimeframe(match?.[1]);
}

export function resolveTimeframe(
  raw: string,
  selection: TimeframeSelection,
  aiTimeframe?: AnalysisTimeframe,
): { timeframe: AnalysisTimeframe; source: TimeframeSource } {
  if (selection !== "auto") return { timeframe: selection, source: "selected" };

  const signalTimeframe = aiTimeframe ?? detectTimeframe(raw);
  if (signalTimeframe) return { timeframe: signalTimeframe, source: "signal" };

  return { timeframe: DEFAULT_TIMEFRAME, source: "default" };
}

function tradeDistancePercent(signal: SignalInput) {
  const candidates = [signal.stopLoss, ...signal.takeProfits]
    .filter((value): value is number => typeof value === "number" && value > 0)
    .map((value) => Math.abs(((value - signal.entry) / signal.entry) * 100))
    .filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length ? Math.min(...candidates) : 0;
}

export function inferTimeframe(signal: SignalInput, baselineCandles: Candle[], livePrice: number): AnalysisTimeframe {
  const distancePct = tradeDistancePercent(signal);
  if (!distancePct) return DEFAULT_TIMEFRAME;

  const baselineAtrPct = wilderAtrPercent(baselineCandles, livePrice) ?? 0;
  if (!baselineAtrPct) {
    if (distancePct <= 0.6) return "5m";
    if (distancePct <= 1.5) return "15m";
    if (distancePct <= 2.5) return "30m";
    if (distancePct <= 4) return "1H";
    if (distancePct <= 8) return "4H";
    return "1D";
  }

  const noiseMultiple = distancePct / baselineAtrPct;
  if (noiseMultiple <= 1.5) return "5m";
  if (noiseMultiple <= 3) return "15m";
  if (noiseMultiple <= 5) return "30m";
  if (noiseMultiple <= 10) return "1H";
  if (noiseMultiple <= 24) return "4H";
  return "1D";
}

export function timeframeSourceLabel(source: TimeframeSource) {
  if (source === "signal") return "from signal";
  if (source === "selected") return "manual override";
  if (source === "inferred") return "inferred from risk";
  return "assumed default";
}
