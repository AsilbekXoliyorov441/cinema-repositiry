import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import type { PaymentProvider } from './payment-provider.types.js';
import { StripePaymentProvider } from './stripe.provider.js';

let provider: PaymentProvider | null =
  env.PAYMENT_PROVIDER === 'stripe' ? new StripePaymentProvider(env.STRIPE_SECRET_KEY as string, env.STRIPE_WEBHOOK_SECRET as string) : null;

/** Returns the configured provider or a 503 explaining that payments are not configured. */
export function getPaymentProvider(): PaymentProvider {
  if (!provider) throw AppError.payment('Payments are not configured on this server', ErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, 503);
  return provider;
}

export function isPaymentsEnabled(): boolean {
  return provider !== null;
}

/** Test seam: lets integration tests substitute provider API calls (signature checks stay real). */
export function setPaymentProvider(p: PaymentProvider | null): void {
  provider = p;
}

export type { PaymentProvider } from './payment-provider.types.js';
