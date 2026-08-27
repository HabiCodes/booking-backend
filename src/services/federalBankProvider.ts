/**
 * Federal Bank Payment Provider Adapter
 *
 * This adapter implements IPaymentGateway for Federal Bank's payment gateway.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * STOP — DO NOT IMPLEMENT API CALLS WITHOUT OFFICIAL DOCUMENTATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Before implementing the actual Federal Bank API calls, you MUST obtain:
 *
 *   1. Official API base URL(s) (sandbox + production)
 *   2. Authentication method (API key header name, signing algorithm, etc.)
 *   3. Endpoint paths and request/response schemas for:
 *        - Create Order
 *        - Verify Payment / Get Order Status
 *        - Create Refund
 *        - Poll Payment Status
 *   4. Webhook:
 *        - Exact header name(s) for the signature
 *        - HMAC key derivation (is it the merchant key? a separate webhook secret?)
 *        - Exact algorithm (HMAC-SHA256? HMAC-SHA512?)
 *        - Payload structure (raw body vs parsed JSON for signing)
 *        - Event type field name and values
 *        - Timestamp/signature separate headers vs single header
 *   5. Idempotency key format and header name
 *   6. Currency codes supported
 *   7. Timeout and retry recommendations
 *   8. Error code taxonomy (so we can map to our PaymentOrderStatus)
 *
 * This file currently contains:
 *   - The interface contract (IPaymentGateway)
 *   - Structured type mappings for Federal Bank fields (placeholder names)
 *   - Proper error handling scaffolding
 *
 * The provider returns AppError with 500/'not configured' for all operations
 * until real API specs are integrated.
 */

import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import type { AppConfig } from '../config';
import type { IPaymentGateway, CreateOrderResult, PollPaymentResult, VerifyPaymentResult, RefundResult } from './paymentGateway';
import type { PaymentOrderRow, PaymentOrderStatus, RefundRow } from '../types';

// ══════════════════════════════════════════════════════════════════════════════
// Configuration keys — update these from Federal Bank documentation
// ══════════════════════════════════════════════════════════════════════════════

const PROVIDER_API_BASE = process.env.PAYMENT_PROVIDER_API_BASE || '';
const PROVIDER_VERSION = 'v1'; // Update per Federal Bank spec

// ══════════════════════════════════════════════════════════════════════════════
// Status mapping — update these from Federal Bank's documented status values
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Map Federal Bank order status strings → our internal PaymentOrderStatus.
 * These are PLACEHOLDER values — replace with Federal Bank's actual status strings.
 */
const FB_ORDER_STATUS_MAP: Record<string, PaymentOrderStatus> = {
  // Placeholder — replace with Federal Bank's actual status values
  'CREATED': 'CREATED',
  'ACTIVE': 'ACTIVE',
  'PAID': 'COMPLETED',
  'FAILED': 'FAILED',
  'CANCELLED': 'CANCELLED',
  'EXPIRED': 'EXPIRED',
};

const FB_REFUND_STATUS_MAP: Record<string, RefundRow['status']> = {
  'PENDING': 'PENDING',
  'PROCESSING': 'PROCESSING',
  'SUCCESS': 'SUCCESS',
  'FAILED': 'FAILED',
};

// ══════════════════════════════════════════════════════════════════════════════
// Helper: Build auth headers from Federal Bank spec
// ══════════════════════════════════════════════════════════════════════════════

function buildAuthHeaders(config: AppConfig['paymentProvider']): Record<string, string> {
  // PLACEHOLDER — replace with Federal Bank's actual auth header scheme.
  // Examples of what Federal Bank MIGHT use (do NOT implement without docs):
  //   - Authorization: Bearer <api_key>
  //   - X-Merchant-Id: <merchant_id>
  //   - X-API-Key: <api_key>
  //   - Custom header per their spec
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.merchantId) {
    headers['X-Merchant-Id'] = config.merchantId;
  }

  // PLACEHOLDER: Add actual Federal Bank auth header here
  // Example (DO NOT USE without docs):
  // headers['Authorization'] = `Bearer ${config.merchantKey}`;
  // headers['X-API-Version'] = PROVIDER_VERSION;

  return headers;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helper: Build the canonical payment session payload
// ══════════════════════════════════════════════════════════════════════════════

interface CreateOrderPayload {
  merchantId: string;
  orderId: string;
  amount: number;
  currency: string;
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string;
  };
  returnUrl: string;
  notifyUrl?: string;
  metadata?: Record<string, unknown>;
}

