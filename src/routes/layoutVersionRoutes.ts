/**
 * LayoutVersionController — admin CRUD for screen layout versions.
 *
 * Mounted at /api/admin/v1/layout-versions
 * Requires: admin role with appropriate permissions.
 */

import { Router } from 'express';
import { layoutVersionService } from '../services/layoutVersionService';
import { layoutVersionRepository } from '../repositories/layoutVersionRepository';
import { cinemaScreenRepository } from '../repositories/cinemaScreenRepository';
import type { LayoutVersionCreateInput, LayoutVersionSeatCreateInput } from '../types';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';

const router = Router();

router.use(adminAuthMiddleware);

// ── List all versions for a screen ─────────────────────────────────────────────

router.get('/screen/:screenId', requirePermission('movies:read'), async (req: any, res: any, next: any) => {
  try {
    const screenId = Number(req.params.screenId);
    const versions = await layoutVersionService.listForScreen(screenId);
    res.json({ success: true, data: versions });
  } catch (err) { next(err); }
});

// ── Get current version for a screen ──────────────────────────────────────────

router.get('/screen/:screenId/current', requirePermission('movies:read'), async (req: any, res: any, next: any) => {
  try {
    const screenId = Number(req.params.screenId);
    const version = await layoutVersionService.getCurrent(screenId);
    if (!version) {
      return res.status(404).json({ success: false, message: 'No current layout version found for this screen' });
    }
    res.json({ success: true, data: version });
  } catch (err) { next(err); }
});

// ── Get a specific version ─────────────────────────────────────────────────────

router.get('/:id', requirePermission('movies:read'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const version = await layoutVersionService.getById(id);
    if (!version) {
      return res.status(404).json({ success: false, message: 'Layout version not found' });
    }

    const seats = await layoutVersionService.getSeats(id);
    res.json({ success: true, data: { ...version, seats } });
  } catch (err) { next(err); }
});

// ── Get seats for a layout version ────────────────────────────────────────────

router.get('/:id/seats', requirePermission('movies:read'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const seats = await layoutVersionService.getSeats(id);
    res.json({ success: true, data: seats });
  } catch (err) { next(err); }
});

// ── Create a new layout version ────────────────────────────────────────────────

router.post('/', requirePermission('movies:write'), auditMiddleware('layout_version.create'), async (req: any, res: any, next: any) => {
  try {
    const { screenId, versionNumber, name, description, seatCapacity, rowLabels, seatsPerRow, seatStartNumber, pricingRules, seats: seatInputs } = req.body;

    if (!screenId || !seatCapacity) {
      return res.status(400).json({ success: false, message: 'screenId and seatCapacity are required' });
    }

    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) {
      return res.status(404).json({ success: false, message: 'Screen not found' });
    }

    const input: LayoutVersionCreateInput = {
      screenId,
      versionNumber,
      name,
      description,
      seatCapacity,
      rowLabels: rowLabels ?? screen.row_labels,
      seatsPerRow: seatsPerRow ?? screen.seats_per_row,
      seatStartNumber: seatStartNumber ?? screen.seat_start_number,
      pricingRules: pricingRules ?? {},
    };

    const seatCreateInputs: LayoutVersionSeatCreateInput[] = (seatInputs || []).map((s: Record<string, unknown>) => ({
      layoutVersionId: 0, // Will be set by the service
      rowLabel: s.rowLabel as string,
      seatNumber: s.seatNumber as number,
      seatType: (s.seatType as string) || 'standard',
      seatCategory: (s.seatCategory as string) || 'regular',
      xPosition: s.xPosition as number | null,
      yPosition: s.yPosition as number | null,
      isAvailable: s.isAvailable ?? true,
    }));

    const version = await layoutVersionService.createVersion(input, seatCreateInputs);
    res.status(201).json({ success: true, data: version });
  } catch (err) { next(err); }
});

// ── Create new version from current screen layout ──────────────────────────────

