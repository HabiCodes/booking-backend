import { userRepository } from '../repositories/userRepository';
import { AppError } from '../middleware/errorHandler';
import { generateUserToken } from '../utils/jwt';

export class AuthService {
  async register(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      throw new AppError('Email already registered', 409);
    }

    const userId = await userRepository.create(email, password);
    const token = generateUserToken(userId, email);

    return {
      token,
      user: { id: userId, email: email.toLowerCase().trim() },
    };
  }

  async login(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    const valid = await userRepository.verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new AppError('Invalid email or password', 401);
    }

    const token = generateUserToken(user.id, user.email);
    return {
      token,
      user: { id: user.id, email: user.email },
    };
  }
}

export const authService = new AuthService();
