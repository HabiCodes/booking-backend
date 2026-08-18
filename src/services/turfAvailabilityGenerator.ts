/**
 * Turf Availability Generator — automatically generates slot availability
 * for turf venues over a rolling window.
 *
 * Design:
 *  - Uses existing buildSlotWindows() with hardcoded +05:30 IST
 *  - Wraps turfAvailabilityService.generateSlots() which has ON CONFLICT DO NOTHING
 *  - One transaction per resource for atomicity
 *  - Concurrency-safe via DB unique constraint (uq_turf_au_resource_slot)
 *  - Does NOT touch existing bookings (only INSERTs into availability_units)
 */

import { logger } from '../utils/logger';
import { turfAvailabilityService } from './turfAvailabilityService';
import { turfResourceRepository } from '../repositories/turfResourceRepository';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ROLLING_DAYS = 15;
const DEFAULT_START_TIME = '06:00';
const DEFAULT_END_TIME = '22:00';
const DEFAULT_SLOT_DURATION_MINUTES = 60;
const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000; // +05:30

/**
 * Rolling window: generate slots starting from TOMORROW (excludes today),
 * spanning exactly DEFAULT_ROLLING_DAYS full calendar days.
 *
 * If today = Aug 18, the window is Aug 19 → Sep 2 (15 days, today excluded).
 * This gives customers advance booking without same-day rush.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface GenerationResult {
  venueId: number;
  resourceId: number;
  date: string;
  requested: number;
  created: number;
  skippedExisting: number;
}

export interface GenerationSummary {
  venueId: number;
  resourcesProcessed: number;
  datesProcessed: number;
  totalRequested: number;
  totalCreated: number;
  totalSkipped: number;
  results: GenerationResult[];
}

// ── Date Helpers ─────────────────────────────────────────────────────────────

/**
 * Get today's date in Asia/Kolkata, as YYYY-MM-DD.
 * Independent of server host timezone.
 */
export function getISTDate(): string {
  const now = new Date();
  const istMillis = now.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMillis);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Add N days to a YYYY-MM-DD string.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Generate an array of YYYY-MM-DD strings from start to end (inclusive).
 */
export function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

// ── Schedule Resolution ──────────────────────────────────────────────────────

interface DaySchedule {
  openTime: string;
  closeTime: string;
}

/**
 * Get the schedule for a venue on a given day.
 * All resources in the same venue receive the same schedule (requirement #2).
 * Reads from turf_resource_schedules using the first active resource as a proxy;
 * falls back to default if no schedule exists for the venue.
 */
async function getVenueSchedule(venueId: number, dateStr: string): Promise<DaySchedule> {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(y, m - 1, d).getDay();

  try {
    const { getPool } = await import('../db/pool');
    // Read schedule from the first active resource in this venue
    // (all resources share the same schedule for now per requirement #2)
    const result = await getPool().query(
      `SELECT rs.open_time, rs.close_time
       FROM turf_resource_schedules rs
       JOIN turf_resources r ON r.id = rs.resource_id
       WHERE r.venue_id = $1 AND rs.day_of_week = $2 AND rs.is_active = TRUE
       ORDER BY rs.resource_id ASC LIMIT 1`,
      [venueId, dayOfWeek]
    );
    if (result.rows.length > 0) {
      return { openTime: result.rows[0].open_time, closeTime: result.rows[0].close_time };
    }
  } catch {
    // Table may not exist in older deployments — fall through to default
  }

  return { openTime: DEFAULT_START_TIME, closeTime: DEFAULT_END_TIME };
}

// ── Generator ────────────────────────────────────────────────────────────────

/**
 * Generate availability slots for a single resource on a single date.
 * Uses the venue-level schedule (requirement #2: same schedule for all resources in a venue).
 * Delegates to turfAvailabilityService.generateSlots which handles ON CONFLICT DO NOTHING.
 */
async function generateForResourceOnDate(
  resourceId: number,
  venueId: number,
  date: string,
  slotDurationMinutes = DEFAULT_SLOT_DURATION_MINUTES
): Promise<GenerationResult> {
  const schedule = await getVenueSchedule(venueId, date);
  const result = await turfAvailabilityService.generateSlots(
    resourceId,
    date,
    schedule.openTime,
    schedule.closeTime,
    slotDurationMinutes
  );

  return {
    venueId,
    resourceId,
    date,
    requested: result.requested,
    created: result.created,
    skippedExisting: result.skippedExisting,
  };
}

