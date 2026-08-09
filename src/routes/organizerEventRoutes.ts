import { Router } from 'express';
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  getEventTicketTiers,
  getEventSeats,
  createEventSeats,
} from '../controllers/organizerEventController';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';

const router = Router();

router.use(organizerAuthMiddleware);

router.get('/', listEvents);
router.get('/:id', getEvent);
router.post('/', createEvent);
router.patch('/:id', updateEvent);
router.delete('/:id', deleteEvent);
router.get('/:id/ticket-tiers', getEventTicketTiers);
router.get('/:id/seats', getEventSeats);
router.post('/:id/seats', createEventSeats);

export default router;
