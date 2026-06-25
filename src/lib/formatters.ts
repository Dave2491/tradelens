export function usdPriceFractionDigits(value: number) {
  const absolute = Math.abs(value);
  return absolute >= 1 ? 2 : absolute >= 0.1 ? 4 : absolute >= 0.01 ? 5 : absolute >= 0.001 ? 6 : 8;
}

export function roundUsdPrice(value: number) {
  const factor = 10 ** usdPriceFractionDigits(value);
  return Math.round(value * factor) / factor;
}

export function formatUsdPrice(value: number) {
  const fractionDigits = usdPriceFractionDigits(value);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatUsdAmount(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
