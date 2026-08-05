/**
 * Admin Seeder — PostgreSQL-compatible
 *
 * Run with:  npm run seed:admin -- --email=admin@example.com --password=YourPassword
 *
 * Creates or updates an admin record with a bcrypt-hashed password (12 rounds).
 * Idempotent: re-running updates the password for an existing admin.
 *
 * Excluded from `tsc -p tsconfig.json` build (see tsconfig.json exclude).
 */
import { getPool, closePool } from '../db/pool';
import { logger } from '../utils/logger';
import { hashPassword } from '../utils/crypto';

interface CliArgs {
  email: string;
  password: string;
  name: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--email=')) args.email = arg.slice('--email='.length);
    else if (arg.startsWith('--password=')) args.password = arg.slice('--password='.length);
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
  }

  if (!args.email || !args.password) {
    throw new Error(
      'Usage: npm run seed:admin -- --email=<email> --password=<password> [--name=<display name>]'
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) {
    throw new Error(`Invalid email: ${args.email}`);
  }
  if (args.password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  return {
    email: args.email.toLowerCase().trim(),
    password: args.password,
    name: (args.name ?? 'Admin').trim(),
  };
}

async function seedAdmin(args: CliArgs): Promise<void> {
  const pool = getPool();
  const passwordHash = await hashPassword(args.password);

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM admins WHERE email = $1 LIMIT 1',
    [args.email]
  );
  const found = (existingRows as Array<{ id: number }>)[0];

  if (found) {
    await pool.query(
      'UPDATE admins SET password_hash = $1, name = $2 WHERE id = $3',
      [passwordHash, args.name, found.id]
    );
    logger.info(`Admin updated: ${args.email} (id=${found.id})`);
  } else {
    await pool.query(
      'INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3)',
      [args.email, passwordHash, args.name]
    );
    logger.info(`Admin created: ${args.email}`);
  }
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv);
    await seedAdmin(args);
    logger.info('Admin seed complete.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Admin seed failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
