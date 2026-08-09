import { Router } from 'express';
import { login as organizerLogin, refresh as organizerRefresh } from '../controllers/organizerAuthController';

const router = Router();

router.post('/login', organizerLogin);
router.post('/refresh', organizerRefresh);

export default router;
