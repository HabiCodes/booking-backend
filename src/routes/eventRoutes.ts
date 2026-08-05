import { Router } from 'express';
import { listEvents, getEvent, getStats } from '../controllers/eventController';

const router = Router();

router.get('/', listEvents);
router.get('/:id/stats', getStats);
router.get('/:id', getEvent);

export default router;
