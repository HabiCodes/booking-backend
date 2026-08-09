/**
 * Payment Gateway Abstraction Layer.
 *
 * Implement this interface for any payment provider (Cashfree, Razorpay, Stripe, mock).
 * The PaymentService delegates all provider-specific operations to a gateway instance.
 *
 * This is mock-ready by design — pass a MockPaymentGateway in tests or dev mode.
 */

import type {
  PaymentOrderRow,
  PaymentOrderCreateInput,
  PaymentOrderPublic,
  PaymentOrderStatus,
  RefundRow,
  RefundCreateInput,
  RefundPublic,
} from '../types';

export type { PaymentOrderRow, PaymentOrderStatus, RefundRow } from '../types';

// ── Types returned by all gateway operations ──────────────────────────────────

export interface CreateOrderResult {
  order: PaymentOrderRow;
  gatewayResponse: {
    payment_session_id: string;
    order_id: string;
    payment_link?: string;
    expires_at: string;
  };
}

export interface VerifyPaymentResult {
  success: boolean;
  paymentId: string;
  status: PaymentOrderStatus;
  signatureValid: boolean;
  amountPaid: number;
  paymentMethod: string;
  errorCode?: string;
  errorMessage?: string;
  gatewayResponse: Record<string, unknown>;
}

export interface RefundResult {
  refund: RefundRow;
  gatewayRefundId: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
  estimatedAt: string;
  gatewayResponse: Record<string, unknown>;
}

export interface PollPaymentResult {
  status: PaymentOrderStatus;
  paymentId: string | null;
  errorCode: string | null;
  gatewayResponse: Record<string, unknown>;
}

// ── Gateway Interface ─────────────────────────────────────────────────────────

export interface IPaymentGateway {
  /**
   * Create a payment order with the gateway.
   * Returns the payment session ID that the frontend uses to open the payment modal.
   */
  createOrder(input: {
    bookingId: number;
    amount: number;
    currency: string;
    orderId: string;
    customerEmail: string;
    customerPhone: string;
    customerName: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreateOrderResult>;

  /**
   * Verify a payment notification (webhook or callback).
   * Should verify the HMAC signature if applicable.
   */
  verifyPayment(orderId: string, payload: Record<string, unknown>): Promise<VerifyPaymentResult>;

  /**
   * Initiate a refund.
   */
  createRefund(input: { orderId: string; amount: number; reason?: string }): Promise<RefundResult>;

  /**
   * Poll the gateway for the current status of an order.
   * Used for async reconciliation when webhooks are missed.
   */
  pollPaymentStatus(orderId: string): Promise<PollPaymentResult>;

  /**
   * Verify the HMAC signature of a webhook payload.
   * Returns true if the payload is authentic.
   */
  verifyWebhookSignature(payload: string, signature: string, timestamp?: string): boolean;

  /**
   * Provider name for logging/debugging.
   */
  readonly name: string;
}
