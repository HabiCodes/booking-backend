/**
 * ShowtimeService — business logic for movie showtimes.
 */

import { getPool } from '../db/pool';
import { showtimeRepository } from '../repositories/showtimeRepository';
import { moviePriceCapRepository } from '../repositories/moviePriceCapRepository';
import type {
  ShowtimeRow, ShowtimePublic, ShowtimeCreateInput,
} from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class ShowtimeService {

  // ── Public ──────────────────────────────────────────────────────────────────

  async listPublic(query: {
    movieId?: number;
    city?: string;
    cinemaId?: number;
    date?: string;
  }): Promise<ShowtimePublic[]> {
    if (query.movieId) {
      const result = await showtimeRepository.findByMovie(query.movieId);
      const now = new Date();
      const filtered = (result.items as unknown as ShowtimeRow[]).filter((s) => new Date(s.show_datetime) >= now && s.status === 'on_sale');
      return filtered.map(toPublic);
    }
    if (query.city) {
      const result = await showtimeRepository.findByCity(query.city);
      const now = new Date();
      const filtered = (result.items as unknown as ShowtimeRow[]).filter((s) => new Date(s.show_datetime) >= now && s.status === 'on_sale');
      return filtered.map(toPublic);
    }
    if (query.cinemaId) {
      const result = await showtimeRepository.findByCinema(query.cinemaId);
      const now = new Date();
      const filtered = (result.items as unknown as ShowtimeRow[]).filter((s) => new Date(s.show_datetime) >= now && s.status === 'on_sale');
      return filtered.map(toPublic);
    }
    const result = await showtimeRepository.findUpcoming();
    return result.items.filter((s) => s.status === 'on_sale').map(toPublic);
  }

  async getPublicDetail(showtimeId: number): Promise<ShowtimePublic | null> {
    const row = await showtimeRepository.findById(showtimeId);
    if (!row || row.status !== 'on_sale' || row.is_hidden) return null;
    return toPublic(row);
  }

  async getActiveCities(): Promise<string[]> {
    const result = await getPool().query(
      `SELECT DISTINCT c.city
       FROM showtimes s
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE s.status = $1 AND s.is_hidden = false AND s.deleted_at IS NULL
       ORDER BY c.city`,
      ['on_sale']
    );
    return (result.rows as Array<{ city: string }>).map((r) => r.city).filter(Boolean);
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  async listAdmin(query: {
    movieId?: number;
    cinemaId?: number;
    page?: number;
    pageSize?: number;
    organizationId?: number | null;
  }): Promise<PaginatedResult<ShowtimeRow>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);

    if (query.movieId) {
      const result = await showtimeRepository.findByMovie(query.movieId, { page, pageSize, organizationId: query.organizationId });
      return { ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) || 1 };
    }
    if (query.cinemaId) {
      const result = await showtimeRepository.findByCinema(query.cinemaId, { page, pageSize, organizationId: query.organizationId });
      return { ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) || 1 };
    }
    const result = await showtimeRepository.findUpcoming({ page, pageSize, organizationId: query.organizationId });
    return { ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) || 1 };
  }

  async create(input: Partial<ShowtimeCreateInput>): Promise<ShowtimeRow> {
    return showtimeRepository.create(input as ShowtimeCreateInput);
  }

  async update(id: number, input: Partial<ShowtimeCreateInput>): Promise<ShowtimeRow | null> {
    return showtimeRepository.update(id, input);
  }

  async remove(id: number): Promise<void> {
    return showtimeRepository.softDelete(id);
  }

  async listByCinema(cinemaId: number): Promise<ShowtimeRow[]> {
    const result = await showtimeRepository.findByCinema(cinemaId);
    return result.items;
  }

  async listByMovie(movieId: number, organizationId?: number | null): Promise<ShowtimeRow[]> {
    const result = await showtimeRepository.findByMovie(movieId, { organizationId });
    return result.items;
  }

  async getStats(organizationId?: number | null) {
    const whereClauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (organizationId != null) {
      whereClauses.push(`organization_id = $${idx++}`);
      params.push(organizationId);
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const result = await getPool().query(
      `SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'on_sale' THEN 1 END) as on_sale,
        COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled,
        COUNT(CASE WHEN status = 'ended' THEN 1 END) as ended
       FROM showtimes ${where}`,
      params
    );
    return (result.rows as Array<Record<string, unknown>>)[0];
  }
}

function toPublic(row: ShowtimeRow): ShowtimePublic {
  return {
    id: row.id,
    movieId: row.movie_id,
    cinemaId: row.cinema_id,
    screenId: row.screen_id,
    organizationId: row.organization_id,
    showDatetime: row.show_datetime,
    endDatetime: row.end_datetime,
    language: row.language,
    format: row.format,
    price: row.price,
    currency: row.currency,
    totalSeats: row.total_seats,
    availableSeats: row.available_seats,
    bookedSeats: row.booked_seats,
    status: row.status,
    isHidden: row.is_hidden,
  };
}

export const showtimeService = new ShowtimeService();