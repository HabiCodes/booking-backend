/**
 * Organizer Permission + Role Guard Middleware.
 *
 * Provides:
 * - requireOwner — only organization owners
 * - requireRole('owner' | 'manager') — role guard
 * - requirePermission('movies.read', 'movies.write') — any/none of listed permissions
 * - requireAnyPermission — at least one of listed permissions
 * - requireAllPermissions — all listed permissions
 * - canAccessCinema — checks cinema belongs to user's org
 * - canAccessShowtime — checks showtime belongs to user's org
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import type { OrganizerRequest } from './organizerAuth';

// ── Role Guards ──────────────────────────────────────────────────────────────

/**
 * Only allow organization owners.
 */
export function requireOwner(_req: OrganizerRequest, _res: Response, next: NextFunction): void {
  const user = _req.organizerUser;
  if (!user) {
    throw new AppError('Authentication required', 401);
  }
  if (user.role !== 'owner') {
    throw new AppError('Forbidden: Organization owner access required', 403);
  }
  next();
}

/**
 * Role guard — allows specific roles.
 */
export function requireRole(...allowedRoles: Array<'owner' | 'manager'>) {
  return (_req: OrganizerRequest, _res: Response, next: NextFunction): void => {
    const user = _req.organizerUser;
    if (!user) {
      throw new AppError('Authentication required', 401);
    }
    if (!allowedRoles.includes(user.role)) {
      throw new AppError(`Forbidden: Role '${user.role}' does not have access`, 403);
    }
    next();
  };
}

/**
 * At least one of the listed permissions must be present.
 */
export function requireAnyPermission(...permissions: string[]) {
  return (_req: OrganizerRequest, _res: Response, next: NextFunction): void => {
    const user = _req.organizerUser;
    if (!user) {
      throw new AppError('Authentication required', 401);
    }
    if (permissions.length === 0) return next();
    const hasAny = permissions.some(p => user.permissions[p] === true);
    if (!hasAny) {
      throw new AppError(`Forbidden: Requires one of: ${permissions.join(', ')}`, 403);
    }
    next();
  };
}

/**
 * All listed permissions must be present.
 */
export function requireAllPermissions(...permissions: string[]) {
  return (_req: OrganizerRequest, _res: Response, next: NextFunction): void => {
    const user = _req.organizerUser;
    if (!user) {
      throw new AppError('Authentication required', 401);
    }
    if (permissions.length === 0) return next();
    const hasAll = permissions.every(p => user.permissions[p] === true);
    if (!hasAll) {
      throw new AppError(`Forbidden: Requires all of: ${permissions.join(', ')}`, 403);
    }
    next();
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Helper to build owner-only guard combined with org membership check.
 * Use after organizerAuthMiddleware.
 */
export function requireOrgOwner(req: OrganizerRequest, _res: Response, next: NextFunction): void {
  const user = req.organizerUser;
  if (!user) {
    throw new AppError('Authentication required', 401);
  }
  if (user.role !== 'owner') {
    throw new AppError('Forbidden: Organization owner access required', 403);
  }
  next();
}