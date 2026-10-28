import express, { Router } from 'express';
import { logger } from '../../config/logger.js';
import { openApiRegistry } from '../../docs/openapi-registry.js';
import { env } from '../../config/env.js';
import { getPaymentProvider } from '../../integrations/payments/index.js';
import { billingEventsService } from './billing-events.service.js';

/**
 * Provider webhooks. Mounted before express.json() because signature verification needs the exact raw bytes.
 * Responses: 200 processed/duplicate/ignored · 400 bad signature · 500 processing error (provider retries).
 */
export function createWebhookRouter(): Router {
  const router = Router();
  router.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const provider = getPaymentProvider();
    const event = await provider.parseWebhook(req.body as Buffer, req.headers);
    const result = await billingEventsService.process(provider.name, event);
    logger.info({ eventId: event.id, type: event.type, result }, 'Webhook handled');
    res.status(200).json({ received: true, result });
  });
  return router;
}

openApiRegistry.add({
  method: 'post',
  path: `${env.API_PREFIX}/webhooks/stripe`,
  tags: ['Webhooks'],
  summary: 'Stripe webhook endpoint',
  description:
    'Server-to-server only. The `Stripe-Signature` header is verified against STRIPE_WEBHOOK_SECRET; ' +
    'each event id is processed exactly once. Subscribe to: checkout.session.completed, checkout.session.expired, invoice.paid, ' +
    'invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted, charge.refunded, charge.dispute.created.',
  auth: 'public',
  permissions: [],
  bodyContentType: 'application/json',
  multipartSchema: { type: 'object', description: 'Raw Stripe event JSON' },
  response: null,
  responseStatus: 200,
  paginated: false,
  errors: [400, 503],
  extraSecurity: [{ stripeSignature: [] }],
  rawResponse: { contentType: 'application/json', description: '{ received: true, result: "processed" | "duplicate" | "ignored" }' },
});
