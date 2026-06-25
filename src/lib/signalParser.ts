import { resolveMarketSymbol, suggestMarketSymbols } from "./bitget.ts";
import { resolveTimeframe, type TimeframeSelection } from "./timeframes.ts";
import type { MarketSymbol, SignalInput, TradeSide } from "./types";

export type LocalSignalDraft = Omit<SignalInput, "entry" | "raw"> & {
  entry?: number;
  entryMode: "exact" | "current";
};

function normalizeNumber(value: string) {
  return Number(value.replace(/[, _]/g, ""));
}

function findFirstNumberAfter(raw: string, labels: string[]) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:=@-]?\\s*([0-9][0-9,_.]*)`, "i");
    const match = raw.match(pattern);
    if (match) return normalizeNumber(match[1]);
  }

  return undefined;
}

function findTakeProfits(raw: string) {
  const numberPattern = "[0-9][0-9_]*(?:,[0-9]{3})*(?:\\.[0-9]+)?";
  const targetPattern = new RegExp(
    `\\b(?:tp\\s+\\d+\\s*[:=@-]|tp\\d+\\s*[:=@-]?|tp\\s*[:=@-]|tp\\s+|targets?\\s*[:=@-]?|take\\s*profits?\\s*[:=@-]?)\\s*(${numberPattern}(?:\\s*(?:\\/|,|and)\\s*${numberPattern})*)`,
    "gi",
  );
  const values = [...raw.matchAll(targetPattern)]
    .flatMap((match) => [...match[1].matchAll(/[0-9][0-9,_.]*/g)])
    .map((match) => normalizeNumber(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0);

  return [...new Set(values)];
}

function parsePair(raw: string, symbols: MarketSymbol[]) {
  const upper = raw.toUpperCase();
  const explicit = upper.match(/\b([A-Z]{2,12})(?:\/|-)?USDT\b/);
  if (explicit) {
    const explicitPair = `${explicit[1]}USDT`;
    return resolveMarketSymbol(explicitPair, symbols) ?? (symbols.length ? undefined : explicitPair);
  }

  const sideToken = upper.match(/\b(?:LONG|SHORT|BUY|SELL)\s+([A-Z0-9]{2,12})\b/);
  if (sideToken) return resolveMarketSymbol(sideToken[1], symbols);

  const knownToken = symbols.find((item) => new RegExp(`\\b${item.baseCoin}\\b`, "i").test(raw));
  return knownToken?.symbol;
}

function parseSide(raw: string): TradeSide | undefined {
  if (/\b(long|buy)\b/i.test(raw)) return "long";
  if (/\b(short|sell)\b/i.test(raw)) return "short";
  return undefined;
}

function usesCurrentEntry(raw: string) {
  return /\b(?:(?:entry|enter|buy|sell)\s*[:=@-]?\s*(?:at\s*)?(?:around|near)?\s*(?:the\s*)?(?:current|market)(?:\s+price)?|(?:current|market)\s+entry|enter\s+now)\b/i.test(raw);
}

export function parseLocalSignalDraft(
  raw: string,
  symbols: MarketSymbol[] = [],
  timeframeSelection: TimeframeSelection = "auto",
): LocalSignalDraft | undefined {
  const pair = parsePair(raw, symbols);
  const side = parseSide(raw);
  const entryMode = usesCurrentEntry(raw) ? "current" : "exact";
  const entry = entryMode === "exact" ? findFirstNumberAfter(raw, ["entry", "enter", "@"]) : undefined;
  const stopLoss = findFirstNumberAfter(raw, ["sl", "stop loss", "stop"]);
  const explicitLeverage = raw.match(/(\d{1,3})\s*x/i)?.[1];
  const leverage = findFirstNumberAfter(raw, ["leverage", "lev"]) ?? (explicitLeverage ? Number(explicitLeverage) : undefined);
  const takeProfits = findTakeProfits(raw);
  const resolvedTimeframe = resolveTimeframe(raw, timeframeSelection);

  if (!pair || !side || (entryMode === "exact" && (!entry || !Number.isFinite(entry)))) return undefined;

  return {
    pair,
    side,
    entry,
    entryMode,
    stopLoss,
    takeProfits,
    leverage,
    timeframe: resolvedTimeframe.timeframe,
    timeframeSource: resolvedTimeframe.source,
  };
}

export function toLocalSignalInput(draft: LocalSignalDraft, raw: string, livePrice: number): SignalInput {
  const entry = draft.entryMode === "current" ? livePrice : draft.entry;
  if (!entry || !Number.isFinite(entry)) throw new Error("I could not find a valid entry price.");

  return {
    pair: draft.pair,
    side: draft.side,
    entry,
    stopLoss: draft.stopLoss,
    takeProfits: draft.takeProfits,
    leverage: draft.leverage,
    entryMode: draft.entryMode,
    timeframe: draft.timeframe,
    timeframeSource: draft.timeframeSource,
    raw,
  };
}

export function parseSignal(raw: string, symbols: MarketSymbol[] = [], timeframeSelection: TimeframeSelection = "auto"): SignalInput {
  const pair = parsePair(raw, symbols);
  const side = parseSide(raw);
  const entry =
    findFirstNumberAfter(raw, ["entry", "enter", "buy", "long", "short", "sell", "@"]) ??
    [...raw.matchAll(/[0-9][0-9,_.]*/g)].map((match) => normalizeNumber(match[0]))[0];
  const stopLoss = findFirstNumberAfter(raw, ["sl", "stop loss", "stop"]);
  const explicitLeverage = raw.match(/(\d{1,3})\s*x/i)?.[1];
  const leverage = findFirstNumberAfter(raw, ["leverage", "lev"]) ?? (explicitLeverage ? Number(explicitLeverage) : undefined);
  const takeProfits = findTakeProfits(raw);
  const resolvedTimeframe = resolveTimeframe(raw, timeframeSelection);

  if (!pair) {
    const candidate = raw.toUpperCase().match(/\b(?:LONG|SHORT|BUY|SELL)\s+([A-Z0-9]{2,12})\b/)?.[1];
    const suggestions = suggestMarketSymbols(candidate, symbols);
    throw new Error(
      suggestions.length
        ? `I could not find that Bitget futures pair. Did you mean ${suggestions.join(", ")}?`
        : "I could not find a Bitget USDT futures pair in this signal.",
    );
  }
  if (!side) throw new Error("I could not tell if this is a LONG or SHORT signal.");
  if (!entry || !Number.isFinite(entry)) throw new Error("I could not find a valid entry price.");

  return {
    pair,
    side,
    entry,
    stopLoss,
    takeProfits,
    leverage,
    entryMode: "exact",
    timeframe: resolvedTimeframe.timeframe,
    timeframeSource: resolvedTimeframe.source,
    raw,
  };
}
