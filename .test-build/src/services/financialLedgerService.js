"use strict";
/**
 * FinancialLedgerService — immutable double-entry ledger.
 *
 * Design principles:
 *  1. All entries are immutable INSERTs — never UPDATE or DELETE.
 *  2. Reversals create new entries pointing back to the original.
 *  3. Idempotency via (entry_type, reference_type, reference_id) partial unique index.
 *  4. All entries within a single event are posted in one DB transaction.
 *  5. Double-entry balance is verified before commit.
 *  6. config_snapshot preserves exact rates at transaction time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.financialLedgerService = exports.FinancialLedgerService = void 0;
const pool_1 = require("../db/pool");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const financialConfigService_1 = require("./financialConfigService");
const financialCalculator_1 = require("./financialCalculator");
async function postEntry(client, params) {
    const { organizationId, entryType, direction, amountPaise, referenceType, referenceId, idempotencyKey, configSnapshot, metadata = {}, } = params;
    (0, financialCalculator_1.validatePaiseAmount)(amountPaise, entryType);
    const result = await client.query(`INSERT INTO financial_ledger_entries
     (organization_id, entry_type, direction, amount_paise, currency,
      reference_type, reference_id, idempotency_key, config_snapshot, metadata)
     VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, $8, $9)
     RETURNING id`, [
        organizationId, entryType, direction, amountPaise,
        referenceType, referenceId, idempotencyKey,
        JSON.stringify(configSnapshot),
        JSON.stringify(metadata),
    ]);
    return result.rows[0].id;
}
// ── Service ───────────────────────────────────────────────────────────────────
class FinancialLedgerService {
    /**
     * Post booking financials to the ledger.
     * Creates all double-entry pairs in a single transaction.
     * Returns the config snapshot for downstream use.
     */
    async postBookingFinancials(params) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Load config from service (returns Record<string, number>)
            const rawConfig = await financialConfigService_1.financialConfigService.getSnapshot(params.organizationId);
            // Convert to ConfigSnapshot (Record<string, unknown>) for storage
            const config = {};
            for (const [k, v] of Object.entries(rawConfig)) {
                config[k] = v;
            }
            // Calculate
            const breakdown = (0, financialCalculator_1.calculateBookingFinancials)({
                gross_amount_paise: params.grossAmountPaise,
                coupon_discount_paise: params.couponDiscountPaise,
                config,
            });
            const baseKey = `${params.referenceType}:${params.bookingId}`;
            const entries = [
                { type: 'platform_fee', direction: 'debit', amount: breakdown.platform_fee_paise },
                { type: 'gst_collected', direction: 'debit', amount: breakdown.gst_on_platform_fee_paise },
                { type: 'commission_earned', direction: 'debit', amount: breakdown.commission_paise },
                { type: 'gst_collected', direction: 'credit', amount: breakdown.tds_paise },
                { type: 'cancellation_fee', direction: 'credit', amount: breakdown.net_payable_to_business_paise },
            ];
            if (breakdown.coupon_discount_paise > 0) {
                entries.push({ type: 'coupon_discount', direction: 'debit', amount: breakdown.coupon_discount_paise });
            }
            for (const entry of entries) {
                const key = `${baseKey}:${entry.type}`;
                await postEntry(client, {
                    organizationId: params.organizationId,
                    entryType: entry.type,
                    direction: entry.direction,
                    amountPaise: entry.amount,
                    referenceType: params.referenceType,
                    referenceId: params.bookingId,
                    idempotencyKey: key,
                    configSnapshot: config,
                });
            }
            const balanceOk = (0, financialCalculator_1.verifyLedgerBalance)(entries.map(e => ({ amount_paise: e.amount, direction: e.direction })));
            if (!balanceOk) {
                throw new errorHandler_1.AppError('Ledger balance verification failed', 500);
            }
            await client.query('COMMIT');
            logger_1.logger.info(`[Ledger] Posted booking financials for ${params.referenceType}:${params.bookingId}`);
            return config;
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Post refund financials — reversal entries.
     */
    async postRefundFinancials(params) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const refundCalc = (0, financialCalculator_1.calculateRefundFinancials)({
                originalBreakdown: params.originalBreakdown,
                refund_percentage: params.refundPercentage,
            });
            const baseKey = `${params.referenceType}:${params.bookingId}:refund:${params.refundId}`;
            const config = refundCalc.config_snapshot;
            const entries = [
                { type: 'refund_issued', direction: 'credit', amount: refundCalc.refund_amount_paise },
                { type: 'platform_fee_refunded', direction: 'credit', amount: refundCalc.platform_fee_refund_paise },
                { type: 'gst_refunded', direction: 'credit', amount: refundCalc.gst_refund_paise },
                { type: 'commission_reversed', direction: 'credit', amount: refundCalc.commission_reversal_paise },
                { type: 'settlement_paid', direction: 'debit', amount: refundCalc.business_debit_paise },
            ];
            for (const entry of entries) {
                await postEntry(client, {
                    organizationId: params.organizationId,
                    entryType: entry.type,
                    direction: entry.direction,
                    amountPaise: entry.amount,
                    referenceType: 'refund',
                    referenceId: params.refundId,
                    idempotencyKey: `${baseKey}:${entry.type}`,
                    configSnapshot: config,
                });
            }
            await client.query('COMMIT');
            logger_1.logger.info(`[Ledger] Posted refund financials for refund ${params.refundId}`);
            return config;
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Post settlement payment to ledger.
     */
    async postSettlementFinancials(params) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await postEntry(client, {
                organizationId: params.organizationId,
                entryType: 'settlement_paid',
                direction: 'credit',
                amountPaise: params.finalPayoutPaise,
                referenceType: 'settlement',
                referenceId: params.settlementId,
                idempotencyKey: `settlement:${params.settlementId}:paid`,
                configSnapshot: params.configSnapshot,
            });
            await client.query('COMMIT');
            logger_1.logger.info(`[Ledger] Posted settlement financials for settlement ${params.settlementId}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Post a manual adjustment — paired debit + credit entries.
     */
    async postAdjustment(params) {
        (0, financialCalculator_1.validatePaiseAmount)(params.amountPaise, 'adjustment_amount');
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const rawConfig = await financialConfigService_1.financialConfigService.getSnapshot(params.organizationId);
            const config = {};
            for (const [k, v] of Object.entries(rawConfig)) {
                config[k] = v;
            }
            const baseKey = `adjustment:${params.adjustmentId}`;
            const refType = params.referenceType ?? 'adjustment';
            const refId = params.referenceId ?? params.adjustmentId;
            const meta = { admin_id: params.adminId, reason: params.reason };
            await postEntry(client, {
                organizationId: params.organizationId,
                entryType: 'adjustment',
                direction: 'debit',
                amountPaise: params.amountPaise,
                referenceType: refType,
                referenceId: refId,
                idempotencyKey: `${baseKey}:debit`,
                configSnapshot: config,
                metadata: meta,
            });
            await postEntry(client, {
                organizationId: params.organizationId,
                entryType: 'adjustment',
                direction: 'credit',
                amountPaise: params.amountPaise,
                referenceType: refType,
                referenceId: refId,
                idempotencyKey: `${baseKey}:credit`,
                configSnapshot: config,
                metadata: meta,
            });
            await client.query('COMMIT');
            logger_1.logger.info(`[Ledger] Posted adjustment ${params.adjustmentId} by admin ${params.adminId}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Reverse a ledger entry — creates counter-entry and marks original.
     */
    async reverseEntry(entryId, reason, reversedByAdminId) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const entryResult = await client.query('SELECT * FROM financial_ledger_entries WHERE id = $1 AND is_reversed = false', [entryId]);
            if (entryResult.rows.length === 0) {
                throw new errorHandler_1.AppError('Ledger entry not found or already reversed', 404);
            }
            const original = entryResult.rows[0];
            const reverseDirection = original.direction === 'debit' ? 'credit' : 'debit';
            const reversalKey = `reverse:${entryId}:${Date.now()}`;
            await postEntry(client, {
                organizationId: original.organization_id,
                entryType: original.entry_type,
                direction: reverseDirection,
                amountPaise: original.amount_paise,
                referenceType: original.reference_type,
                referenceId: original.reference_id,
                idempotencyKey: reversalKey,
                configSnapshot: original.config_snapshot,
                metadata: { original_id: entryId, reason, reversed_by_admin: reversedByAdminId },
            });
            await client.query('UPDATE financial_ledger_entries SET is_reversed = true, reversed_by_id = $1, reversal_reason = $2 WHERE id = $3', [entryId, reason, entryId]);
            await client.query('COMMIT');
            logger_1.logger.info(`[Ledger] Reversed entry ${entryId} by admin ${reversedByAdminId}: ${reason}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    // ── Queries ────────────────────────────────────────────────────────────────
    async listByOrganization(organizationId, query) {
        const pool = (0, pool_1.getPool)();
        const clauses = ['organization_id = $1', 'is_reversed = false'];
        const params = [organizationId];
        let idx = 2;
        if (query?.entryType) {
            clauses.push(`entry_type = $${idx++}`);
            params.push(query.entryType);
        }
        if (query?.startDate) {
            clauses.push(`posted_at >= $${idx++}`);
            params.push(query.startDate);
        }
        if (query?.endDate) {
            clauses.push(`posted_at <= $${idx++}`);
            params.push(query.endDate);
        }
        const where = clauses.join(' AND ');
        const limit = Math.min(query?.limit ?? 50, 100);
        const offset = query?.offset ?? 0;
        const countResult = await pool.query(`SELECT COUNT(*) FROM financial_ledger_entries WHERE ${where}`, params);
        const total = Number(countResult.rows[0]?.count ?? 0);
        const dataResult = await pool.query(`SELECT id, organization_id, entry_type, direction, amount_paise, currency,
              reference_type, reference_id, idempotency_key, config_snapshot,
              is_reversed, reversal_reason, posted_at, created_at
       FROM financial_ledger_entries WHERE ${where}
       ORDER BY posted_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, offset]);
        return {
            items: dataResult.rows.map((r) => ({ ...r, metadata: {} })),
            total,
        };
    }
    async getBalanceSummary(organizationId, startDate, endDate) {
        const pool = (0, pool_1.getPool)();
        const clauses = ['organization_id = $1', 'is_reversed = false'];
        const params = [organizationId];
        let idx = 2;
        if (startDate) {
            clauses.push(`posted_at >= $${idx++}`);
            params.push(startDate);
        }
        if (endDate) {
            clauses.push(`posted_at <= $${idx++}`);
            params.push(endDate);
        }
        const where = clauses.join(' AND ');
        const result = await pool.query(`SELECT entry_type,
              SUM(CASE WHEN direction = 'debit' THEN amount_paise ELSE 0 END) as total_debit_paise,
              SUM(CASE WHEN direction = 'credit' THEN amount_paise ELSE 0 END) as total_credit_paise
       FROM financial_ledger_entries WHERE ${where}
       GROUP BY entry_type ORDER BY entry_type`, params);
        return result.rows.map((r) => ({
            entry_type: r.entry_type,
            total_debit_paise: Number(r.total_debit_paise) || 0,
            total_credit_paise: Number(r.total_credit_paise) || 0,
            net_paise: Number(r.total_debit_paise || 0) - Number(r.total_credit_paise || 0),
        }));
    }
}
exports.FinancialLedgerService = FinancialLedgerService;
exports.financialLedgerService = new FinancialLedgerService();
