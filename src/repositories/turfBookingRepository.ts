/**
 * Turf booking repository.
 */

import { getPool } from '../db/pool';
import type { TurfBookingRow, TurfBookingPublic, TurfBookingDetail, TurfBookingStatus } from '../types';

export class TurfBookingRepository {
  async findById(id: number): Promise<TurfBookingRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_bookings WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    return (rows as unknown as TurfBookingRow[])[0] || null;
  }

  async findByReference(ref: string): Promise<TurfBookingRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_bookings WHERE booking_reference = $1 AND deleted_at IS NULL LIMIT 1', [ref]);
    return (rows as unknown as TurfBookingRow[])[0] || null;
  }

  async findDetail(id: number): Promise<TurfBookingDetail | null> {
    const { rows } = await getPool().query(
      `SELECT b.*, tv.name as venue_name, tr.name as resource_name, tr.resource_type, tr.category,
              au.starts_at as slot_start, au.ends_at as slot_end,
              qt.token as qr_token, qt.status as qr_status,
              u.email as customer_email, u.username as customer_name
       FROM turf_bookings b
       JOIN turf_venues tv ON b.venue_id = tv.id
       JOIN turf_resources tr ON b.resource_id = tr.id
       JOIN turf_availability_units au ON b.availability_unit_id = au.id
       LEFT JOIN turf_qr_tickets qt ON qt.booking_id = b.id
       JOIN users u ON b.user_id = u.id
       WHERE b.id = $1 AND b.deleted_at IS NULL
       LIMIT 1`,
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      ...r,
      amount: parseFloat(r.amount),
      cancellation_fee: parseFloat(r.cancellation_fee),
    } as TurfBookingDetail;
  }

  async findByUser(userId: number, filters: { status?: string; page?: number; pageSize?: number }): Promise<{ items: TurfBookingPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['b.user_id = $1', 'b.deleted_at IS NULL'];
    const params: unknown[] = [userId];
    let idx = 2;
    if (filters.status) { where.push(`b.status = $${idx++}`); params.push(filters.status); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_bookings b ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT b.id, b.booking_reference, b.user_id, b.organization_id, b.venue_id, b.resource_id,
              b.availability_unit_id, b.booking_type, b.quantity, b.amount, b.currency, b.status,
              b.payment_status, b.payment_gateway_ref, b.cancellation_reason, b.cancelled_by,
              b.cancellation_fee, b.notes, b.created_at, b.updated_at,
              tv.name as venue_name, tr.name as resource_name, tr.category,
              qt.token as qr_token, qt.status as qr_status
       FROM turf_bookings b
       JOIN turf_venues tv ON b.venue_id = tv.id
       JOIN turf_resources tr ON b.resource_id = tr.id
       LEFT JOIN turf_qr_tickets qt ON qt.booking_id = b.id
       ${whereStr}
       ORDER BY b.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    const items = (rows as any[]).map(r => ({
      ...r,
      amount: parseFloat(r.amount),
      cancellation_fee: parseFloat(r.cancellation_fee),
    }));
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findAll(filters: { status?: string; page?: number; pageSize?: number }): Promise<{ items: TurfBookingPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['b.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (filters.status) { where.push(`b.status = $${idx++}`); params.push(filters.status); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_bookings b ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT b.id, b.booking_reference, b.user_id, b.organization_id, b.venue_id, b.resource_id,
              b.availability_unit_id, b.booking_type, b.quantity, b.amount, b.currency, b.status,
              b.payment_status, b.payment_gateway_ref, b.cancellation_reason, b.cancelled_by,
              b.cancellation_fee, b.notes, b.created_at, b.updated_at,
              tv.name as venue_name, tr.name as resource_name, tr.category,
              u.email as customer_email, u.username as customer_name,
              qt.token as qr_token, qt.status as qr_status
       FROM turf_bookings b
       JOIN turf_venues tv ON b.venue_id = tv.id
       JOIN turf_resources tr ON b.resource_id = tr.id
       JOIN users u ON b.user_id = u.id
       LEFT JOIN turf_qr_tickets qt ON qt.booking_id = b.id
       ${whereStr}
       ORDER BY b.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    const items = (rows as any[]).map(r => ({
      ...r,
      amount: parseFloat(r.amount),
      cancellation_fee: parseFloat(r.cancellation_fee),
    }));
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findByOrganization(orgId: number, filters: { status?: string; page?: number; pageSize?: number }): Promise<{ items: TurfBookingPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['b.organization_id = $1', 'b.deleted_at IS NULL'];
    const params: unknown[] = [orgId];
    let idx = 2;
    if (filters.status) { where.push(`b.status = $${idx++}`); params.push(filters.status); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_bookings b ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT b.id, b.booking_reference, b.user_id, b.organization_id, b.venue_id, b.resource_id,
              b.availability_unit_id, b.booking_type, b.quantity, b.amount, b.currency, b.status,
              b.payment_status, b.payment_gateway_ref, b.cancellation_reason, b.cancelled_by,
              b.cancellation_fee, b.notes, b.created_at, b.updated_at,
              tv.name as venue_name, tr.name as resource_name, tr.category,
              u.email as customer_email, u.username as customer_name,
              qt.token as qr_token, qt.status as qr_status
       FROM turf_bookings b
       JOIN turf_venues tv ON b.venue_id = tv.id
       JOIN turf_resources tr ON b.resource_id = tr.id
       JOIN users u ON b.user_id = u.id
       LEFT JOIN turf_qr_tickets qt ON qt.booking_id = b.id
       ${whereStr}
       ORDER BY b.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    const items = (rows as any[]).map(r => ({
      ...r,
      amount: parseFloat(r.amount),
      cancellation_fee: parseFloat(r.cancellation_fee),
    }));
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: Record<string, unknown>): Promise<TurfBookingRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_bookings
       (user_id, organization_id, venue_id, resource_id, availability_unit_id,
        booking_type, offline_by_user_id, quantity, amount, currency,
        status, payment_status, cancellation_reason, cancelled_by, cancellation_fee, notes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       RETURNING *`,
      [
        input.user_id,
        input.organization_id,
        input.venue_id,
        input.resource_id,
        input.availability_unit_id,
        input.booking_type ?? 'online',
        input.offline_by_user_id ?? null,
        input.quantity ?? 1,
        input.amount,
        input.currency ?? 'INR',
        input.status ?? 'pending_payment',
        input.payment_status ?? 'initiated',
        input.cancellation_reason ?? null,
        input.cancelled_by ?? null,
        input.cancellation_fee ?? 0,
        input.notes ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return (rows as unknown as TurfBookingRow[])[0];
  }

  async updateStatus(id: number, status: TurfBookingStatus, extra: Record<string, unknown> = {}): Promise<TurfBookingRow | null> {
    const setClauses = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];
    let idx = 3;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }
    const { rows } = await getPool().query(
      `UPDATE turf_bookings SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return (rows as unknown as TurfBookingRow[])[0] || null;
  }

  async updatePaymentStatus(id: number, paymentStatus: string, gatewayRef?: string | null): Promise<TurfBookingRow | null> {
    const setClauses = ['payment_status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, paymentStatus];
    let idx = 3;
    if (gatewayRef) { setClauses.push(`payment_gateway_ref = $${idx++}`); params.push(gatewayRef); }
    const { rows } = await getPool().query(
      `UPDATE turf_bookings SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return (rows as unknown as TurfBookingRow[])[0] || null;
  }

  async incrementVersion(id: number): Promise<void> {
    await getPool().query('UPDATE turf_bookings SET version = version + 1, updated_at = NOW() WHERE id = $1', [id]);
  }
}

export const turfBookingRepository = new TurfBookingRepository();
