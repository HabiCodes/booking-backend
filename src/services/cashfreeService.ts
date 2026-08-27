/**
 * ⚠️  DEPRECATED — Cashfree has been removed.
 *
 * This file no longer contains a Cashfree implementation.
 * All payment provider interactions go through:
 *   - src/services/federalBankProvider.ts (Federal Bank adapter)
 *   - src/services/paymentService.ts (universal orchestrator)
 *   - src/services/paymentGateway.ts (IPaymentGateway interface)
 *
 * The CashfreePaymentGateway class has been removed.
 * Use FederalBankPaymentProvider instead.
 *
 * Migration 020 payment_orders table retains the data schema but column
 * names have been updated to provider-agnostic names (see types/index.ts).
 */

export {}; // Keep as a valid module to prevent import errors during transition
