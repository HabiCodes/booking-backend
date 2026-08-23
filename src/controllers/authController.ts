import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import { userRepository } from '../repositories/userRepository';
import { AppError } from '../middleware/errorHandler';
import { sanitizeString, validateEmail } from '../middleware/validator';

// ── Legacy endpoints (backward compatible) ──────────────────────────────────

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);
    if (!validateEmail(email)) throw new AppError('Invalid email format', 400);
    if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400);

    const result = await authService.register(sanitizeString(email), password);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);

    const result = await authService.login(sanitizeString(email), password);
    res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

// ── Enhanced endpoints ──────────────────────────────────────────────────────

export async function registerEnhanced(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, username, password } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);
    if (!validateEmail(email)) throw new AppError('Invalid email format', 400);

    const result = await authService.requestRegistrationOtp(
      sanitizeString(email),
      username ? sanitizeString(username) : null,
      password
    );
    res.status(202).json({
      success: true,
      message: result.message,
      expiresInMinutes: result.expiresInMinutes,
    });
  } catch (err) {
    return next(err);
  }
}

export async function verifyRegistrationOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) throw new AppError('Email and OTP are required', 400);

    const result = await authService.verifyRegistrationOtp(
      sanitizeString(email),
      String(otp).trim(),
      req.ip ?? null,
      req.ip ?? null,
    );

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.status(201).json({
      success: true,
      message: result.message,
      data: result.authResult,
    });
  } catch (err) {
    return next(err);
  }
}

export async function resendRegistrationOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;

    if (!email) throw new AppError('Email is required', 400);

    const result = await authService.resendRegistrationOtp(sanitizeString(email));
    res.json({ success: true, message: result.message });
  } catch (err) {
    return next(err);
  }
}

export async function loginEnhanced(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, deviceInfo } = req.body;

    if (!email || !password) throw new AppError('Email and password are required', 400);

    const result = await authService.login(
      sanitizeString(email),
      password,
      deviceInfo ?? null,
      req.ip ?? null
    );
    res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    // GET /api/v1/auth/verify-email?token=... — token comes from the query
    // string so the endpoint can be triggered from the email link.
    const rawToken = (req.query.token as string | undefined) ?? (req as any).body?.token;

    if (!rawToken) throw new AppError('Verification token is required. Use ?token=...', 400);

    const result = await authService.verifyEmail(rawToken);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.json({ success: true, message: result.message });
  } catch (err) {
    return next(err);
  }
}

export async function resendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;

    if (!email) throw new AppError('Email is required', 400);

    const result = await authService.resendVerification(sanitizeString(email));
    res.json({ success: true, message: result.message });
  } catch (err) {
    return next(err);
  }
}

export async function refreshToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) throw new AppError('Refresh token is required', 400);

    const tokens = await authService.refreshTokens(refreshToken);
    res.json({ success: true, data: tokens });
  } catch (err) {
    return next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await authService.logoutCurrentDevice(refreshToken);
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const result = await authService.logoutAllDevices(userId);
    res.json({
      success: true,
      message: `Logged out from all devices`,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;

    if (!email) throw new AppError('Email is required', 400);

    // Always return success to prevent email enumeration
    await authService.requestPasswordReset(sanitizeString(email));
    res.json({ success: true, message: 'If an account with that email exists, a password reset link has been sent.' });
  } catch (err) {
    return next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      throw new AppError('Token and new password are required', 400);
    }

    if (newPassword.length < 8) {
      throw new AppError('Password must be at least 8 characters', 400);
    }

    await authService.resetPassword(token, newPassword);
    res.json({ success: true, message: 'Password reset successful. Please log in with your new password.' });
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const user = await userRepository.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const { username } = req.body;

    if (username !== undefined) {
      if (typeof username !== 'string') {
        throw new AppError('Username must be a string', 400);
      }
      if (username.length > 50) {
        throw new AppError('Username must be under 50 characters', 400);
      }
    }

    const user = await userRepository.updateProfile(userId, {
      username: username ?? undefined,
    });

    if (!user) throw new AppError('User not found', 404);

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new AppError('Current password and new password are required', 400);
    }

    await authService.changePassword(userId, currentPassword, newPassword);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    return next(err);
  }
}

export async function getMySessions(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const sessions = await authService.getMySessions(userId);
    res.json({ success: true, data: sessions });
  } catch (err) {
    return next(err);
  }
}

export async function revokeMySession(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const { sessionId } = req.body;
    if (!sessionId) throw new AppError('Session ID is required', 400);

    await authService.revokeSession(sessionId);
    res.json({ success: true, message: 'Session revoked' });
  } catch (err) {
    return next(err);
  }
}
