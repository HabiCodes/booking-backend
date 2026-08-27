import { Request, Response, NextFunction } from 'express';
import { organizerAuthService } from '../services/organizerAuthService';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { organizerPasswordTokenService } from '../services/organizerPasswordTokenService';
import { AppError } from '../middleware/errorHandler';
import { sanitizeString } from '../middleware/validator';
import { validatePassword, defaultPasswordPolicy } from '../utils/passwordPolicy';

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

export async function setupPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      throw new AppError('token and password are required', 400);
    }

    // Enforce the full password policy (same as regular registration)
    const policyCheck = validatePassword(password, defaultPasswordPolicy);
    if (!policyCheck.valid) {
      throw new AppError(`Password does not meet requirements: ${policyCheck.errors.join(', ')}`, 400);
    }

    // Consume the token and set password
    const result = await organizerPasswordTokenService.consume(token, password);

    // Get user for response
    const user = await organizerUserRepository.findById(result.userId);
    if (!user) {
      throw new AppError('User not found after password setup', 404);
    }

    // Issue JWT so the owner can immediately log in
    const loginResult = await organizerAuthService.login({
      email: user.email,
      password,
    });

    res.json({
      success: true,
      message: 'Password set successfully',
      data: {
        user: loginResult.user,
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
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

    // Use the full rotation flow: verifies typ, hashes, finds+consumes in DB,
    // detects reuse, validates user still active, and issues new tokens.
    const result = await organizerAuthService.refreshTokens(refreshToken);
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
