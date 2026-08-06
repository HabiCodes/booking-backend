"use strict";
/**
 * Environment validation — runs once at startup and refuses to boot if
 * the configuration is unsafe or incomplete.
 *
 * Design goals:
 *   - Run fast (no I/O, just env reads)
 *   - Surface ALL problems in one go (don't fail on the first)
 *   - Never throw in test environments
 *   - Provide typed access to validated config downstream
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
exports.assertValidEnvOrExit = assertValidEnvOrExit;
const logger_1 = require("./logger");
const PRODUCTION_REQUIRED = [
    { key: 'JWT_SECRET', required: true, hint: 'A long random string — used to sign user JWTs.' },
    { key: 'ADMIN_JWT_SECRET', required: true, hint: 'A long random string — used to sign admin JWTs.' },
    { key: 'QR_SIGNING_SECRET', required: true, hint: 'A long random string — used to sign ticket QR payloads.' },
    {
        key: 'JWT_SECRET',
        validate: (v) => v.length >= 16,
        hint: 'JWT_SECRET must be at least 16 characters in production.',
    },
    {
        key: 'ADMIN_JWT_SECRET',
        validate: (v) => v.length >= 16,
        hint: 'ADMIN_JWT_SECRET must be at least 16 characters in production.',
    },
    {
        key: 'QR_SIGNING_SECRET',
        validate: (v) => v.length >= 16,
        hint: 'QR_SIGNING_SECRET must be at least 16 characters in production.',
    },
    {
        key: 'CORS_ORIGIN',
        validate: (v) => v !== '*',
        hint: 'CORS_ORIGIN=* is rejected in production. Set explicit origin(s).',
    },
];
const DEVELOPMENT_REQUIRED = [
// In dev we tolerate missing JWT secrets — the config layer provides
// dev defaults. We still warn so devs know they should set them.
];
const PLACEHOLDER_VALUES = [
    'change-me-user-secret',
    'change-me-admin-secret',
    'change-me-qr-secret',
    'change-me-now',
];
function isPlaceholder(value) {
    if (!value)
        return false;
    return PLACEHOLDER_VALUES.some((p) => value.includes(p));
}
function validateEnv() {
    const isProd = process.env.NODE_ENV === 'production';
    const rules = isProd ? PRODUCTION_REQUIRED : DEVELOPMENT_REQUIRED;
    const errors = [];
    const warnings = [];
    for (const rule of rules) {
        const value = process.env[rule.key];
        if (rule.required && (!value || value.trim().length === 0)) {
            errors.push(`${rule.key} is required. ${rule.hint ?? ''}`);
            continue;
        }
        if (value && isPlaceholder(value)) {
            if (isProd) {
                errors.push(`${rule.key} still has placeholder value "${value}". Generate a real secret.`);
            }
            else {
                warnings.push(`${rule.key} uses placeholder value. Fine in dev, replace before production.`);
            }
        }
        if (value && rule.validate && !rule.validate(value)) {
            errors.push(`${rule.key} is invalid. ${rule.hint ?? ''}`);
        }
    }
    // Database sanity
    if (isProd && !process.env.DATABASE_URL && !process.env.DB_HOST) {
        errors.push('Database not configured. Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.');
    }
    // CORS sanity
    if (isProd && process.env.CORS_ORIGIN === '*') {
        errors.push('CORS_ORIGIN=* is not allowed in production.');
    }
    // Email sanity — warn but don't fail; in production missing the Hostinger
    // token means customers won't get verification mails, but the server can run.
    if (isProd && !process.env.HOSTINGER_API_TOKEN) {
        warnings.push('HOSTINGER_API_TOKEN is not set. Email verification will be logged to the console only.');
    }
    return { valid: errors.length === 0, errors, warnings };
}
/**
 * Run validateEnv and either exit (production) or warn (development).
 */
function assertValidEnvOrExit() {
    const { valid, errors, warnings } = validateEnv();
    for (const w of warnings) {
        logger_1.logger.warn(`ENV: ${w}`);
    }
    if (!valid) {
        logger_1.logger.error('Environment validation failed:');
        for (const e of errors) {
            logger_1.logger.error(`  - ${e}`);
        }
        process.exit(1);
    }
    logger_1.logger.info('Environment validation passed.');
}
