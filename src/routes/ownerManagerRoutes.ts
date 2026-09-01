/**
 * Owner-side manager management + QR analytics routes.
 *
 * Authorization: organizerAuthMiddleware (owner or manager of the org).
 * All endpoints are scoped to req.organizerUser!.organizationId.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { organizerAuthMiddleware, revokeOrganizerSessionsRedis, type OrganizerRequest } from '../middleware/organizerAuth';
import { requireOwner } from '../middleware/organizerPermissions';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { auditLogRepository } from '../repositories/auditLogRepository';
import { organizerRefreshTokenRepository } from '../repositories/organizerRefreshTokenRepository';
import { managerAnalyticsService } from '../services/managerAnalyticsService';
import { AppError } from '../middleware/errorHandler';
import { hashPassword } from '../utils/crypto';

const router = Router();
router.use(organizerAuthMiddleware);

// ── Helpers ──────────────────────────────────────────────────────────────────

function orgId(req: OrganizerRequest): number {
  return req.organizerUser!.organizationId;
}

async function audit(req: OrganizerRequest, action: string, entityType: string, entityId: number, metadata: Record<string, unknown> = {}) {
  try {
    await auditLogRepository.insert({
      adminId: req.organizerUser!.id,
      action,
      entityType,
      entityId,
      metadata: { ...metadata, organization_id: req.organizerUser!.organizationId },
    });
  } catch {
    // audit failures are non-fatal
  }
}

// ── Manager CRUD ─────────────────────────────────────────────────────────────

/**
 * GET /api/owner/managers
 */
router.get('/managers', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizerUser!.organizationId;
    const search = (req.query.search as string) || undefined;
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 100);

    const result = organizerUserRepository.listAll({ organizationId: orgId, search, role: 'manager', page, pageSize });
    const items = await result;

    res.json({ success: true, data: items.items, pagination: items });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/owner/managers/:id
 */
router.get('/managers/:id', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }

    const { password_hash: _, ...safe } = manager;
    res.json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/owner/managers
 */
router.post('/managers', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizerUser!.organizationId;
    const { email, name, phone, password, permissions } = req.body as {
      email: string;
      name: string;
      phone?: string;
      password: string;
      permissions?: Record<string, boolean>;
    };

    if (!email || !name || !password) {
      throw new AppError('email, name, and password are required', 400);
    }

    const user = await organizerUserRepository.create({
      organization_id: orgId,
      email: email.toLowerCase().trim(),
      name,
      phone: phone ?? null,
      password,
      role: 'manager',
      permissions: permissions || {},
    });

    await audit(req, 'manager.create', 'manager', user.id, { email: user.email });

    const { password_hash: _, ...safe } = user as unknown as Record<string, unknown>;
    res.status(201).json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/owner/managers/:id
 */
router.patch('/managers/:id', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }

    const updates: Record<string, unknown> = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
    if (req.body.permissions !== undefined) updates.permissions = req.body.permissions;
    if (req.body.assigned_venue_ids !== undefined) updates.assigned_venue_ids = req.body.assigned_venue_ids;

    const updated = await organizerUserRepository.update(managerId, updates);
    if (!updated) throw new AppError('Update failed', 500);

    await audit(req, 'manager.update', 'manager', managerId, { changes: Object.keys(updates) });

    const { password_hash: _, ...safe } = updated as unknown as Record<string, unknown>;
    res.json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/owner/managers/:id/disable
 */
router.post('/managers/:id/disable', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }
    if (manager.role === 'owner') {
      throw new AppError('Cannot disable the organization owner', 400);
    }

    await organizerUserRepository.update(managerId, { is_active: false });
    // Invalidate all existing JWT sessions via Redis (immediate effect)
    await revokeOrganizerSessionsRedis(managerId);
    // Also revoke all DB-level refresh tokens + sessions
    await organizerRefreshTokenRepository.revokeAllUserRefreshTokens(managerId);
    await organizerRefreshTokenRepository.revokeAllUserSessions(managerId);
    await audit(req, 'manager.disable', 'manager', managerId, { email: manager.email });

    res.json({ success: true, message: 'Manager access disabled' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/owner/managers/:id/enable
 */
router.post('/managers/:id/enable', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }

    await organizerUserRepository.update(managerId, { is_active: true });
    await audit(req, 'manager.enable', 'manager', managerId, { email: manager.email });

    res.json({ success: true, message: 'Manager access enabled' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/owner/managers/:id/reset-password
 */
router.post('/managers/:id/reset-password', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }

    const tempPassword = `Tmp${Math.random().toString(36).slice(2, 10).toUpperCase()}!`;
    const passwordHash = await hashPassword(tempPassword);
    await organizerUserRepository.setPassword(managerId, passwordHash, true);

    // Revoke all existing sessions so the old JWT is invalidated immediately
    await revokeOrganizerSessionsRedis(managerId);
    await organizerRefreshTokenRepository.revokeAllUserRefreshTokens(managerId);
    await organizerRefreshTokenRepository.revokeAllUserSessions(managerId);

    await audit(req, 'manager.reset_password', 'manager', managerId, { email: manager.email });

    res.json({ success: true, temp_password: tempPassword });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/owner/managers/:id
 *
 * Soft-delete by anonymizing: keep financial/historical records intact
 * but remove PII.
 */
router.delete('/managers/:id', requireOwner, async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const managerId = parseInt(req.params.id, 10);
    const manager = await organizerUserRepository.findById(managerId);
    if (!manager) throw new AppError('Manager not found', 404);
    if (manager.organization_id !== orgId(req)) {
      throw new AppError('Access denied', 403);
    }
    if (manager.role === 'owner') {
      throw new AppError('Cannot delete the organization owner', 400);
    }

    // Anonymize to preserve referential integrity
    await organizerUserRepository.update(managerId, {
      name: `[deleted-${managerId}]`,
      email: `deleted-${managerId}@removed.local`,
      phone: null,
      is_active: false,
    });

    // Revoke all active sessions so existing JWTs are invalidated
    await revokeOrganizerSessionsRedis(managerId);
    await organizerRefreshTokenRepository.revokeAllUserRefreshTokens(managerId);
    await organizerRefreshTokenRepository.revokeAllUserSessions(managerId);

    await audit(req, 'manager.delete', 'manager', managerId, { email: manager.email });

    res.json({ success: true, message: 'Manager removed' });
  } catch (err) {
    next(err);
  }
});

// ── Manager Analytics ────────────────────────────────────────────────────────

/**
 * GET /api/owner/managers/analytics
 */
router.get('/managers/analytics', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    const data = await managerAnalyticsService.getManagerAnalytics(req.organizerUser!.organizationId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
