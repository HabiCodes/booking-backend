/**
 * Scanner authorization middleware.
 *
 * Enforces that QR scanning is ONLY performed by authorized staff,
 * NOT by super_admin or platform-level admin accounts.
 *
 * Super admins have broad permissions but MUST NOT scan tickets.
 * Only users with an explicit organization_id (event_manager, ticket_scanner,
 * or custom roles) may scan, and ONLY tickets from their own organization.
 *
 * This middleware must be used AFTER adminAuthMiddleware.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { AdminRequest } from './adminAuth';

/**
 * Block super_admin from accessing QR scanning endpoints.
 * Super admins manage the platform — they never scan tickets.
 *
 * Also ensures the caller has an organization_id (i.e., is org-scoped,
 * not a platform-level admin without org context).
 */
export function requireScannerAuthorization(
  _req: AdminRequest,
  _res: Response,
  next: NextFunction
): void {
  const admin = _req.admin;
  if (!admin) {
    throw new AppError('Unauthorized', 401);
  }

  // Super Admin must never scan tickets
  if (admin.role === 'super_admin') {
    throw new AppError('Super Admin accounts cannot scan tickets', 403);
  }

  // Must have an organization to scan (platform admins without org context cannot scan)
  if (admin.organizationId === undefined || admin.organizationId === null) {
    throw new AppError('Scanner requires an organization context', 403);
  }

  next();
}
