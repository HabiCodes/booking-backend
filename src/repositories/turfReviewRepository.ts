/**
 * Turf review repository.
 */

import { getPool } from '../db/pool';
import type { TurfReviewRow, TurfReviewPublic } from '../types';

export class TurfReviewRepository {
  async findById(id: number): Promise<TurfReviewRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_reviews WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    return (rows as TurfReviewRow[])[0] || null;
  }

  async findByVenue(venueId: number): Promise<TurfReviewRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_reviews WHERE venue_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [venueId]
    );
    return rows as TurfReviewRow[];
  }

  async getRatingSummary(venueId: number): Promise<{ total_reviews: number; average_rating: number }> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as total_reviews, COALESCE(AVG(rating)::numeric(3,2), 0) as average_rating FROM turf_reviews WHERE venue_id = $1 AND deleted_at IS NULL`,
      [venueId]
    );
    const r = rows[0];
    return { total_reviews: Number(r.total_reviews), average_rating: parseFloat(r.average_rating) };
  }

  async create(input: { venue_id: number; user_id: number; booking_id: number; rating: number; review?: string | null }): Promise<TurfReviewRow> {
    const { rows } = await getPool().query(
      'INSERT INTO turf_reviews (venue_id, user_id, booking_id, rating, review, is_verified) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *',
      [input.venue_id, input.user_id, input.booking_id, input.rating, input.review ?? null]
    );
    return rows[0] as TurfReviewRow;
  }
}

export const turfReviewRepository = new TurfReviewRepository();
