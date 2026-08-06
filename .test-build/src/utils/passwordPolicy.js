"use strict";
/**
 * Password strength policy — configurable, production-grade defaults.
 *
 * The policy is intentionally opinionated: strong passwords are a small
 * but critical defense against credential stuffing and brute force.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultPasswordPolicy = void 0;
exports.validatePassword = validatePassword;
exports.defaultPasswordPolicy = {
    minLength: 8,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecialChar: true,
    specialCharRegex: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/,
};
function validatePassword(password, policy = exports.defaultPasswordPolicy) {
    const errors = [];
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
