import type { AnalysisTimeframe, Candle, DerivativesSnapshot, MarketSnapshot, MarketSymbol, TimeframeSource } from "./types";
import { prepareClosedCandles, validateTickerTimestamp } from "./marketData.ts";

const BITGET_BASE_URL = "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";
let symbolCache: MarketSymbol[] | undefined;

function toNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toOptionalNumber(value: unknown) {
  const number = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(number) ? number : undefined;
}

function parseCandle(row: unknown[]): Candle {
  return {
    time: toNumber(row[0]),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    volume: toNumber(row[5]),
  };
}

function prepareMarketData(ticker: any, candleRows: unknown[][], timeframe: AnalysisTimeframe, referenceTimeMs: number) {
  const parsedCandles = candleRows.map(parseCandle);
  const { candles, latestClosedAtMs } = prepareClosedCandles(parsedCandles, timeframe, referenceTimeMs);
  const marketTimestampMs = toNumber(ticker?.ts);
  const ageMs = validateTickerTimestamp(marketTimestampMs, referenceTimeMs);

  return {
    candles,
    dataQuality: {
      marketTimestamp: new Date(marketTimestampMs).toISOString(),
      latestClosedCandleAt: new Date(latestClosedAtMs).toISOString(),
      ageSeconds: Math.round(ageMs / 1000),
      closedCandles: candles.length,
    },
  };
}

function normalizeSymbolRow(row: any): MarketSymbol | undefined {
  const symbol = typeof row?.symbol === "string" ? row.symbol.toUpperCase() : "";
  if (!symbol.endsWith("USDT")) return undefined;

  const baseCoin =
    typeof row?.baseCoin === "string"
      ? row.baseCoin.toUpperCase()
      : typeof row?.baseCoinName === "string"
        ? row.baseCoinName.toUpperCase()
        : symbol.replace(/USDT$/, "");
  const quoteCoin = typeof row?.quoteCoin === "string" ? row.quoteCoin.toUpperCase() : "USDT";

  return {
    symbol,
    baseCoin,
    quoteCoin,
  };
}

