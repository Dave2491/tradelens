import type { AnalysisTimeframe, SignalInput, TradeSide } from "./types";
import type { TimeframeSelection } from "./timeframes";
import { normalizeTimeframe, resolveTimeframe } from "./timeframes";

export type AiParsedSignal = {
  pair?: string;
  side?: TradeSide;
  entry?: number;
  entryMode?: "exact" | "current" | "range" | "wait";
  stopLoss?: number;
  takeProfits: number[];
  leverage?: number;
  timeframe?: AnalysisTimeframe;
  confidence: number;
  missingInfo: string[];
  notes: string;
};

export async function fetchAiParse(rawSignal: string): Promise<AiParsedSignal> {
  const response = await fetch("/api/ai-parse", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rawSignal }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "AI parsing is not available yet.");
  }

  return payload.parsed as AiParsedSignal;
}

export function toSignalInput(
  parsed: AiParsedSignal,
  raw: string,
  livePrice: number | undefined,
  selection: TimeframeSelection,
): SignalInput {
  const entry = parsed.entryMode === "current" && livePrice ? livePrice : parsed.entry;
  const resolvedTimeframe = resolveTimeframe(raw, selection, normalizeTimeframe(parsed.timeframe));

  if (!parsed.pair) throw new Error("The AI could not identify the trading pair.");
  if (!parsed.side) throw new Error("The AI could not identify LONG or SHORT direction.");
  if (!entry) throw new Error("The AI could not identify an entry price. Try adding an entry or saying 'around current'.");

  return {
    pair: parsed.pair,
    side: parsed.side,
    entry,
    stopLoss: parsed.stopLoss,
    takeProfits: parsed.takeProfits,
    leverage: parsed.leverage,
    entryMode: parsed.entryMode === "current" ? "current" : "exact",
    timeframe: resolvedTimeframe.timeframe,
    timeframeSource: resolvedTimeframe.source,
    raw,
  };
}
