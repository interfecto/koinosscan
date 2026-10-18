// Exact decimal strings from integer token amounts, no floating point anywhere.

// GeckoTerminal reads up to 50 decimal places
export const PRICE_DECIMALS = 50;

export function formatUnits(value, decimals) {
  if (typeof value !== 'bigint') throw new TypeError('formatUnits expects a bigint');
  if (value < 0n) throw new RangeError('formatUnits expects a non-negative amount');
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError('invalid decimals');
  if (decimals === 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

// price of asset0 quoted in asset1: (amount1 / 10^d1) / (amount0 / 10^d0), truncated to PRICE_DECIMALS.
// null if an amount is zero or the price is below 10^-PRICE_DECIMALS (GeckoTerminal halts on priceNative = 0)
export function priceNative(amount0, decimals0, amount1, decimals1) {
  if (amount0 <= 0n || amount1 <= 0n) return null;
  const numerator = amount1 * 10n ** BigInt(decimals0 + PRICE_DECIMALS);
  const denominator = amount0 * 10n ** BigInt(decimals1);
  const scaled = numerator / denominator;
  if (scaled === 0n) return null;
  return formatUnits(scaled, PRICE_DECIMALS);
}

// share of an amount in basis points, exact: amount * bps / 10000
export function formatBps(amount, bps, decimals) {
  return formatUnits(amount * BigInt(bps), decimals + 4);
}