async function requestJson<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BITGET_BASE_URL}${path}`);
  } catch {
    throw new Error("TradeLens could not reach Bitget. Confirm that your browser VPN is connected, then retry the live check.");
  }

  if (!response.ok) {
    throw new Error(`Bitget request failed with ${response.status}`);
  }

  const payload = await response.json();

  if (payload.code && payload.code !== "00000") {
    throw new Error(payload.msg ?? "Bitget returned an error");
  }

  return payload.data as T;
}

async function requestOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await requestJson<T>(path);
  } catch {
    return undefined;
  }
}

function firstRecord(value: any) {
  return Array.isArray(value) ? value[0] : value;
}

function parseDerivatives(
  tickerValue: any,
  fundingValue: any,
  openInterestValue: any,
  depthValue: any,
  livePrice: number,
): DerivativesSnapshot {
  const ticker = firstRecord(tickerValue);
  const funding = firstRecord(fundingValue);
  const openInterestRow = firstRecord(openInterestValue?.openInterestList ?? openInterestValue);
  const markPrice = toOptionalNumber(ticker?.markPrice);
  const indexPrice = toOptionalNumber(ticker?.indexPrice);
  const fundingRate = toOptionalNumber(funding?.fundingRate);
  const openInterest = toOptionalNumber(openInterestRow?.size ?? openInterestRow?.openInterest);
  const bids = Array.isArray(depthValue?.bids) ? depthValue.bids.slice(0, 20) : [];
  const asks = Array.isArray(depthValue?.asks) ? depthValue.asks.slice(0, 20) : [];
  const bestBid = toOptionalNumber(bids[0]?.[0]);
  const bestAsk = toOptionalNumber(asks[0]?.[0]);
  const midpoint = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined;
  const bidDepthUsd = bids.reduce((sum: number, row: unknown[]) => sum + toNumber(row[0]) * toNumber(row[1]), 0);
  const askDepthUsd = asks.reduce((sum: number, row: unknown[]) => sum + toNumber(row[0]) * toNumber(row[1]), 0);
  const totalDepth = bidDepthUsd + askDepthUsd;

  return {
    fundingRatePct: fundingRate === undefined ? undefined : fundingRate * 100,
    openInterestUsd: openInterest === undefined ? undefined : openInterest * livePrice,
    spreadBps: midpoint && bestBid && bestAsk ? ((bestAsk - bestBid) / midpoint) * 10_000 : undefined,
    bidDepthUsd: bids.length ? bidDepthUsd : undefined,
    askDepthUsd: asks.length ? askDepthUsd : undefined,
    bookImbalancePct: totalDepth ? ((bidDepthUsd - askDepthUsd) / totalDepth) * 100 : undefined,
    markPrice,
    indexPrice,
    basisPct: markPrice && indexPrice ? ((markPrice - indexPrice) / indexPrice) * 100 : undefined,
  };
}

export function resolveMarketSymbol(input: string | undefined, symbols: MarketSymbol[]) {
  if (!input) return undefined;

  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return undefined;

  const exact = symbols.find((item) => item.symbol === cleaned || item.baseCoin === cleaned);
  if (exact) return exact.symbol;

  const withUsdt = cleaned.endsWith("USDT") ? cleaned : `${cleaned}USDT`;
  return symbols.find((item) => item.symbol === withUsdt)?.symbol;
}

export function suggestMarketSymbols(input: string | undefined, symbols: MarketSymbol[]) {
  if (!input) return [];

  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return [];
  const token = cleaned.replace(/USDT$/, "");

  return symbols
    .filter((item) => item.baseCoin.includes(token) || item.symbol.includes(cleaned) || cleaned.includes(item.baseCoin))
    .slice(0, 4)
    .map((item) => item.symbol);
}

export async function fetchMarketSymbols(): Promise<MarketSymbol[]> {
  if (symbolCache?.length) return symbolCache;

  if (!import.meta.env.DEV) {
    const proxied = await fetch("/api/symbols");

    if (!proxied.ok) {
      throw new Error("TradeLens could not load Bitget market symbols.");
    }

    const payload = await proxied.json();
    const normalized = Array.isArray(payload.symbols)
      ? payload.symbols.map(normalizeSymbolRow).filter((item: MarketSymbol | undefined): item is MarketSymbol => Boolean(item))
      : [];
    symbolCache = normalized;
    return normalized;
  }

  const data = await requestJson<any[]>(`/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`);
  const normalized = data.map(normalizeSymbolRow).filter((item): item is MarketSymbol => Boolean(item));
  symbolCache = normalized;
  return normalized;
}

export async function fetchMarketSnapshot(
  pair: string,
  timeframe: AnalysisTimeframe = "15m",
  timeframeSource: TimeframeSource = "default",
  includeDerivatives = true,
): Promise<MarketSnapshot> {
  const symbol = pair.toUpperCase();
  const proxyPath = `/api/market?pair=${symbol}&timeframe=${encodeURIComponent(timeframe)}&derivatives=${includeDerivatives ? "1" : "0"}`;

  if (!import.meta.env.DEV) {
    const proxied = await fetch(proxyPath);

    if (!proxied.ok) {
      throw new Error("TradeLens could not reach the Bitget market proxy.");
    }

    const payload = await proxied.json();
    const ticker = Array.isArray(payload.ticker) ? payload.ticker[0] : payload.ticker;
    if (!Array.isArray(payload.candles)) throw new Error("Bitget did not return candle data.");
    const fetchedAt = payload.fetchedAt ?? new Date().toISOString();
    const referenceTimeMs = Date.parse(fetchedAt);
    const prepared = prepareMarketData(ticker, payload.candles, timeframe, referenceTimeMs);
    const candles = prepared.candles;
    const lastCandle = candles[candles.length - 1];
    const price = toNumber(ticker?.lastPr ?? ticker?.last ?? lastCandle?.close);

    if (!price) {
      throw new Error("Bitget did not return a usable live price.");
    }

    return {
      pair: symbol,
      price,
      change24h: toNumber(ticker?.change24h),
      high24h: toNumber(ticker?.high24h),
      low24h: toNumber(ticker?.low24h),
      candles,
      timeframe,
      timeframeSource,
      derivatives: parseDerivatives(ticker, payload.funding, payload.openInterest, payload.depth, price),
      dataQuality: prepared.dataQuality,
      source: "bitget",
      fetchedAt,
    };
  }

  const [tickerData, candleData, fundingData, openInterestData, depthData] = await Promise.all([
    requestJson<{ lastPr?: string; last?: string; change24h?: string; high24h?: string; low24h?: string; ts?: string }[] | { lastPr?: string; last?: string; change24h?: string; high24h?: string; low24h?: string; ts?: string }>(
      `/api/v2/mix/market/ticker?symbol=${symbol}&productType=${PRODUCT_TYPE}`,
    ),
    requestJson<unknown[][]>(
      `/api/v2/mix/market/candles?symbol=${symbol}&productType=${PRODUCT_TYPE}&granularity=${timeframe}&limit=120`,
    ),
    includeDerivatives
      ? requestOptionalJson(`/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=${PRODUCT_TYPE}`)
      : Promise.resolve(undefined),
    includeDerivatives
      ? requestOptionalJson(`/api/v2/mix/market/open-interest?symbol=${symbol}&productType=${PRODUCT_TYPE}`)
      : Promise.resolve(undefined),
    includeDerivatives
      ? requestOptionalJson(`/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=${PRODUCT_TYPE}&precision=scale0&limit=50`)
      : Promise.resolve(undefined),
  ]);

  const ticker = Array.isArray(tickerData) ? tickerData[0] : tickerData;
  const referenceTimeMs = Date.now();
  const prepared = prepareMarketData(ticker, candleData, timeframe, referenceTimeMs);
  const candles = prepared.candles;
  const lastCandle = candles[candles.length - 1];
  const price = toNumber(ticker?.lastPr ?? ticker?.last ?? lastCandle?.close);

  if (!price) {
    throw new Error("Bitget did not return a usable live price.");
  }

  return {
    pair: symbol,
    price,
    change24h: toNumber(ticker?.change24h),
    high24h: toNumber(ticker?.high24h),
    low24h: toNumber(ticker?.low24h),
    candles,
    timeframe,
    timeframeSource,
    derivatives: parseDerivatives(ticker, fundingData, openInterestData, depthData, price),
    dataQuality: prepared.dataQuality,
    source: "bitget",
    fetchedAt: new Date(referenceTimeMs).toISOString(),
  };
}