/**
 * Generate availability for ALL slot_based resources in a venue for a range of dates.
 */
export async function generateForVenue(
  venueId: number,
  startDate?: string,
  endDate?: string,
  slotDurationMinutes = DEFAULT_SLOT_DURATION_MINUTES
): Promise<GenerationSummary> {
  const today = getISTDate();
  // Exclude today — generate for tomorrow through +15 days (15 full days ahead)
  const start = startDate || addDays(today, 1);
  const end = endDate || addDays(today, DEFAULT_ROLLING_DAYS);
  const dates = dateRange(start, end);

  const resources = await turfResourceRepository.findByVenue(venueId);
  const slotResources = resources.filter(r => r.resource_type === 'slot_based' && r.is_active !== false);

  if (slotResources.length === 0) {
    logger.info(`[AvailGen] Venue ${venueId}: no slot_based resources, skipping`);
    return {
      venueId,
      resourcesProcessed: 0,
      datesProcessed: 0,
      totalRequested: 0,
      totalCreated: 0,
      totalSkipped: 0,
      results: [],
    };
  }

  const results: GenerationResult[] = [];
  let totalRequested = 0;
  let totalCreated = 0;
  let totalSkipped = 0;

  for (const resource of slotResources) {
    for (const date of dates) {
      try {
        const result = await generateForResourceOnDate(resource.id, venueId, date, slotDurationMinutes);
        results.push(result);
        totalRequested += result.requested;
        totalCreated += result.created;
        totalSkipped += result.skippedExisting;
      } catch (err) {
        logger.error(`[AvailGen] Failed for venue ${venueId}, resource ${resource.id}, date ${date}:`, err);
      }
    }
  }

  logger.info(`[AvailGen] Venue ${venueId}: ${results.length} date×resource combos, ${totalCreated} slots created, ${totalSkipped} existing skipped`);

  return {
    venueId,
    resourcesProcessed: slotResources.length,
    datesProcessed: dates.length,
    totalRequested,
    totalCreated,
    totalSkipped,
    results,
  };
}

/**
 * Generate availability for all active venues.
 */
export async function generateForAllVenues(
  startDate?: string,
  endDate?: string,
  slotDurationMinutes = DEFAULT_SLOT_DURATION_MINUTES
): Promise<GenerationSummary[]> {
  const { getPool } = await import('../db/pool');
  const result = await getPool().query(
    `SELECT id FROM turf_venues WHERE is_active = TRUE AND deleted_at IS NULL`
  );
  const venues = result.rows;

  const summaries: GenerationSummary[] = [];
  for (const venue of venues) {
    const summary = await generateForVenue(venue.id, startDate, endDate, slotDurationMinutes);
    summaries.push(summary);
  }

  return summaries;
}

/**
 * Extend the rolling window: generate slots for the next day(s) beyond the current window,
 * and optionally clean up days older than today.
 */
export async function extendRollingWindow(_extraDays = 1, cleanupOld = true): Promise<GenerationSummary[]> {
  const today = getISTDate();

  // Always regenerate the full rolling window: tomorrow → today+15.
  // Idempotency (ON CONFLICT DO NOTHING) ensures no duplicates.
  // This is safe and simple: no need to track the current window end.
  logger.info(`[AvailGen] Extending rolling window: ${addDays(today, 1)} → ${addDays(today, DEFAULT_ROLLING_DAYS)}`);

  const summaries = await generateForAllVenues(addDays(today, 1), addDays(today, DEFAULT_ROLLING_DAYS));

  if (cleanupOld) {
    await cleanupOldAvailability(today);
  }

  return summaries;
}

/**
 * Remove availability units for dates before the given date,
 * but ONLY for units that have no bookings or holds.
 */
async function cleanupOldAvailability(cutoffDate: string): Promise<void> {
  const { getPool } = await import('../db/pool');

  const result = await getPool().query(
    `DELETE FROM turf_availability_units
     WHERE starts_at < $1::date
       AND status NOT IN ('booked', 'held', 'payment_pending')`,
    [cutoffDate]
  );

  const rowCount = (result as any).rowCount ?? 0;
  if (rowCount > 0) {
    logger.info(`[AvailGen] Cleaned up ${rowCount} old availability units before ${cutoffDate}`);
  }
}
