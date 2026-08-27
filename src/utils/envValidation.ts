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

import { logger } from './logger';

type ValidationRule = {
  key: string;
  required?: boolean;
  /** Predicate returning true if the value is valid */
  validate?: (value: string) => boolean;
  /** One-line hint printed when missing/invalid */
  hint?: string;
};

const PRODUCTION_REQUIRED: ValidationRule[] = [
  {
    key: 'JWT_SECRET',
    required: true,
    validate: (v) => v.length >= 32,
    hint: 'A long random string (≥32 chars) — used to sign user JWTs.',
  },
  {
    key: 'ADMIN_JWT_SECRET',
    required: true,
    validate: (v) => v.length >= 32,
    hint: 'A long random string (≥32 chars) — used to sign admin JWTs.',
  },
  {
    key: 'ORGANIZER_JWT_SECRET',
    required: true,
    validate: (v) => v.length >= 32,
    hint: 'A long random string (≥32 chars) — used to sign organizer JWTs.',
  },
  {
    key: 'QR_SIGNING_SECRET',
    required: true,
    validate: (v) => v.length >= 32,
    hint: 'A long random string (≥32 chars) — used to sign ticket QR payloads.',
  },
  {
    key: 'PAYMENT_WEBHOOK_SECRET',
    hint: 'Payment provider webhook HMAC secret — required to verify incoming webhooks.',
  },
  {
    key: 'CORS_ORIGIN',
    required: true,
    validate: (v) => v !== '*' && v.length > 0,
    hint: 'Set explicit origin(s) — CORS_ORIGIN=* is rejected in production.',
  },
];

const DEVELOPMENT_REQUIRED: ValidationRule[] = [
  {
    key: 'JWT_SECRET',
    validate: (v) => v.length >= 16 || v.length === 0,
    hint: 'JWT_SECRET is using the hardcoded dev default. Set a real value for consistent sessions.',
  },
  {
    key: 'ADMIN_JWT_SECRET',
    validate: (v) => v.length >= 16 || v.length === 0,
    hint: 'ADMIN_JWT_SECRET is using the hardcoded dev default.',
  },
  {
    key: 'ORGANIZER_JWT_SECRET',
    validate: (v) => v.length >= 16 || v.length === 0,
    hint: 'ORGANIZER_JWT_SECRET is using the hardcoded dev default.',
  },
  {
    key: 'QR_SIGNING_SECRET',
    validate: (v) => v.length >= 16 || v.length === 0,
    hint: 'QR_SIGNING_SECRET is using the hardcoded dev default.',
  },
];

const PLACEHOLDER_VALUES = [
  'change-me-user-secret',
  'change-me-admin-secret',
  'change-me-organizer-secret',
  'change-me-qr-secret',
  'change-me-now',
];

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  return PLACEHOLDER_VALUES.some((p) => value.includes(p));
}

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEnv(): EnvValidationResult {
  const isProd = process.env.NODE_ENV === 'production';
  const rules = isProd ? PRODUCTION_REQUIRED : DEVELOPMENT_REQUIRED;

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    const value = process.env[rule.key];

    if (rule.required && (!value || value.trim().length === 0)) {
      errors.push(`${rule.key} is required. ${rule.hint ?? ''}`);
      continue;
    }

    if (value && isPlaceholder(value)) {
      if (isProd) {
        errors.push(`${rule.key} still has placeholder value "${value}". Generate a real secret.`);
      } else {
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

  // Cross-env: warn (or error in prod) when known placeholder secrets are active
  const sensitiveKeys = ['JWT_SECRET', 'ADMIN_JWT_SECRET', 'ORGANIZER_JWT_SECRET', 'QR_SIGNING_SECRET'];
  for (const key of sensitiveKeys) {
    const value = process.env[key];
    if (value && isPlaceholder(value)) {
      if (isProd) {
        errors.push(`${key} still has placeholder value "${value}". Generate a real secret.`);
      } else {
        warnings.push(`${key} uses placeholder value "${value}". Set a real secret before production.`);
      }
    }
  }

  // Email sanity — warn but don't fail; in production missing the Hostinger
  // token means customers won't get verification mails, but the server can run.
  if (isProd && !process.env.HOSTINGER_API_TOKEN) {
    warnings.push(
      'HOSTINGER_API_TOKEN is not set. Email verification will be logged to the console only.',
    );
  }

  // Payment provider sanity — warn if the notify URL is missing in production.
  // Without it, the payment provider cannot deliver payment status webhooks and
  // bookings will get stuck in pending_payment.
  if (isProd && !process.env.PAYMENT_NOTIFY_URL) {
    warnings.push(
      'PAYMENT_NOTIFY_URL is not set. Set it to the full deployed webhook URL (e.g. https://your-app.onrender.com/api/v1/webhooks/payment).',
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Run validateEnv and either exit (production) or warn (development).
 */
export function assertValidEnvOrExit(): void {
  const { valid, errors, warnings } = validateEnv();

  for (const w of warnings) {
    logger.warn(`ENV: ${w}`);
  }

  if (!valid) {
    logger.error('Environment validation failed:');
    for (const e of errors) {
      logger.error(`  - ${e}`);
    }
    process.exit(1);
  }

  logger.info('Environment validation passed.');
}