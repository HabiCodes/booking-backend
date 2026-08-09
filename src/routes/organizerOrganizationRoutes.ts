import { Router } from 'express';
import {
  getOwnOrganization,
  getOrganization,
  updateOrganization,
  updateBanking,
  deactivateOrganization,
  reactivateOrganization,
} from '../controllers/organizerOrganizationController';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';

const router = Router();

router.use(organizerAuthMiddleware);

router.get('/me', getOwnOrganization);
router.get('/:id', getOrganization);
router.patch('/:id', updateOrganization);
router.patch('/:id/banking', updateBanking);
router.post('/:id/deactivate', deactivateOrganization);
router.post('/:id/reactivate', reactivateOrganization);

export default router;
