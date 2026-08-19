/**
 * LayoutVersionService — business logic for cinema screen layout versioning.
 *
 * Layout versioning tracks historical seat layouts. When a screen is renovated
 * or reconfigured, a new version is created and set as current. Bookings and
 * showtimes reference the layout version active at their creation time.
 */

import { getPool } from '../db/pool';
import { layoutVersionRepository } from '../repositories/layoutVersionRepository';
import { layoutVersionSeatRepository } from '../repositories/layoutVersionSeatRepository';
import { cinemaScreenRepository } from '../repositories/cinemaScreenRepository';
import { logger } from '../utils/logger';
import type {
  LayoutVersionRow,
  LayoutVersionPublic,
  LayoutVersionCreateInput,
  LayoutVersionSeatRow,
  LayoutVersionSeatPublic,
  LayoutVersionSeatCreateInput,
} from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class LayoutVersionService {

  // ── Public ──────────────────────────────────────────────────────────────────

  async listForScreen(screenId: number): Promise<LayoutVersionPublic[]> {
    const versions = await layoutVersionRepository.findByScreen(screenId);
    return versions.map((v) => layoutVersionRepository.toPublic(v));
  }

  async getCurrent(screenId: number): Promise<LayoutVersionPublic | null> {
    const version = await layoutVersionRepository.findCurrentByScreen(screenId);
    if (!version) return null;
    return layoutVersionRepository.toPublic(version);
  }

  async getById(id: number): Promise<LayoutVersionPublic | null> {
    const version = await layoutVersionRepository.findById(id);
    if (!version) return null;
    return layoutVersionRepository.toPublic(version);
  }

  async getSeats(layoutVersionId: number): Promise<LayoutVersionSeatPublic[]> {
    const seats = await layoutVersionSeatRepository.findByLayoutVersion(layoutVersionId);
    return seats.map((s: LayoutVersionSeatRow) => layoutVersionSeatRepository.toPublic(s));
  }

  // ── Admin: Create new layout version ───────────────────────────────────────

  async createVersion(input: LayoutVersionCreateInput, seats: LayoutVersionSeatCreateInput[]): Promise<LayoutVersionPublic> {
    const pool = getPool();

    await pool.query('BEGIN');

    try {
      // Create the version
      const version = await layoutVersionRepository.create(input);
      const publicVersion = layoutVersionRepository.toPublic(version);

      // Create seats
      if (seats.length > 0) {
        await layoutVersionSeatRepository.bulkCreate(version.id, seats);
      }

      // If this is the first version for the screen, auto-set as current
      const existing = await layoutVersionRepository.findByScreen(input.screenId);
      if (existing.length === 1) {
        await layoutVersionRepository.setCurrent(input.screenId, version.id);
      }

      await pool.query('COMMIT');
      return publicVersion;
    } catch (err) {
      await pool.query('ROLLBACK');
      logger.error('Failed to create layout version:', err);
      throw err;
    }
  }

  async createNewVersionFromScreen(screenId: number, name: string, description?: string): Promise<LayoutVersionPublic> {
    // Clone the current screen layout into a new version
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) {
      throw new Error(`Screen ${screenId} not found`);
    }

    const input: LayoutVersionCreateInput = {
      screenId,
      name: name ?? 'Updated Layout',
      description: description ?? null,
      seatCapacity: screen.seat_capacity,
      rowLabels: screen.row_labels,
      seatsPerRow: screen.seats_per_row,
      seatStartNumber: screen.seat_start_number,
      pricingRules: screen.pricing_rules,
    };

    return this.createVersion(input, []);
  }

  // ── Admin: Set current version ─────────────────────────────────────────────

  async setCurrentVersion(screenId: number, versionId: number): Promise<LayoutVersionPublic | null> {
    const version = await layoutVersionRepository.findById(versionId);
    if (!version || version.screen_id !== screenId) {
      return null;
    }

    await layoutVersionRepository.setCurrent(screenId, versionId);
    const updated = await layoutVersionRepository.findById(versionId);
    return updated ? layoutVersionRepository.toPublic(updated) : null;
  }

  // ── Admin: Add seat to a layout version ────────────────────────────────────

  async addSeat(layoutVersionId: number, seat: LayoutVersionSeatCreateInput): Promise<LayoutVersionSeatPublic> {
    const version = await layoutVersionRepository.findById(layoutVersionId);
    if (!version) {
      throw new Error(`Layout version ${layoutVersionId} not found`);
    }

    const row = await layoutVersionSeatRepository.create(seat);
    return layoutVersionSeatRepository.toPublic(row);
  }

  // ── Admin: Bulk sync layout version seats from current screen ──────────────

  async syncSeatsFromScreen(layoutVersionId: number, screenId: number): Promise<LayoutVersionSeatPublic[]> {
    const pool = getPool();

    const version = await layoutVersionRepository.findById(layoutVersionId);
    if (!version || version.screen_id !== screenId) {
      throw new Error(`Layout version ${layoutVersionId} does not belong to screen ${screenId}`);
    }

    // Clear existing seats and re-sync from cinema_seats
    await pool.query('DELETE FROM layout_version_seats WHERE layout_version_id = $1', [layoutVersionId]);

    const screenSeats = await pool.query(
      'SELECT row_label, seat_number, seat_type, seat_category, x_position, y_position, is_available FROM cinema_seats WHERE screen_id = $1 AND deleted_at IS NULL',
      [screenId]
    );

    const seatInputs = (screenSeats.rows as Array<{
      row_label: string;
      seat_number: number;
      seat_type: string;
      seat_category: string;
      x_position: number | string | null;
      y_position: number | string | null;
      is_available: boolean;
    }>).map((s) => ({
      layoutVersionId,
      rowLabel: s.row_label,
      seatNumber: s.seat_number,
      seatType: s.seat_type,
      seatCategory: s.seat_category,
      xPosition: s.x_position !== null ? Number(s.x_position) : null,
      yPosition: s.y_position !== null ? Number(s.y_position) : null,
      isAvailable: s.is_available,
    }));

    const created = await layoutVersionSeatRepository.bulkCreate(layoutVersionId, seatInputs);
    return created.map((s: LayoutVersionSeatRow) => layoutVersionSeatRepository.toPublic(s));
  }

  // ── Admin: Delete a layout version ────────────────────────────────────────

  async deleteVersion(id: number): Promise<void> {
    const version = await layoutVersionRepository.findById(id);
    if (!version) return;

    if (version.is_current) {
      throw new Error('Cannot delete the current layout version. Set another version as current first.');
    }

    await layoutVersionRepository.delete(id);
  }

  // ── Admin: Create initial layout for a screen (seeded during screen creation) ─

  async createInitialForScreen(
    screenId: number,
    seatCapacity: number,
    rowLabels: string[],
    seatsPerRow: number[],
    seats: LayoutVersionSeatCreateInput[]
  ): Promise<LayoutVersionPublic> {
    const input: LayoutVersionCreateInput = {
      screenId,
      versionNumber: 1,
      name: 'Initial Layout',
      seatCapacity,
      rowLabels,
      seatsPerRow,
      seatStartNumber: 1,
      pricingRules: {},
    };

    return this.createVersion(input, seats);
  }
}

export const layoutVersionService = new LayoutVersionService();