router.post('/screen/:screenId/new-version', requirePermission('movies:write'), auditMiddleware('layout_version.create_from_screen'), async (req: any, res: any, next: any) => {
  try {
    const screenId = Number(req.params.screenId);
    const { name, description } = req.body;

    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) {
      return res.status(404).json({ success: false, message: 'Screen not found' });
    }

    const version = await layoutVersionService.createNewVersionFromScreen(screenId, name || 'Updated Layout', description);
    res.status(201).json({ success: true, data: version });
  } catch (err) { next(err); }
});

// ── Set a version as current ───────────────────────────────────────────────────

router.patch('/:id/set-current', requirePermission('movies:write'), auditMiddleware('layout_version.set_current'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const version = await layoutVersionRepository.findById(id);
    if (!version) {
      return res.status(404).json({ success: false, message: 'Layout version not found' });
    }

    const updated = await layoutVersionService.setCurrentVersion(version.screen_id, id);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Layout version not found' });
    }
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// ── Add seat to a layout version ───────────────────────────────────────────────

router.post('/:id/seats', requirePermission('movies:write'), auditMiddleware('layout_version.add_seat'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const { rowLabel, seatNumber, seatType, seatCategory, xPosition, yPosition, isAvailable } = req.body;

    if (!rowLabel || !seatNumber) {
      return res.status(400).json({ success: false, message: 'rowLabel and seatNumber are required' });
    }

    const seat = await layoutVersionService.addSeat(id, {
      layoutVersionId: id,
      rowLabel,
      seatNumber,
      seatType: seatType || 'standard',
      seatCategory: seatCategory || 'regular',
      xPosition: xPosition ?? null,
      yPosition: yPosition ?? null,
      isAvailable: isAvailable ?? true,
    });

    res.status(201).json({ success: true, data: seat });
  } catch (err) { next(err); }
});

// ── Sync seats from screen to layout version ───────────────────────────────────

router.post('/:id/sync-seats', requirePermission('movies:write'), auditMiddleware('layout_version.sync_seats'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    const version = await layoutVersionRepository.findById(id);
    if (!version) {
      return res.status(404).json({ success: false, message: 'Layout version not found' });
    }

    const seats = await layoutVersionService.syncSeatsFromScreen(id, version.screen_id);
    res.json({ success: true, data: seats });
  } catch (err) { next(err); }
});

// ── Delete a layout version ────────────────────────────────────────────────────

router.delete('/:id', requirePermission('movies:write'), auditMiddleware('layout_version.delete'), async (req: any, res: any, next: any) => {
  try {
    const id = Number(req.params.id);
    await layoutVersionService.deleteVersion(id);
    res.json({ success: true, message: 'Layout version deleted' });
  } catch (err) { next(err); }
});

// ── Initialize layout version for a screen ────────────────────────────────────

router.post('/screen/:screenId/initialize', requirePermission('movies:write'), auditMiddleware('layout_version.initialize'), async (req: any, res: any, next: any) => {
  try {
    const screenId = Number(req.params.screenId);
    const { seatCapacity, rowLabels, seatsPerRow, seats } = req.body;

    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) {
      return res.status(404).json({ success: false, message: 'Screen not found' });
    }

    const seatInputs: LayoutVersionSeatCreateInput[] = (seats || []).map((s: Record<string, unknown>) => ({
      layoutVersionId: 0,
      rowLabel: s.rowLabel as string,
      seatNumber: s.seatNumber as number,
      seatType: (s.seatType as string) || 'standard',
      seatCategory: (s.seatCategory as string) || 'regular',
      xPosition: s.xPosition as number | null,
      yPosition: s.yPosition as number | null,
      isAvailable: s.isAvailable ?? true,
    }));

    const version = await layoutVersionService.createInitialForScreen(
      screenId,
      seatCapacity || screen.seat_capacity,
      rowLabels || screen.row_labels,
      seatsPerRow || screen.seats_per_row,
      seatInputs
    );

    res.status(201).json({ success: true, data: version });
  } catch (err) { next(err); }
});

export { router as layoutVersionRoutes };
