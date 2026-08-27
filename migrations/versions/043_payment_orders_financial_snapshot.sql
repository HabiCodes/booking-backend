-- ============================================================================
-- Migration 043: Add financial_snapshot to payment_orders for audit/accounting
-- ============================================================================
--
-- The financial_snapshot column stores the complete PricingEngine output at
-- the time of payment order creation. This is the immutable audit record of
-- what the customer was charged, including:
--   - Domain and booking channel
--   - Per-ticket/unit base price in paise
--   - Quantity
--   - Subtotal, discount, taxable amount
--   - CGST and SGST breakdown (9% + 9% = 18%)
--   - GST-inclusive amount
--   - Platform fee (domain-specific: event=10%, movie_online=₹20/ticket,
--     movie_manager=2% of base, turf=₹50/booking)
--   - Final total in paise
--   - Currency, pricing rule version, calculation timestamp
--
-- This enables:
--   1. Audit: exact pricing preserved for regulatory compliance
--   2. Accounting: line-item financial reports per booking
--   3. Dispute resolution: show customer exactly what they paid and why
--   4. Historical accuracy: pricing rule changes don't affect past bookings

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_orders' AND column_name = 'financial_snapshot'
  ) THEN
    ALTER TABLE payment_orders
      ADD COLUMN financial_snapshot JSONB DEFAULT NULL;

    COMMENT ON COLUMN payment_orders.financial_snapshot IS
      'Immutable PricingEngine output: domain, channel, base price, quantity, '
      || 'subtotal, discount, taxable amount, CGST, SGST, GST total, '
      || 'GST-inclusive, platform fee, final total, currency, rule version, '
      || 'and calculation timestamp. Set at payment order creation.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_orders_financial_snapshot
  ON payment_orders (financial_snapshot)
  WHERE financial_snapshot IS NOT NULL;

ANALYZE payment_orders;
