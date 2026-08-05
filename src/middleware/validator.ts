import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

export function validateBody(schema: (req: Request, res: Response, next: NextFunction) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

export function sanitizeString(str: string): string {
  return str.trim().replace(/\s+/g, ' ');
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePhone(phone: string): boolean {
  return /^[+]?[\d\s\-()]{7,15}$/.test(phone);
}

export function validateAge(age: string): boolean {
  if (!age) return true;
  const n = parseInt(age, 10);
  return !isNaN(n) && n >= 1 && n <= 120;
}

export function validateGender(gender: string | undefined): boolean {
  if (!gender) return true;
  return ['male', 'female', 'other'].includes(gender.toLowerCase());
}
