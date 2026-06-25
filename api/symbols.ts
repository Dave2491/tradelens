const BITGET_BASE_URL = "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

async function bitget(path: string) {
  const response = await fetch(`${BITGET_BASE_URL}${path}`);
  const payload = await response.json();

  if (!response.ok || (payload.code && payload.code !== "00000")) {
    throw new Error(payload.msg ?? `Bitget request failed with ${response.status}`);
  }

  return payload.data;
}

export default async function handler(_request: unknown, response: VercelResponse) {
  try {
    const contracts = await bitget(`/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`);

    response.status(200).json({
      symbols: contracts,
      productType: PRODUCT_TYPE,
      source: "bitget",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to fetch Bitget market symbols",
    });
  }
}
