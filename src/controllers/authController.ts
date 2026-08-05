import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import { AppError } from '../middleware/errorHandler';
import { sanitizeString, validateEmail } from '../middleware/validator';

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);
    if (!validateEmail(email)) throw new AppError('Invalid email format', 400);
    if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400);

    const result = await authService.register(sanitizeString(email), password);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);

    const result = await authService.login(sanitizeString(email), password);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
