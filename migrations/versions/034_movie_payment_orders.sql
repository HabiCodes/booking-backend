-- ============================================================================
-- Migration 034: Extend payment_orders booking_type to include 'movie'
-- ============================================================================
-- Movie domain (Phase 5) shares the existing Cashfree payment gateway with
-- Turf/Event. The booking_type discriminator was originally ('event','turf').
-- This migration adds 'movie' so movie payment_orders can be stored alongside
-- the others, with the same idempotency / webhook event table.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  -- Drop and re-add the CHECK constraint with the new domain included.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payment_orders_booking_type_check'
      AND table_name = 'payment_orders'
  ) THEN
    ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_booking_type_check;
  END IF;

  ALTER TABLE payment_orders
    ADD CONSTRAINT payment_orders_booking_type_check
    CHECK (booking_type IN ('event', 'turf', 'movie'));
END $$;