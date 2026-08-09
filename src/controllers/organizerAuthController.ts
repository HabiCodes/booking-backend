import { Request, Response, NextFunction } from 'express';
import { organizerAuthService } from '../services/organizerAuthService';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { AppError } from '../middleware/errorHandler';
import { sanitizeString } from '../middleware/validator';

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new AppError('Email and password are required', 400);
    }

    const result = await organizerAuthService.login({
      email: sanitizeString(email),
      password,
    });

    res.json({
      success: true,
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    });
  } catch (err) {
    return next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 400);
    }

    const payload = organizerAuthService.verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const result = await organizerAuthService.refreshUserTokens(payload.sub);
    if (!result) {
      throw new AppError('User not found or inactive', 401);
    }

    res.json({
      success: true,
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    });
  } catch (err) {
    return next(err);
  }
}
