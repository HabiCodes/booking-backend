/**
 * CinemaService — business logic for cinemas, screens, and seat layouts.
 *
 * All amounts are in INTEGER paise.
 * All timestamps are TIMESTAMPTZ (IST).
 */

import { getPool } from '../db/pool';
import { cinemaRepository } from '../repositories/cinemaRepository';
import { cinemaScreenRepository } from '../repositories/cinemaScreenRepository';
import { cinemaSeatRepository } from '../repositories/cinemaSeatRepository';
import { layoutVersionService } from './layoutVersionService';
import { logger } from '../utils/logger';
import type {
  CinemaRow, CinemaPublic,
  CinemaScreenRow, CinemaScreenCreateInput,
  CinemaSeatRow, CinemaSeatCreateInput,
  LayoutVersionPublic,
} from '../types';

function cinemaToPublic(row: CinemaRow): CinemaPublic {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    phone: row.phone,
    email: row.email,
    facilities: row.facilities,
    organizationId: row.organization_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CinemaService {

  // ── Public ──────────────────────────────────────────────────────────────────

  async listActive(city?: string, state?: string): Promise<CinemaPublic[]> {
    if (city) {
      const result = await cinemaRepository.findByCity(city);
      return result.items;
    }
    const result = await getPool().query(
      `SELECT * FROM cinemas WHERE deleted_at IS NULL AND status = 'active'
       ${state ? 'AND state = $1' : ''}
       ORDER BY name`,
      state ? [state] : []
    );
    return (result.rows as unknown[]).map((r) => cinemaToPublic(r as CinemaRow));
  }

  async listByCity(city: string): Promise<CinemaPublic[]> {
    const result = await cinemaRepository.findByCity(city);
    return result.items;
  }

  async getActive(idOrSlug: string): Promise<CinemaPublic | null> {
    const byId = Number(idOrSlug);
    if (Number.isFinite(byId) && byId > 0) {
      const row = await cinemaRepository.findById(byId);
      if (!row || row.status !== 'active') return null;
      return cinemaToPublic(row);
    }
    const row = await cinemaRepository.findBySlug(idOrSlug);
    if (!row || row.status !== 'active') return null;
    return cinemaToPublic(row);
  }

  async getScreens(cinemaId: number): Promise<CinemaScreenRow[]> {
    return cinemaScreenRepository.findByCinema(cinemaId);
  }

  async getSeatsForShowtime(showtimeId: number) {
    return cinemaSeatRepository.findByShowtime(showtimeId);
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  async listAll(city?: string): Promise<CinemaRow[]> {
    if (city) {
      const r = await cinemaRepository.findByCity(city);
      return r.items as unknown as CinemaRow[];
    }
    const result = await getPool().query(
      'SELECT * FROM cinemas WHERE deleted_at IS NULL ORDER BY name'
    );
    return result.rows as unknown as CinemaRow[];
  }

  async create(input: Record<string, unknown>): Promise<CinemaRow> {
    return cinemaRepository.create(input as unknown as Parameters<typeof cinemaRepository.create>[0]);
  }

  async update(id: number, input: Record<string, unknown>): Promise<CinemaRow | null> {
    return cinemaRepository.update(id, input as unknown as Parameters<typeof cinemaRepository.update>[1]);
  }

  async remove(id: number): Promise<void> {
    return cinemaRepository.softDelete(id);
  }

  async toggleActive(id: number, isActive: boolean | undefined): Promise<CinemaRow | null> {
    const status = isActive === true || isActive === undefined ? 'active' : 'inactive';
    return cinemaRepository.update(id, { status } as Parameters<typeof cinemaRepository.update>[1]);
  }

  async createScreen(cinemaId: number, input: Partial<CinemaScreenCreateInput>): Promise<CinemaScreenRow> {
    const data: CinemaScreenCreateInput = {
      cinemaId,
      screenNumber: input.screenNumber ?? 1,
      name: input.name ?? null,
      seatCapacity: input.seatCapacity ?? 0,
      screenType: input.screenType ?? 'standard',
      soundSystem: input.soundSystem ?? 'dolby',
      rowLabels: input.rowLabels ?? [],
      seatsPerRow: input.seatsPerRow ?? [],
      seatStartNumber: input.seatStartNumber ?? 1,
      seatTypes: input.seatTypes ?? {},
      pricingRules: input.pricingRules ?? {},
    };
    return cinemaScreenRepository.create(data);
  }

  async updateScreen(screenId: number, input: Partial<CinemaScreenCreateInput>): Promise<CinemaScreenRow | null> {
    return cinemaScreenRepository.update(screenId, input);
  }

  async removeScreen(screenId: number): Promise<void> {
    return cinemaScreenRepository.softDelete(screenId);
  }

  // ── Layout Versioning ─────────────────────────────────────────────────────────

  async getScreenLayoutVersions(screenId: number): Promise<LayoutVersionPublic[]> {
    return layoutVersionService.listForScreen(screenId);
  }

  async getScreenCurrentLayout(screenId: number): Promise<LayoutVersionPublic | null> {
    return layoutVersionService.getCurrent(screenId);
  }

  async setScreenCurrentLayout(screenId: number, versionId: number): Promise<LayoutVersionPublic | null> {
    return layoutVersionService.setCurrentVersion(screenId, versionId);
  }

  async createScreenLayoutVersion(screenId: number, name: string, description?: string): Promise<LayoutVersionPublic> {
    return layoutVersionService.createNewVersionFromScreen(screenId, name, description);
  }

  async syncScreenLayout(screenId: number): Promise<LayoutVersionPublic | null> {
    const current = await layoutVersionService.getCurrent(screenId);
    if (!current) return null;
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) return null;

    // Sync cinema_seats from the screen's current row_labels/seats_per_row config
    // First clear current cinema_seats
    await cinemaSeatRepository.softDeleteByScreen(screenId);

    // Recreate seats from the layout version's current configuration
    const layoutSeats = await layoutVersionService.getSeats(current.id);
    const cinemaSeats: CinemaSeatCreateInput[] = layoutSeats.map((s) => ({
      screenId,
      rowLabel: s.rowLabel,
      seatNumber: s.seatNumber,
      seatType: s.seatType,
      seatCategory: s.seatCategory,
      xPosition: s.xPosition,
      yPosition: s.yPosition,
      isAvailable: s.isAvailable,
    }));
    await cinemaSeatRepository.bulkCreate(screenId, cinemaSeats);

    return current;
  }
}

export const cinemaService = new CinemaService();
