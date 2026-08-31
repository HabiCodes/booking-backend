/**
 * ShowtimeRepository — manages movie showtimes with atomic seat counters
 * and availability queries. Seat availability is enforced via the
 * available_seats column (incremented/decremented atomically).
 */

import { getPool } from '../db/pool';
import type { ShowtimeRow, ShowtimeCreateInput, ShowtimePublic, ShowtimeFormat, ShowtimeStatus } from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toPublic(row: Record<string, unknown>): ShowtimePublic {
  return {
    id: row.id as number,
    movieId: row.movie_id as number,
    cinemaId: row.cinema_id as number,
    screenId: row.screen_id as number,
    organizationId: row.organization_id as number | null,
    showDatetime: row.show_datetime as string,
    endDatetime: row.end_datetime as string,
    language: row.language as string,
    format: row.format as ShowtimeFormat,
    price: row.price as number,
    currency: row.currency as string,
    totalSeats: row.total_seats as number,
    availableSeats: row.available_seats as number,
    bookedSeats: row.booked_seats as number,
    status: row.status as ShowtimeStatus,
    isHidden: row.is_hidden as boolean,
  };
}

export class ShowtimeRepository {
  async findById(id: number): Promise<ShowtimeRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM showtimes WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as ShowtimeRow[])[0] || null;
  }

  async findByMovie(
    movieId: number,
    query: { page?: number; pageSize?: number; organizationId?: number | null } = {}
  ): Promise<PaginatedResult<ShowtimeRow>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereParts = ['s.movie_id = $1', 's.deleted_at IS NULL'];
    const params: unknown[] = [movieId];
    let idx = 2;
    if (query.organizationId != null) { whereParts.push(`c.organization_id = $${idx++}`); params.push(query.organizationId); }
    const where = whereParts.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes s INNER JOIN cinemas c ON c.id = s.cinema_id WHERE ${where}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT s.* FROM showtimes s INNER JOIN cinemas c ON c.id = s.cinema_id WHERE ${where} ORDER BY s.show_datetime LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as ShowtimeRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findByCinema(
    cinemaId: number,
    query: { page?: number; pageSize?: number; organizationId?: number | null } = {}
  ): Promise<PaginatedResult<ShowtimeRow>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereParts = ['cinema_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [cinemaId];
    let idx = 2;
    if (query.organizationId != null) { whereParts.push(`organization_id = $${idx++}`); params.push(query.organizationId); }
    const where = whereParts.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes WHERE ${where}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM showtimes WHERE ${where} ORDER BY show_datetime LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as ShowtimeRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findByCity(
    city: string,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<ShowtimePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes s
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE c.city = $1 AND s.deleted_at IS NULL`,
      [city]
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT s.* FROM showtimes s
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE c.city = $1 AND s.deleted_at IS NULL
       ORDER BY s.show_datetime LIMIT $2 OFFSET $3`,
      [city, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findUpcoming(
    query: { movieId?: number; cinemaId?: number; page?: number; pageSize?: number; organizationId?: number | null } = {}
  ): Promise<PaginatedResult<ShowtimeRow>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ["show_datetime > NOW()", "deleted_at IS NULL"];
    const params: unknown[] = [];
    let idx = 1;
    if (query.movieId) { whereClauses.push(`movie_id = $${idx++}`); params.push(query.movieId); }
    if (query.cinemaId) { whereClauses.push(`cinema_id = $${idx++}`); params.push(query.cinemaId); }
    if (query.organizationId != null) {
      whereClauses.push(`organization_id = $${idx++}`);
      params.push(query.organizationId);
    }
    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM showtimes WHERE ${where} ORDER BY show_datetime LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as ShowtimeRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findOnSale(
    organizationId?: number,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<ShowtimePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ["status = 'on_sale'", "available_seats > 0", "deleted_at IS NULL"];
    const params: unknown[] = [];
    let idx = 1;
    if (organizationId !== undefined) { whereClauses.push(`organization_id = $${idx++}`); params.push(organizationId); }
    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM showtimes WHERE ${where} ORDER BY show_datetime LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: ShowtimeCreateInput): Promise<ShowtimeRow> {
    const showDatetime = input.showDatetime;
    // Get movie duration to compute end_datetime
    const movieResult = await getPool().query(
      'SELECT duration_minutes FROM movies WHERE id = $1 LIMIT 1',
      [input.movieId]
    );
    const movieRow = (movieResult.rows as Array<{ duration_minutes: number | null }>)[0];
    const duration = movieRow?.duration_minutes || 150;
    // Add 30 min buffer for cleaning
    const endDatetime = new Date(new Date(showDatetime).getTime() + (duration + 30) * 60 * 1000).toISOString();

    const { rows } = await getPool().query(
      `INSERT INTO showtimes (movie_id, cinema_id, screen_id, organization_id, show_datetime, end_datetime, language, format, price, currency, total_seats, available_seats, status, is_hidden, metadata)
       SELECT $1,$2,$3, c.organization_id, $4, $5, $6, $7, $8, $9, cs.seat_capacity, cs.seat_capacity, $10, $11, $12
       FROM cinemas c JOIN cinema_screens cs ON cs.id = $3 AND cs.cinema_id = c.id
       RETURNING *`,
      [
        input.movieId, input.cinemaId, input.screenId,
        showDatetime, endDatetime,
        input.language || 'Tamil', input.format || '2D',
        input.price, input.currency || 'INR',
        'scheduled', false, '{}',
      ]
    );
    return rows[0] as unknown as ShowtimeRow;
  }

  async update(id: number, input: Partial<ShowtimeCreateInput>): Promise<ShowtimeRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (input.showDatetime !== undefined) {
      sets.push(`show_datetime = $${idx++}`);
      params.push(input.showDatetime);
      // Recompute end_datetime
      const movieResult = await getPool().query(
        'SELECT duration_minutes FROM movies WHERE id = (SELECT movie_id FROM showtimes WHERE id = $1) LIMIT 1',
        [id]
      );
      const movieRow = (movieResult.rows as Array<{ duration_minutes: number | null }>)[0];
      const duration = movieRow?.duration_minutes || 150;
      const endDatetime = new Date(new Date(input.showDatetime).getTime() + (duration + 30) * 60 * 1000).toISOString();
      sets.push(`end_datetime = $${idx++}`);
      params.push(endDatetime);
    }
    if (input.price !== undefined) { sets.push(`price = $${idx++}`); params.push(input.price); }
    if (input.status !== undefined) { sets.push(`status = $${idx++}`); params.push(input.status); }

    if (sets.length === 1) return this.findById(id);
    const { rows } = await getPool().query(
      `UPDATE showtimes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as ShowtimeRow[])[0] || null;
  }

  async updateAvailableSeats(id: number, delta: number, client?: import('pg').PoolClient): Promise<void> {
    const pool = client || getPool();
    await pool.query(
      `UPDATE showtimes SET available_seats = GREATEST(0, available_seats + $1), updated_at = NOW()
       WHERE id = $2`,
      [delta, id]
    );
    if (delta < 0) {
      await pool.query(
        `UPDATE showtimes SET status = 'sold_out', updated_at = NOW()
         WHERE id = $1 AND available_seats <= 0 AND status = 'on_sale'`,
        [id]
      );
    } else if (delta > 0) {
      await pool.query(
        `UPDATE showtimes SET status = 'on_sale', updated_at = NOW()
         WHERE id = $1 AND available_seats > 0 AND status = 'sold_out'`,
        [id]
      );
    }
  }

  async incrementBookedSeats(id: number, count: number): Promise<void> {
    await getPool().query(
      'UPDATE showtimes SET booked_seats = booked_seats + $1, available_seats = GREATEST(0, available_seats - $1), updated_at = NOW() WHERE id = $2',
      [count, id]
    );
  }

  async decrementBookedSeats(id: number, count: number): Promise<void> {
    const showtime = await this.findById(id);
    if (!showtime) return;
    const newAvailable = Math.min(showtime.total_seats, showtime.available_seats + count);
    await getPool().query(
      'UPDATE showtimes SET booked_seats = GREATEST(0, booked_seats - $1), available_seats = $2, updated_at = NOW() WHERE id = $3',
      [count, newAvailable, id]
    );
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await getPool().query(
      'UPDATE showtimes SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE showtimes SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const showtimeRepository = new ShowtimeRepository();