function buildCreateOrderPayload(input: {
  bookingId: number;
  amount: number;
  currency: string;
  orderId: string;
  customerEmail: string;
  customerPhone: string;
  customerName: string;
}): CreateOrderPayload {
  // PLACEHOLDER payload structure — replace with Federal Bank's schema
  return {
    merchantId: '', // Will be set from config
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    customer: {
      id: `cust_${input.bookingId}`,
      name: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone,
    },
    returnUrl: '', // Will be set from config
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Service
// ══════════════════════════════════════════════════════════════════════════════

export class FederalBankPaymentProvider implements IPaymentGateway {
  readonly name = 'federal_bank';

  constructor(private readonly config: AppConfig['paymentProvider']) {}

  /**
   * Step 1: Create a payment order with Federal Bank.
   *
   * PLACEHOLDER — implement using Federal Bank API documentation.
   */
  async createOrder(input: {
    bookingId: number;
    amount: number;
    currency: string;
    orderId: string;
    customerEmail: string;
    customerPhone: string;
    customerName: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreateOrderResult> {
    if (!this.config.merchantId || !this.config.merchantKey) {
      throw new AppError('Federal Bank credentials not configured', 500);
    }

    if (!PROVIDER_API_BASE) {
      logger.warn('[FederalBank] API base URL not configured — stub mode');
      throw new AppError('Payment provider not configured. Set PAYMENT_PROVIDER_API_BASE.', 500);
    }

    // ── Build request (placeholder structure) ─────────────────────────────
    // PLACEHOLDER: Replace with Federal Bank's actual request schema
    const payload = buildCreateOrderPayload(input);

    logger.info('[FederalBank] createOrder called', {
      orderId: input.orderId,
      bookingId: input.bookingId,
      amount: input.amount,
      // DO NOT log credentials
    });

    // PLACEHOLDER: Actual HTTP call would go here
    // const response = await fetch(`${PROVIDER_API_BASE}/orders`, {
    //   method: 'POST',
    //   headers: buildAuthHeaders(this.config),
    //   body: JSON.stringify(payload),
    // });
    // ...parse response per Federal Bank's schema...

    // Until real implementation, throw to signal stub mode
    throw new AppError('Federal Bank API integration pending — awaiting official documentation', 501);
  }

  /**
   * Step 2: Verify a payment with Federal Bank.
   *
   * PLACEHOLDER — implement using Federal Bank API documentation.
   */
  async verifyPayment(orderId: string, _payload: Record<string, unknown>): Promise<VerifyPaymentResult> {
    if (!this.config.merchantId || !this.config.merchantKey) {
      throw new AppError('Federal Bank credentials not configured', 500);
    }

    if (!PROVIDER_API_BASE) {
      logger.warn('[FederalBank] API base URL not configured — stub mode');
      throw new AppError('Payment provider not configured. Set PAYMENT_PROVIDER_API_BASE.', 500);
    }

    logger.info('[FederalBank] verifyPayment called', { orderId });

    // PLACEHOLDER: Actual HTTP call would go here
    throw new AppError('Federal Bank API integration pending — awaiting official documentation', 501);
  }

  /**
   * Step 3: Initiate a refund with Federal Bank.
   *
   * PLACEHOLDER — implement using Federal Bank API documentation.
   */
  async createRefund(input: { orderId: string; amount: number; reason?: string }): Promise<RefundResult> {
    if (!this.config.merchantId || !this.config.merchantKey) {
      throw new AppError('Federal Bank credentials not configured', 500);
    }

    if (!PROVIDER_API_BASE) {
      logger.warn('[FederalBank] API base URL not configured — stub mode');
      throw new AppError('Payment provider not configured. Set PAYMENT_PROVIDER_API_BASE.', 500);
    }

    logger.info('[FederalBank] createRefund called', { orderId: input.orderId, amount: input.amount });

    // PLACEHOLDER: Actual HTTP call would go here
    throw new AppError('Federal Bank API integration pending — awaiting official documentation', 501);
  }

  /**
   * Poll the gateway for the current status of an order.
   *
   * PLACEHOLDER — implement using Federal Bank API documentation.
   */
  async pollPaymentStatus(orderId: string): Promise<PollPaymentResult> {
    if (!PROVIDER_API_BASE) {
      throw new AppError('Payment provider not configured', 500);
    }

    logger.info('[FederalBank] pollPaymentStatus called', { orderId });

    // PLACEHOLDER: Actual HTTP call would go here
    throw new AppError('Federal Bank API integration pending — awaiting official documentation', 501);
  }

  /**
   * Verify Federal Bank webhook HMAC signature.
   *
   * PLACEHOLDER — implement using Federal Bank's documented signature scheme.
   * Key questions to answer from Federal Bank docs:
   *   1. Which header name carries the signature?
   *   2. What is the exact signing algorithm?
   *   3. Is the raw body or parsed JSON used for signing?
   *   4. Is there a separate timestamp header for replay protection?
   *   5. What is the exact HMAC key (webhook secret vs merchant key)?
   */
  verifyWebhookSignature(payload: string, signature: string, _timestamp?: string): boolean {
    if (!this.config.webhookSecret) return false;

    // PLACEHOLDER: Replace with Federal Bank's actual signature verification
    // Example HMAC-SHA256 (DO NOT USE without confirming with Federal Bank docs):
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;

    return crypto.timingSafeEqual(sigBuf, expBuf);
  }
}
