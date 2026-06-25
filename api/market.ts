const BITGET_BASE_URL = "https://api.bitget.com";
const SUPPORTED_TIMEFRAMES = new Set(["5m", "15m", "30m", "1H", "4H", "1D"]);

type VercelRequest = {
  query: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

function getQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function bitget(path: string) {
  const response = await fetch(`${BITGET_BASE_URL}${path}`);
  const payload = await response.json();

  if (!response.ok || (payload.code && payload.code !== "00000")) {
    throw new Error(payload.msg ?? `Bitget request failed with ${response.status}`);
  }

  return payload.data;
}

async function bitgetOptional(path: string) {
  try {
    return await bitget(path);
  } catch {
    return undefined;
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const pair = getQueryValue(request.query.pair)?.toUpperCase() ?? "BTCUSDT";
  const requestedTimeframe = getQueryValue(request.query.timeframe) ?? "15m";
  const timeframe = SUPPORTED_TIMEFRAMES.has(requestedTimeframe) ? requestedTimeframe : "15m";
  const includeDerivatives = getQueryValue(request.query.derivatives) !== "0";
  const productType = "USDT-FUTURES";

  try {
    const [ticker, candles, funding, openInterest, depth] = await Promise.all([
      bitget(`/api/v2/mix/market/ticker?symbol=${pair}&productType=${productType}`),
      bitget(`/api/v2/mix/market/candles?symbol=${pair}&productType=${productType}&granularity=${timeframe}&limit=120`),
      includeDerivatives
        ? bitgetOptional(`/api/v2/mix/market/current-fund-rate?symbol=${pair}&productType=${productType}`)
        : Promise.resolve(undefined),
      includeDerivatives
        ? bitgetOptional(`/api/v2/mix/market/open-interest?symbol=${pair}&productType=${productType}`)
        : Promise.resolve(undefined),
      includeDerivatives
        ? bitgetOptional(`/api/v2/mix/market/merge-depth?symbol=${pair}&productType=${productType}&precision=scale0&limit=50`)
        : Promise.resolve(undefined),
    ]);

    response.status(200).json({
      pair,
      ticker,
      candles,
      funding,
      openInterest,
      depth,
      timeframe,
      source: "bitget",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to fetch Bitget market data",
    });
  }
}
