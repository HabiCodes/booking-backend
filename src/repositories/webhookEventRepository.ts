/**
 * Webhook event repository — idempotent payment webhook processing.
 */

import { getPool } from '../db/pool';
import type { WebhookEventRow, WebhookEventPublic } from '../types';

export class WebhookEventRepository {
  /**
   * Atomically create a webhook event record.
   *
   * Uses INSERT ... ON CONFLICT DO NOTHING to guarantee idempotency
   * under concurrent webhook delivery.  If the same idempotency_key
   * arrives twice simultaneously, only one INSERT succeeds — the
   * other returns zero rows, and the caller should treat that as
   * "already recorded".
   *
   * Returns the row (new or existing) so callers always get the record.
   */
  async create(eventType: string, idempotencyKey: string, rawPayload: Record<string, unknown>, relatedOrderId?: string): Promise<WebhookEventRow> {
    // Try atomic insert first — handles concurrent delivery safely
    const { rows } = await getPool().query(
      `INSERT INTO webhook_events (event_type, event_id, idempotency_key, raw_payload, related_order_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [eventType, relatedOrderId || ((rawPayload.data as Record<string, unknown> | undefined)?.order_id as string | undefined) || '', idempotencyKey, JSON.stringify(rawPayload), relatedOrderId || null]
    );
    if (rows.length > 0) {
      return rows[0] as unknown as WebhookEventRow;
    }
    // Concurrent insert happened first — fetch the existing record
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (!existing) {
      // Extremely unlikely: ON CONFLICT didn't insert but no row found
      // Retry once as a safety net
      return this.create(eventType, idempotencyKey, rawPayload, relatedOrderId);
    }
    return existing;
  }

  async findByIdempotencyKey(key: string): Promise<WebhookEventRow | null> {
    const { rows } = await getPool().query('SELECT * FROM webhook_events WHERE idempotency_key = $1 LIMIT 1', [key]);
    return (rows as unknown as WebhookEventRow[])[0] || null;
  }

  async findByRelatedOrder(relatedOrderId: string): Promise<WebhookEventRow[]> {
    const { rows } = await getPool().query('SELECT * FROM webhook_events WHERE related_order_id = $1 ORDER BY created_at DESC', [relatedOrderId]);
    return rows as unknown as WebhookEventRow[];
  }

  async markProcessed(id: number): Promise<void> {
    await getPool().query('UPDATE webhook_events SET processed_at = NOW() WHERE id = $1', [id]);
  }

  async markFailed(id: number, error: string): Promise<void> {
    await getPool().query('UPDATE webhook_events SET processing_error = $1 WHERE id = $2', [error, id]);
  }
}

const webhookEventRepository = new WebhookEventRepository();
export { webhookEventRepository };
