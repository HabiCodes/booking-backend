"use strict";
/**
 * Payment Gateway Abstraction Layer.
 *
 * Implement this interface for any payment provider (Cashfree, Razorpay, Stripe, mock).
 * The PaymentService delegates all provider-specific operations to a gateway instance.
 *
 * This is mock-ready by design — pass a MockPaymentGateway in tests or dev mode.
 */
Object.defineProperty(exports, "__esModule", { value: true });
