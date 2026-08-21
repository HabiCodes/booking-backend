/**
 * Cashfree Payment Gateway Implementation.
 *
 * Implements the IPaymentGateway interface for Cashfree's Payment Gateway API.
 *
 * API Docs: https://dev.cashfree.com/payment-gateway
 *
 * Credentials are loaded from config (Cashfree APP ID + Secret Key).
 * The service is read-only regarding credentials — they never leave the server.
 */

import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import type { AppConfig } from '../config';
import type { IPaymentGateway, CreateOrderResult, PollPaymentResult, VerifyPaymentResult, RefundResult } from './paymentGateway';
import type { PaymentOrderRow, PaymentOrderStatus, RefundRow } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const CF_API_BASE = 'https://api.cashfree.com/pg';
const CF_VERSION = '2022-09-01';

// ── Service ───────────────────────────────────────────────────────────────────

export class CashfreePaymentGateway implements IPaymentGateway {
  readonly name = 'cashfree';

  constructor(private readonly config: AppConfig['cashfree']) {}

  /**
   * Step 1: Create an order on Cashfree.
   * POST /pg/orders
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
    const appId = this.config.appId;
    const secretKey = this.config.secretKey;

    if (!appId || !secretKey) {
      throw new AppError('Cashfree credentials not configured', 500);
    }

    const orderPayload = {
      order_id: input.orderId,
      order_amount: input.amount,
      order_currency: input.currency,
      customer_details: {
        customer_id: `cust_${input.bookingId}`,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        customer_phone: input.customerPhone,
      },
      order_meta: {
        // return_url: browser redirect after payment — path appended to the app base
        return_url: `${this.config.returnUrl || 'http://localhost:3001'}/booking/${input.bookingId}/success`,
        // notify_url: full webhook URL from CASHFREE_NOTIFY_URL env var.
        // Only included when set — Cashfree falls back to their dashboard-configured
        // webhook URL when absent. The value should be the deployed endpoint, e.g.
        // https://your-app.onrender.com/api/v1/turf/webhooks/cashfree
        ...(this.config.notifyUrl ? { notify_url: this.config.notifyUrl } : {}),
        ...input.metadata,
      },
    };

    try {
      const response = await fetch(`${CF_API_BASE}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': appId,
          'x-client-secret': secretKey,
          'x-api-version': CF_VERSION,
        },
        body: JSON.stringify(orderPayload),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok || (data as { status: string }).status === 'ERROR') {
        throw new AppError(
          (data as { message: string }).message || `Cashfree order creation failed (${response.status})`,
          502
        );
      }

      logger.info('Cashfree order created', { orderId: input.orderId, cfOrderId: (data as { order_id: string }).order_id });

      return {
        order: {
          // We return a minimal order; the caller should persist the DB row before returning
          id: 0,
          order_id: input.orderId,
          booking_id: input.bookingId,
          organization_id: (input.metadata?.organization_id as number) || 0,
          event_id: (input.metadata?.event_id as number) || 0,
          amount: String(input.amount),
          currency: input.currency,
          cf_payment_id: null,
          cf_order_token: (data as { order_token: string }).order_token || null,
          cf_payment_session_id: (data as { payment_session_id: string }).payment_session_id || null,
          cf_authorization_id: null,
          status: 'CREATED',
          payment_method: null,
          payment_gateway: 'cashfree',
          error_code: null,
          error_message: null,
          verified_at: null,
          verified_by: null,
          idempotency_key: null,
          retry_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as PaymentOrderRow,
        gatewayResponse: {
          payment_session_id: (data as { payment_session_id: string }).payment_session_id || '',
          order_id: (data as { order_id: string }).order_id,
          payment_link: (data as { payment_link: string }).payment_link,
          expires_at: (data as { order_expiry_time: string }).order_expiry_time,
        },
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Cashfree API error: ${(err as Error).message}`, 502);
    }
  }

  /**
   * Step 2: Verify a payment after user returns from Cashfree.
   * GET /pg/orders/{orderId}
   */
  async verifyPayment(orderId: string, _payload: Record<string, unknown>): Promise<VerifyPaymentResult> {
    const appId = this.config.appId;
    const secretKey = this.config.secretKey;

    if (!appId || !secretKey) {
      throw new AppError('Cashfree credentials not configured', 500);
    }

    try {
      const response = await fetch(`${CF_API_BASE}/orders/${encodeURIComponent(orderId)}`, {
        method: 'GET',
        headers: {
          'x-client-id': appId,
          'x-client-secret': secretKey,
          'x-api-version': CF_VERSION,
        },
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new AppError(`Cashfree verification failed (${response.status})`, 502);
      }

      const orderStatus = (data as { order_status: string }).order_status;
      let mappedStatus: PaymentOrderStatus = 'FAILED';
      if (orderStatus === 'ACTIVE') mappedStatus = 'ACTIVE';
      else if (orderStatus === 'COMPLETED') mappedStatus = 'COMPLETED';
      else if (orderStatus === 'FAILED' || orderStatus === 'EXPIRED' || orderStatus === 'CANCELLED') {
        mappedStatus = orderStatus as PaymentOrderStatus;
      }

      const paymentSessions = (data as { payment_details: Array<{ cf_payment_id: string; payment_status: string; payment_amount: number; payment_method: string }> }).payment_details || [];
      const firstPayment = paymentSessions[0];

      return {
        success: mappedStatus === 'COMPLETED',
        paymentId: firstPayment?.cf_payment_id || '',
        status: mappedStatus,
        signatureValid: true,
        amountPaid: firstPayment?.payment_amount || 0,
        paymentMethod: firstPayment?.payment_method || '',
        errorCode: mappedStatus === 'FAILED' ? (data as { order_error_details: { error_code: string } }).order_error_details?.error_code : undefined,
        errorMessage: mappedStatus === 'FAILED' ? (data as { order_error_details: { error_message: string } }).order_error_details?.error_message : undefined,
        gatewayResponse: data,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Cashfree verify error: ${(err as Error).message}`, 502);
    }
  }

  /**
   * Step 3: Initiate a refund.
   * POST /pg/orders/{orderId}/refunds
   */
  async createRefund(input: { orderId: string; amount: number; reason?: string }): Promise<RefundResult> {
    const appId = this.config.appId;
    const secretKey = this.config.secretKey;

    if (!appId || !secretKey) {
      throw new AppError('Cashfree credentials not configured', 500);
    }

    try {
      const payload: Record<string, unknown> = { refund_amount: input.amount };
      if (input.reason) payload.refund_note = input.reason;

      const response = await fetch(`${CF_API_BASE}/orders/${encodeURIComponent(input.orderId)}/refunds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': appId,
          'x-client-secret': secretKey,
          'x-api-version': CF_VERSION,
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new AppError(`Cashfree refund failed (${response.status})`, 502);
      }

      const refundStatus = (data as { refund_status: string }).refund_status;

      return {
        refund: {
          id: 0,
          payment_order_id: 0,
          booking_id: 0,
          cf_refund_id: (data as { refund_id: string }).refund_id || null,
          cf_refund_status: refundStatus,
          amount: String(input.amount),
          currency: 'INR',
          reason: input.reason || null,
          refund_type: 'admin_initiated',
          status: refundStatus === 'SUCCESS' ? 'SUCCESS' : refundStatus === 'FAILED' ? 'FAILED' : 'PROCESSING',
          created_by_admin_id: null,
          created_by_user_id: null,
          processed_at: refundStatus === 'SUCCESS' ? new Date().toISOString() : null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as RefundRow,
        gatewayRefundId: (data as { refund_id: string }).refund_id || '',
        status: refundStatus === 'SUCCESS' ? 'SUCCESS' : refundStatus === 'FAILED' ? 'FAILED' : 'PROCESSING',
        estimatedAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        gatewayResponse: data,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Cashfree refund error: ${(err as Error).message}`, 502);
    }
  }

  /**
   * Poll the gateway for the current status of an order.
   */
  async pollPaymentStatus(orderId: string): Promise<PollPaymentResult> {
    const verifyResult = await this.verifyPayment(orderId, {});
    return {
      status: verifyResult.status,
      paymentId: verifyResult.paymentId || null,
      errorCode: verifyResult.errorCode || null,
      gatewayResponse: verifyResult.gatewayResponse,
    };
  }

  /**
   * Verify Cashfree webhook HMAC signature.
   * Cashfree sends a `x-cashfree-signature` header with HMAC-SHA256 of the body.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.config.webhookSecret) return false;
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}
