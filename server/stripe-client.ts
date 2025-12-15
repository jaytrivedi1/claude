import Stripe from 'stripe';

// Environment variables for Stripe configuration
// STRIPE_SECRET_KEY - Your Stripe secret key from https://dashboard.stripe.com/apikeys
// STRIPE_WEBHOOK_SECRET - Webhook signing secret for verifying webhook events

let cachedClient: Stripe | null = null;

function getStripeSecretKey(): string {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set. Get your API key from https://dashboard.stripe.com/apikeys');
  }
  return secretKey;
}

/**
 * Get a Stripe client instance.
 * The client is cached for performance.
 */
export function getStripeClient(): Stripe {
  if (!cachedClient) {
    cachedClient = new Stripe(getStripeSecretKey(), {
      apiVersion: '2024-12-18.acacia',
      typescript: true,
    });
  }
  return cachedClient;
}

/**
 * Get the webhook signing secret for verifying Stripe webhook events.
 */
export function getStripeWebhookSecret(): string {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET environment variable is not set.');
  }
  return webhookSecret;
}

/**
 * Verify a Stripe webhook signature.
 * @param payload - Raw request body
 * @param signature - Stripe-Signature header value
 */
export function verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event {
  const client = getStripeClient();
  const webhookSecret = getStripeWebhookSecret();
  return client.webhooks.constructEvent(payload, signature, webhookSecret);
}

/**
 * Create a Stripe checkout session for invoice payment.
 * @param invoiceId - Your internal invoice ID
 * @param amount - Amount in cents
 * @param currency - Currency code (e.g., 'usd', 'cad')
 * @param customerEmail - Customer's email address
 * @param successUrl - URL to redirect after successful payment
 * @param cancelUrl - URL to redirect after cancelled payment
 */
export async function createCheckoutSession({
  invoiceId,
  amount,
  currency,
  customerEmail,
  description,
  successUrl,
  cancelUrl,
}: {
  invoiceId: number;
  amount: number;
  currency: string;
  customerEmail: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<Stripe.Checkout.Session> {
  const client = getStripeClient();

  const session = await client.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: customerEmail,
    line_items: [
      {
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: description,
          },
          unit_amount: amount, // Amount in cents
        },
        quantity: 1,
      },
    ],
    metadata: {
      invoiceId: invoiceId.toString(),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return session;
}

/**
 * Retrieve a checkout session to check payment status.
 * @param sessionId - Stripe checkout session ID
 */
export async function getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  const client = getStripeClient();
  return client.checkout.sessions.retrieve(sessionId);
}

/**
 * Create a payment intent for direct payment processing.
 * @param amount - Amount in cents
 * @param currency - Currency code
 * @param metadata - Additional metadata to attach
 */
export async function createPaymentIntent({
  amount,
  currency,
  metadata,
}: {
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.PaymentIntent> {
  const client = getStripeClient();

  return client.paymentIntents.create({
    amount,
    currency: currency.toLowerCase(),
    metadata,
  });
}
