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

/**
 * Sanitize free-text input to prevent XSS in API responses.
 * Strips HTML tags, null bytes, and control characters.
 * Returns the sanitized string, or throws AppError if input is invalid.
 */
export function sanitizeFreeText(input: string, fieldName = 'text', maxLength = 2000): string {
  if (!input || typeof input !== 'string') {
    throw new AppError(`${fieldName} is required`, 400);
  }
  if (input.length > maxLength) {
    throw new AppError(`${fieldName} exceeds ${maxLength} characters`, 400);
  }
  // Strip HTML tags, null bytes, and control characters except newline/tab
  const sanitized = input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control chars
    .replace(/<[^>]*>/g, '') // HTML tags
    .trim();
  if (sanitized.length === 0) {
    throw new AppError(`${fieldName} cannot be empty`, 400);
  }
  return sanitized;
}
