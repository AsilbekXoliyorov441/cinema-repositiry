/**
 * Money helpers. All amounts are integers in the currency's minor unit (cents, tiyin...).
 * Never use floating point for money arithmetic.
 */

/** ISO 4217 currencies without a minor unit (amount 1 = 1 whole unit). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'UGX', 'RWF', 'PYG']);

export function minorUnitDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function formatMoney(amountMinor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

/** Percent discount on integer minor units, rounded half-up, never exceeding the amount. */
export function percentOf(amountMinor: number, percent: number): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) throw new Error('amount must be a non-negative integer');
  if (percent < 0 || percent > 100) throw new Error('percent must be between 0 and 100');
  return Math.min(amountMinor, Math.floor((amountMinor * percent + 50) / 100));
}
