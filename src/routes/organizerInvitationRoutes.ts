/**
 * Organizer Invitation Routes.
 *
 * Flow:
 * 1. Owner creates invitation → returns plaintext token for email delivery
 * 2. User clicks link → public endpoint verifies token
 * 3. User accepts → creates organizer_user account
 *
 * Mount: /api/owner/invitations (owner-only, requires organizerAuthMiddleware)
 *         /api/invitations (public, no auth required)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { organizerAuthMiddleware, type OrganizerRequest } from '../middleware/organizerAuth';
import { organizerInvitationService } from '../services/organizerInvitationService';
import { AppError } from '../middleware/errorHandler';

// Owner routes (require auth)
const ownerRouter = Router();
ownerRouter.use(organizerAuthMiddleware);

function orgId(req: OrganizerRequest): number {
  return req.organizerUser!.organizationId;
}

// POST /api/owner/invitations
ownerRouter.post('/', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.organizerUser!.id;
    const { email, role, message, expiresInHours } = req.body as {
      email: string;
      role?: string;
      message?: string;
      expiresInHours?: number;
    };

    if (!email) {
      throw new AppError('Email is required', 400);
    }

    const result = await organizerInvitationService.createInvitation(userId, orgId(req), {
      email,
      role: (role || 'manager') as 'manager',
      message,
      expiresInHours,
    });

    res.status(201).json({
      success: true,
      data: result.invitation,
      plaintextToken: result.plaintextToken, // Returned ONCE for email delivery
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/owner/invitations
ownerRouter.get('/', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const invitations = await organizerInvitationService.listPendingInvitations(orgId(req), req.organizerUser!.id);
    res.json({ success: true, data: invitations });
  } catch (err) {
    next(err);
  }
});

// GET /api/owner/invitations/:id
ownerRouter.get('/:id', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseInt(req.params.id, 10);
    const invitation = await organizerInvitationService.getInvitation(invitationId, req.organizerUser!.id);
    res.json({ success: true, data: invitation });
  } catch (err) {
    next(err);
  }
});

// POST /api/owner/invitations/:id/resend
ownerRouter.post('/:id/resend', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseInt(req.params.id, 10);
    const result = await organizerInvitationService.resendInvitation(invitationId, req.organizerUser!.id);
    res.json({
      success: true,
      data: result.invitation,
      plaintextToken: result.plaintextToken, // New token returned
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/owner/invitations/:id/revoke
ownerRouter.post('/:id/revoke', async (req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseInt(req.params.id, 10);
    await organizerInvitationService.revokeInvitation(invitationId, req.organizerUser!.id);
    res.json({ success: true, message: 'Invitation revoked' });
  } catch (err) {
    next(err);
  }
});

// ── Public routes (no auth required) ───────────────────────────────────────

const publicRouter = Router();

// GET /api/invitations/verify/:token
publicRouter.get('/verify/:token', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await organizerInvitationService.verifyInvitationToken(req.params.token);
    if (!result.valid) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/accept
publicRouter.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, name, password } = req.body as {
      token: string;
      name: string;
      password: string;
    };

    if (!token || !name || !password) {
      throw new AppError('token, name, and password are required', 400);
    }

    if (password.length < 8) {
      throw new AppError('Password must be at least 8 characters', 400);
    }

    const user = await organizerInvitationService.acceptInvitation(token, { name, password });
    res.status(201).json({
      success: true,
      data: user,
      message: 'Invitation accepted. You can now log in.',
    });
  } catch (err) {
    next(err);
  }
});

export const organizerInvitationRoutes = {
  owner: ownerRouter,
  public: publicRouter,
};