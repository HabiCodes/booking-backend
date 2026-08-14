/**
 * CancellationService — Phase 1 of the cancellation/refund architecture.
 *
 * Flow:
 *   1. Customer submits cancellation request
 *   2. System calculates refund policy (global slabs)
 *   3. Freezes the calculated refund percentage + amount
 *   4. Persists the immutable decision
 *   5. Returns the cancellation request in PENDING status
 *
 * Cashfree refund execution is NOT part of this service (Phase 2).
 */

import { withTransaction } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { bookingRepository } from '../repositories/bookingRepository';
import { refundPolicyRepository, RefundPolicyRepository } from '../repositories/refundPolicyRepository';
import { cancellationRequestRepository, CancellationRequestRepository } from '../repositories/cancellationRequestRepository';
import { manualPaymentRepository } from '../repositories/manualPaymentRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { eventRepository } from '../repositories/eventRepository';
import { calculateRefundFinancials } from '../services/financialCalculator';
import type { BookingFinancialBreakdown, CancellationApprovalInput, CancellationRequestStatus, ManualPaymentCreateInput } from '../types';

/**
 * Result of creating a cancellation request.
 */
export interface CreateCancellationRequestResult {
  cancellationRequestId: number;
  bookingId: number;
  calculatedRefundPercentage: number;
  calculatedRefundAmountPaise: number;
  hoursBeforeEvent: number;
  policyId: number | null;
}

/**
 * Result of approving a cancellation request.
 */
export interface ApproveCancellationResult {
  cancellationRequestId: number;
  approvedRefundPercentage: number;
  approvedRefundAmountPaise: number;
  status: string;
  /** True when approved amount is 0 and no refund row was created */
  zeroRefund: boolean;
}

