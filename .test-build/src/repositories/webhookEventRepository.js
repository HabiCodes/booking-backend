"use strict";
/**
 * Webhook event repository — idempotent Cashfree webhook processing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookEventRepository = exports.WebhookEventRepository = void 0;
const pool_1 = require("../db/pool");
class WebhookEventRepository {
    async create(eventType, idempotencyKey, rawPayload, relatedOrderId) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO webhook_events (event_type, event_id, idempotency_key, raw_payload, related_order_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [eventType, relatedOrderId || rawPayload.data?.order_id || '', idempotencyKey, JSON.stringify(rawPayload), relatedOrderId || null]);
        return rows[0];
    }
    async findByIdempotencyKey(key) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM webhook_events WHERE idempotency_key = $1 LIMIT 1', [key]);
        return rows[0] || null;
    }
    async findByRelatedOrder(relatedOrderId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM webhook_events WHERE related_order_id = $1 ORDER BY created_at DESC', [relatedOrderId]);
        return rows;
    }
    async markProcessed(id) {
        await (0, pool_1.getPool)().query('UPDATE webhook_events SET processed_at = NOW() WHERE id = $1', [id]);
    }
    async markFailed(id, error) {
        await (0, pool_1.getPool)().query('UPDATE webhook_events SET processing_error = $1 WHERE id = $2', [error, id]);
    }
}
exports.WebhookEventRepository = WebhookEventRepository;
const webhookEventRepository = new WebhookEventRepository();
exports.webhookEventRepository = webhookEventRepository;
