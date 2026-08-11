"use strict";
/**
 * FinancialConfigService — reads, caches, and applies financial configuration.
 *
 * Sources (in priority order):
 *   1. Organization-level overrides  (scope = 'organization')
 *   2. Global defaults               (scope = 'global')
 *   3. Hard-coded fallbacks           (in this file, per-key)
 *
 * Guarantees:
 *   - Single source of truth for all BPS/paise rates.
 *   - ConfigSnapshot returned to FinancialCalculator is fully immutable.
 *   - Cache invalidation on config change or explicit flush.
 *   - Audit trail via admin action logging.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.financialConfigService = exports.FinancialConfigService = void 0;
const pool_1 = require("../db/pool");
const auditLogRepository_1 = require("../repositories/auditLogRepository");
const FALLBACK_RATES = {
    gst_bps: 1800,
    platform_fee_bps: 500,
    commission_bps: 1000,
    tds_bps: 0,
    cancellation_fee_paise: 5000,
    payout_minimum_paise: 50000,
};
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// ── Service ──────────────────────────────────────────────────────────────────
class FinancialConfigService {
    async getSnapshot(organizationId) {
        const cacheKey = `config:${organizationId ?? 'global'}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return Object.freeze({ ...cached.value });
        }
        const snapshot = await this.buildSnapshot(organizationId);
        cache.set(cacheKey, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
        return Object.freeze({ ...snapshot });
    }
    flushCache() {
        cache.clear();
    }
    async create(input) {
        const pool = (0, pool_1.getPool)();
        const { rows } = await pool.query(`INSERT INTO financial_configs
        (config_type, scope, organization_id, value_bps, value_paise, applies_to, effective_date, expires_at, created_by_admin_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`, [
            input.config_type,
            input.scope ?? 'global',
            input.organization_id ?? null,
            input.value_bps,
            input.value_paise ?? null,
            input.applies_to ?? 'all',
            input.effective_date ?? 'NOW()',
            input.expires_at ?? null,
            input.created_by_admin_id ?? null,
            input.notes ?? null,
        ]);
        this.flushCache();
        const row = rows[0];
        await auditLogRepository_1.auditLogRepository.insert({
            adminId: input.created_by_admin_id ?? 0,
            action: 'financial_config.updated',
            entityType: 'financial_config',
            entityId: row.id,
            metadata: { config_type: input.config_type, value_bps: input.value_bps, scope: input.scope ?? 'global' },
        });
        return row;
    }
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM financial_configs WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async list(filters = {}) {
        const pool = (0, pool_1.getPool)();
        const whereClauses = [];
        const params = [];
        let idx = 1;
        if (filters.config_type) {
            whereClauses.push(`config_type = $${idx++}`);
            params.push(filters.config_type);
        }
        if (filters.scope) {
            whereClauses.push(`scope = $${idx++}`);
            params.push(filters.scope);
        }
        if (filters.organization_id !== undefined) {
            whereClauses.push(`organization_id = $${idx++}`);
            params.push(filters.organization_id);
        }
        if (filters.is_active !== undefined) {
            whereClauses.push(`is_active = $${idx++}`);
            params.push(filters.is_active);
        }
        if (filters.applies_to) {
            whereClauses.push(`applies_to = $${idx++}`);
            params.push(filters.applies_to);
        }
        const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const page = filters.page || 1;
        const pageSize = Math.min(filters.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const { rows: countRows } = await pool.query(`SELECT COUNT(*) as total FROM financial_configs ${where}`, params);
        const total = Number(countRows[0]?.total ?? 0);
        const { rows } = await pool.query(`SELECT * FROM financial_configs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return {
            items: rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize) || 1,
        };
    }
    async update(id, input, adminId) {
        const pool = (0, pool_1.getPool)();
        const fields = [];
        const params = [];
        let idx = 1;
        const map = {
            value_bps: 'value_bps',
            value_paise: 'value_paise',
            expires_at: 'expires_at',
            is_active: 'is_active',
            notes: 'notes',
        };
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined && map[key]) {
                fields.push(`${map[key]} = $${idx++}`);
                params.push(value);
            }
        }
        if (fields.length === 0)
            return this.findById(id);
        params.push(id);
        const { rows } = await pool.query(`UPDATE financial_configs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        this.flushCache();
        const row = rows[0] || null;
        if (row) {
            await auditLogRepository_1.auditLogRepository.insert({
                adminId: adminId ?? 0,
                action: 'financial_config.updated',
                entityType: 'financial_config',
                entityId: id,
                metadata: { changes: input },
            });
        }
        return row;
    }
    async deactivate(id, adminId) {
        await (0, pool_1.getPool)().query('UPDATE financial_configs SET is_active = false WHERE id = $1', [id]);
        this.flushCache();
        await auditLogRepository_1.auditLogRepository.insert({
            adminId: adminId ?? 0,
            action: 'financial_config.deactivated',
            entityType: 'financial_config',
            entityId: id,
            metadata: { action: 'deactivated' },
        });
    }
    // ── Internal ───────────────────────────────────────────────────────────────
    async buildSnapshot(organizationId) {
        const pool = (0, pool_1.getPool)();
        const snapshot = { ...FALLBACK_RATES };
        // Fetch global defaults
        const globalResult = await pool.query(`SELECT config_type, value_bps, value_paise FROM financial_configs
       WHERE scope = 'global' AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY config_type`);
        for (const row of globalResult.rows) {
            this.applyRow(snapshot, row);
        }
        // Fetch organization overrides (if any)
        if (organizationId) {
            const orgResult = await pool.query(`SELECT config_type, value_bps, value_paise FROM financial_configs
         WHERE scope = 'organization' AND organization_id = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY config_type`, [organizationId]);
            for (const row of orgResult.rows) {
                this.applyRow(snapshot, row);
            }
        }
        return snapshot;
    }
    applyRow(snapshot, row) {
        switch (row.config_type) {
            case 'gst':
            case 'platform_fee':
            case 'commission':
            case 'tds':
                if (row.value_bps !== null)
                    snapshot[row.config_type + '_bps'] = row.value_bps;
                break;
            case 'cancellation_fee':
            case 'payout_minimum':
                if (row.value_paise !== null)
                    snapshot[row.config_type + '_paise'] = row.value_paise;
                if (row.value_bps !== null)
                    snapshot[row.config_type + '_bps'] = row.value_bps;
                break;
            default:
                break;
        }
    }
}
exports.FinancialConfigService = FinancialConfigService;
exports.financialConfigService = new FinancialConfigService();