export class CancellationService {
  /**
   * Create a cancellation request for a booking.
   *
   * All steps execute inside a single transaction. If any step fails,
   * the transaction rolls back — no partial cancellation request is created.
   */
  async createCancellationRequest(
    userId: number,
    bookingId: number,
    reason?: string
  ): Promise<CreateCancellationRequestResult> {
    // ── Fetch the booking snapshot (locked for update) ──────────────────────
    const result = await withTransaction(async (client) => {
      const bookingLock = await client.query(
        `SELECT * FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [bookingId, userId]
      );

      const booking = (bookingLock.rows as unknown as Array<{
        id: number;
        status: string;
        event_id: number;
        payment_order_id: number | null;
        ticket_count: number;
        organization_id: number;
      }>)[0];

      if (!booking) {
        throw new AppError('Booking not found', 404);
      }

      if (booking.status === 'cancelled') {
        throw new AppError('Booking is already cancelled', 400);
      }

      if (booking.status === 'attended') {
        throw new AppError('Cannot cancel a booking that has already been attended', 400);
      }

      if (!booking.payment_order_id) {
        throw new AppError('No payment order found for this booking', 400);
      }

      // ── Check event cancellation window ──────────────────────────────────
      const event = await eventRepository.getEventById(booking.event_id);
      if (event?.cancellable_until && new Date() > new Date(event.cancellable_until)) {
        throw new AppError(
          'This booking is past the cancellation window and cannot be cancelled for a refund.',
          403
        );
      }

      // ── Prevent duplicate cancellation requests ───────────────────────────
      const existing = await cancellationRequestRepository.findByBookingId(bookingId, client);
      if (existing) {
        throw new AppError(
          'A cancellation request already exists for this booking',
          409
        );
      }

      // ── Fetch the payment order for amount ────────────────────────────────
      const paymentOrder = await paymentOrderRepository.findById(booking.payment_order_id);
      if (!paymentOrder) {
        throw new AppError('Payment order not found for this booking', 404);
      }

      // ── Fetch the event start time ───────────────────────────────────────
      const eventForTime = await eventRepository.getEventById(booking.event_id);
      if (!eventForTime) {
        throw new AppError('Event not found', 404);
      }

      const eventStart = new Date(eventForTime.start_at);
      const requestedAt = new Date();
      const hoursRemaining = (eventStart.getTime() - requestedAt.getTime()) / (1000 * 60 * 60);

      // ── Match the applicable refund slab ─────────────────────────────────
      // Find the active global policy with the largest hours_before <= hoursRemaining
      const matchingPolicy = await refundPolicyRepository.findMatchingSlab(hoursRemaining, client);

      const policyId = matchingPolicy?.id ?? null;
      const refundPercentage = matchingPolicy
        ? RefundPolicyRepository.refundPercentage(matchingPolicy)
        : 0; // No matching slab → 0%

      // ── Calculate the refund amount using existing financial logic ─────────
      const grossAmountPaise = parseInt(paymentOrder.amount, 10);
      const configSnapshot: Record<string, unknown> = {}; // Use empty snapshot; cancellation_fee not applied here

      const refundBreakdown = calculateRefundFinancials({
        originalBreakdown: {
          gross_amount_paise: grossAmountPaise,
          currency: 'INR',
          platform_fee_paise: 0,
          gst_on_platform_fee_paise: 0,
          commission_paise: 0,
          tds_paise: 0,
          cancellation_fee_paise: 0,
          coupon_discount_paise: 0,
          net_payable_to_business_paise: 0,
          total_customer_charged_paise: 0,
          config_snapshot: configSnapshot,
        },
        refund_percentage: refundPercentage,
      });

      const refundAmountPaise = refundBreakdown.refund_amount_paise;

      // ── Persist the immutable decision ───────────────────────────────────
      const cancellationRequest = await cancellationRequestRepository.create(
        {
          booking_id: bookingId,
          payment_order_id: booking.payment_order_id,
          organization_id: booking.organization_id,
          requested_by: userId,
          reason: reason ?? null,
          hours_before_event: Math.max(0, hoursRemaining),
          policy_id: policyId,
          calculated_refund_percentage: refundPercentage,
          calculated_refund_amount_paise: refundAmountPaise,
        },
        client
      );

      return {
        cancellationRequestId: cancellationRequest.id,
        bookingId,
        calculatedRefundPercentage: refundPercentage,
        calculatedRefundAmountPaise: refundAmountPaise,
        hoursBeforeEvent: Math.max(0, hoursRemaining),
        policyId,
      };
    });

    return result;
  }

  /**
   * Super Admin approves a cancellation request.
   *
   * - If no override percentage is provided, uses the calculated percentage.
   * - If override percentage is provided, it may be UP or DOWN from calculated.
   * - The approved refund amount is recalculated from the FROZEN gross amount
   *   of the booking's payment order. The frozen refund policy is never
   *   re-applied — only the approved_percentage drives the new amount.
   *
   * RACE SAFETY: Locks the cancellation row with SELECT … FOR UPDATE inside
   * the transaction. Two concurrent approvals result in one successful
   * APPROVED and the second attempt receives a 409.
   */
  async approveCancellationRequest(
    requestId: number,
    approval: CancellationApprovalInput
  ): Promise<ApproveCancellationResult> {
    return await withTransaction(async (client) => {
      // ── Lock the row for update inside this transaction ────────────────
      const existing = await cancellationRequestRepository.findByIdForUpdate(
        requestId,
        client
      );
      if (!existing) {
        throw new AppError('Cancellation request not found', 404);
      }
      if (existing.status !== 'PENDING') {
        throw new AppError(
          `Cancellation request is already ${existing.status}`,
          409
        );
      }

      // ── Resolve the percentage ─────────────────────────────────────────
      let approvedPercentage: number;
      if (approval.approved_percentage !== undefined) {
        approvedPercentage = approval.approved_percentage;
        if (approvedPercentage < 0 || approvedPercentage > 100) {
          throw new AppError('Override percentage must be between 0 and 100', 400);
        }
      } else {
        approvedPercentage = CancellationRequestRepository.calculatedPercentage(existing);
      }

      // ── Recalculate the refund amount from the FROZEN gross amount ─────
      const paymentOrderId = existing.payment_order_id;
      const paymentOrder = await paymentOrderRepository.findById(paymentOrderId);
      if (!paymentOrder) {
        throw new AppError('Payment order not found', 404);
      }

      const grossAmountPaise = parseInt(paymentOrder.amount, 10);
      const refundBreakdown = calculateRefundFinancials({
        originalBreakdown: {
          gross_amount_paise: grossAmountPaise,
          currency: 'INR',
          platform_fee_paise: 0,
          gst_on_platform_fee_paise: 0,
          commission_paise: 0,
          tds_paise: 0,
          cancellation_fee_paise: 0,
          coupon_discount_paise: 0,
          net_payable_to_business_paise: 0,
          total_customer_charged_paise: 0,
          config_snapshot: {},
        },
        refund_percentage: approvedPercentage,
      });

      const approvedAmountPaise = refundBreakdown.refund_amount_paise;
      const zeroRefund = approvedAmountPaise === 0;

      // ── Race-safe UPDATE; WHERE status='PENDING' keeps second attempt a no-op
      const updatedRequest = await cancellationRequestRepository.approve(
        requestId,
        {
          admin_id: approval.admin_id,
          override_reason: approval.override_reason ?? null,
        },
        approvedPercentage,
        approvedAmountPaise,
        client
      );

      if (!updatedRequest) {
        throw new AppError(
          'Failed to approve — request was concurrently modified',
          409
        );
      }

      return {
        cancellationRequestId: updatedRequest.id,
        approvedRefundPercentage: approvedPercentage,
        approvedRefundAmountPaise: approvedAmountPaise,
        status: updatedRequest.status,
        zeroRefund,
      };
    });
  }

  /**
   * Super Admin rejects a cancellation request.
   * Booking stays confirmed; no refund is issued.
   *
   * RACE SAFETY: Same FOR UPDATE pattern as approval.
   */
  async rejectCancellationRequest(
    requestId: number,
    input: { admin_id: number; rejection_reason?: string | null }
  ): Promise<void> {
    await withTransaction(async (client) => {
      const existing = await cancellationRequestRepository.findByIdForUpdate(
        requestId,
        client
      );
      if (!existing) {
        throw new AppError('Cancellation request not found', 404);
      }
      if (existing.status !== 'PENDING') {
        throw new AppError(
          `Cancellation request is already ${existing.status}`,
          409
        );
      }

      const updated = await cancellationRequestRepository.reject(
        requestId,
        {
          admin_id: input.admin_id,
          rejection_reason: input.rejection_reason ?? null,
        },
        client
      );

      if (!updated) {
        throw new AppError('Failed to reject — request was concurrently modified', 409);
      }
    });
  }

  /**
   * APPROVED → READY_FOR_MANUAL_PAYMENT.
   *
   * Called when the admin is ready to record a manual UPI payment. Does NOT
   * issue any payment — just unlocks the cancellation request for the
   * manual payment step.
   *
   * For zero-amount approvals, this method is NOT called: those remain
   * finalized in APPROVED status with no further transitions.
   */
  async transitionToReadyForPayment(requestId: number): Promise<CancellationRequestStatus> {
    return await withTransaction(async (client) => {
      const existing = await cancellationRequestRepository.findByIdForUpdate(
        requestId,
        client
      );
      if (!existing) {
        throw new AppError('Cancellation request not found', 404);
      }
      if (existing.status !== 'APPROVED') {
        throw new AppError(
          `Cancellation request must be APPROVED, currently ${existing.status}`,
          409
        );
      }

      const approvedAmount = CancellationRequestRepository.approvedAmountPaise(existing) ?? 0;
      if (approvedAmount === 0) {
        throw new AppError(
          'Zero-refund approvals do not require manual payment',
          400
        );
      }

      const updated = await cancellationRequestRepository.transitionToReadyForPayment(
        requestId,
        client
      );
      if (!updated) {
        throw new AppError(
          'Failed to transition — request was concurrently modified',
          409
        );
      }
      return updated.status;
    });
  }

  /**
   * READY_FOR_MANUAL_PAYMENT → PAID.
   * Records the manual payment and transitions the cancellation request
   * atomically. If either operation fails (e.g. duplicate manual payment
   * row, unique constraint violation), the transaction rolls back and the
   * cancellation request stays in READY_FOR_MANUAL_PAYMENT.
   */
  async recordManualPayment(
    requestId: number,
    input: { admin_id: number; customer_upi_id: string; transaction_ref_id: string; payment_date: string }
  ): Promise<{ cancellationRequestId: number; manualPaymentId: number; status: CancellationRequestStatus }> {
    // Look up the approved amount to ensure the recorded payment matches.
    const existing = await cancellationRequestRepository.findById(requestId);
    if (!existing) {
      throw new AppError('Cancellation request not found', 404);
    }

    const approvedAmountPaise =
      CancellationRequestRepository.approvedAmountPaise(existing) ?? 0;

    return await withTransaction(async (client) => {
      // Lock the cancellation request row inside this transaction
      const locked = await cancellationRequestRepository.findByIdForUpdate(
        requestId,
        client
      );
      if (!locked) {
        throw new AppError('Cancellation request not found', 404);
      }
      if (locked.status !== 'READY_FOR_MANUAL_PAYMENT') {
        throw new AppError(
          `Cancellation request must be READY_FOR_MANUAL_PAYMENT, currently ${locked.status}`,
          409
        );
      }
      if (approvedAmountPaise === 0) {
        throw new AppError(
          'Zero-refund approvals do not require a manual payment record',
          400
        );
      }

      // Insert the manual payment row inside the same transaction.
      // The UNIQUE INDEX on cancellation_request_id will fail on a second
      // concurrent INSERT, aborting the transaction.
      const manualPayment = await manualPaymentRepository.create(
        {
          cancellation_request_id: requestId,
          customer_upi_id: input.customer_upi_id,
          amount_paise: approvedAmountPaise,
          transaction_ref_id: input.transaction_ref_id,
          payment_date: input.payment_date,
          created_by_admin_id: input.admin_id,
        },
        client
      );

      // Transition the cancellation request to PAID. The unique constraint
      // would have caused the transaction to abort above if a duplicate
      // manual payment was attempted, but the WHERE status guard also
      // protects against status transitions that race past one another.
      const updated = await cancellationRequestRepository.markAsPaid(requestId, client);
      if (!updated) {
        throw new AppError(
          'Failed to mark as paid — request was concurrently modified',
          409
        );
      }

      return {
        cancellationRequestId: updated.id,
        manualPaymentId: manualPayment.id,
        status: updated.status,
      };
    });
  }
}

export const cancellationService = new CancellationService();
