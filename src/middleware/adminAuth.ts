import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';

export interface AdminRequest extends Request {
  admin?: { id: number; email: string };
}

export function adminAuthMiddleware(
  req: AdminRequest,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError('Unauthorized', 401);
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwt.adminSecret) as { id: number; email: string };
    req.admin = decoded;
    next();
  } catch {
    throw new AppError('Invalid or expired admin token', 401);
  }
}
