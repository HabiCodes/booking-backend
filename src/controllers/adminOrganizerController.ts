/**
 * Super Admin Organizer Management Controller
 *
 * Provides endpoints for:
 *  - List/search/filter organizer applications
 *  - View application details with history
 *  - Approve / soft-reject / hard-reject / reopen applications
 *  - List all organizations
 *  - List managers across organizations
 *
 * All endpoints require super_admin role or organizer:applications:* permissions.
 */

import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import { organizerApplicationService } from '../services/organizerApplicationService';
import { organizationRepository } from '../repositories/organizationRepository';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { AppError } from '../middleware/errorHandler';

// ── Organizer Applications ────────────────────────────────────────────────────

export async function listOrganizerApplications(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 100);
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await organizerApplicationService.listApplications({
      status,
      page,
      pageSize,
      search,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function getOrganizerApplication(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await organizerApplicationService.getApplicationWithHistory(id);
    if (!result) throw new AppError('Application not found', 404);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function reviewOrganizerApplication(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, reason } = req.body as { action: string; reason?: string };

    if (!['approve', 'soft_reject', 'hard_reject', 'reopen'].includes(action)) {
      throw new AppError('Invalid action. Use: approve, soft_reject, hard_reject, reopen', 400);
    }

    const actor = { adminId: req.admin!.id, name: req.admin!.email };
    let result;

    switch (action) {
      case 'approve':
        result = await organizerApplicationService.approve(id, actor, reason);
        break;
      case 'soft_reject':
        if (!reason?.trim()) throw new AppError('Reason is required for soft rejection', 400);
        result = await organizerApplicationService.softReject(id, { action: 'soft_reject', reason: reason.trim() }, actor);
        break;
      case 'hard_reject':
        if (!reason?.trim()) throw new AppError('Reason is required for hard rejection', 400);
        result = await organizerApplicationService.hardReject(id, { action: 'hard_reject', reason: reason.trim() }, actor);
        break;
      case 'reopen':
        result = await organizerApplicationService.reopen(id, actor, reason);
        break;
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── Organizations ─────────────────────────────────────────────────────────────

export async function listOrganizations(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 100);
    const search = req.query.search as string | undefined;
    const isActive = req.query.is_active !== 'false';

    const result = await organizationRepository.findAll({ page, pageSize, search, isActive });
    res.json({ success: true, data: result.items, pagination: result });
  } catch (err) {
    next(err);
  }
}

export async function getOrganization(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const org = await organizationRepository.findById(id);
    if (!org) throw new AppError('Organization not found', 404);

    // Include managers
    const managers = await organizerUserRepository.findByOrganization(id);

    res.json({ success: true, data: { ...org, managers } });
  } catch (err) {
    next(err);
  }
}

export async function updateOrganization(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;

    const org = await organizationRepository.update(id, updates);
    if (!org) throw new AppError('Organization not found', 404);

    res.json({ success: true, data: org });
  } catch (err) {
    next(err);
  }
}

export async function deactivateOrganization(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await organizationRepository.deactivate(id);
    res.json({ success: true, message: 'Organization deactivated' });
  } catch (err) {
    next(err);
  }
}

export async function reactivateOrganization(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await organizationRepository.reactivate(id);
    res.json({ success: true, message: 'Organization reactivated' });
  } catch (err) {
    next(err);
  }
}

// ── Managers (organizer users visible to Super Admin) ─────────────────────────

export async function listManagers(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 100);
    const organizationId = req.query.organization_id ? parseInt(req.query.organization_id as string, 10) : undefined;
    const search = req.query.search as string | undefined;

    const result = await organizerUserRepository.listAll({ page, pageSize, organizationId, search });
    res.json({ success: true, data: result.items, pagination: result });
  } catch (err) {
    next(err);
  }
}

export async function getManager(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const user = await organizerUserRepository.findById(id);
    if (!user) throw new AppError('Manager not found', 404);

    const { password_hash: _, ...safe } = user as unknown as Record<string, unknown>;
    res.json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
}

export async function createManager(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { organization_id, email, name, phone, role, permissions } = req.body;

    if (!organization_id || !email || !name) {
      throw new AppError('organization_id, email, and name are required', 400);
    }
    const tempPassword = generateTempPassword();

    const normalizedRole = (role === 'manager') ? 'manager' : 'manager';
    if (role !== undefined && role !== 'manager') {
      throw new AppError('Role must be "manager"', 400);
    }

    const user = await organizerUserRepository.create({
      organization_id,
      email,
      name,
      phone: phone ?? null,
      password: tempPassword,
      role: normalizedRole,
      permissions: permissions || {},
    });

    const { password_hash: _, ...safe } = user as unknown as Record<string, unknown>;
    res.status(201).json({ success: true, data: safe, temp_password: tempPassword });
  } catch (err) {
    next(err);
  }
}

export async function updateManager(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;

    if (updates.password) {
      throw new AppError('Use the password reset endpoint to change passwords', 400);
    }

    const user = await organizerUserRepository.update(id, updates);
    if (!user) throw new AppError('Manager not found', 404);

    const { password_hash: _, ...safe } = user as unknown as Record<string, unknown>;
    res.json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
}

export async function deactivateManager(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await organizerUserRepository.update(id, { is_active: false });
    res.json({ success: true, message: 'Manager deactivated' });
  } catch (err) {
    next(err);
  }
}

export async function reactivateManager(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await organizerUserRepository.update(id, { is_active: true });
    res.json({ success: true, message: 'Manager reactivated' });
  } catch (err) {
    next(err);
  }
}

export const adminOrganizerController = {
  listOrganizerApplications,
  getOrganizerApplication,
  reviewOrganizerApplication,
  listOrganizations,
  getOrganization,
  updateOrganization,
  deactivateOrganization,
  reactivateOrganization,
  listManagers,
  getManager,
  createManager,
  updateManager,
  deactivateManager,
  reactivateManager,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => chars[b % chars.length]).join('');
}
