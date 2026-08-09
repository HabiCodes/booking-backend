import { Request, Response, NextFunction } from 'express';
import { organizerOrganizationService } from '../services/organizerOrganizationService';
import { AppError } from '../middleware/errorHandler';
import { organizerAuthMiddleware, OrganizerRequest } from '../middleware/organizerAuth';

export async function getOwnOrganization(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const org = await organizerOrganizationService.getOwnOrganization(req.organizerUser!.id);
    res.json({ success: true, data: org });
  } catch (err) {
    next(err);
  }
}

export async function getOrganization(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const org = await organizerOrganizationService.getById(Number(req.params.id), req.organizerUser!.id);
    res.json({ success: true, data: org });
  } catch (err) {
    next(err);
  }
}

export async function updateOrganization(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const org = await organizerOrganizationService.update(Number(req.params.id), req.body, req.organizerUser!.id);
    res.json({ success: true, data: org });
  } catch (err) {
    next(err);
  }
}

export async function updateBanking(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const org = await organizerOrganizationService.updateBanking(Number(req.params.id), req.body, req.organizerUser!.id);
    res.json({ success: true, data: org });
  } catch (err) {
    next(err);
  }
}

export async function deactivateOrganization(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    await organizerOrganizationService.deactivate(Number(req.params.id), req.organizerUser!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function reactivateOrganization(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    await organizerOrganizationService.reactivate(Number(req.params.id), req.organizerUser!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
