import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';
import { generateAdminAccessToken } from '../utils/jwt';

export interface AdminRequest extends Request {
  admin?: {
    id: number;
    email: string;
    role?: string;
    permissions?: Record<string, boolean>;
  };
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
    const decoded = jwt.verify(token, config.jwt.adminSecret) as {
      id: number;
      email: string;
      role?: string;
      permissions?: Record<string, boolean>;
    };
    req.admin = decoded;
    next();
  } catch {
    throw new AppError('Invalid or expired admin token', 401);
  }
}
