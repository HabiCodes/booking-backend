/**
 * Password strength policy — configurable, production-grade defaults.
 *
 * The policy is intentionally opinionated: strong passwords are a small
 * but critical defense against credential stuffing and brute force.
 */

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecialChar: boolean;
  specialCharRegex: RegExp;
}

export const defaultPasswordPolicy: PasswordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
  specialCharRegex: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/,
};

export interface PasswordPolicyResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string, policy: PasswordPolicy = defaultPasswordPolicy): PasswordPolicyResult {
  const errors: string[] = [];

  if (!password || password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters`);
  }
  if (password && password.length > policy.maxLength) {
    errors.push(`Password must be at most ${policy.maxLength} characters`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (policy.requireSpecialChar && !policy.specialCharRegex.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return { valid: errors.length === 0, errors };
}