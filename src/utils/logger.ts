import winston from 'winston';
import { config } from '../config';

/**
 * Production-grade structured logger.
 *
 * Outputs JSON in production (so log aggregators like Datadog/Loki/CloudWatch
 * can parse fields) and colorised human-readable text in development.
 *
 * Use the child logger pattern for request-scoped metadata:
 *   logger.child({ requestId: '...', route: '/api/...' })
 */
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
  })
);

const isProduction = config.nodeEnv === 'production';

export const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: isProduction ? jsonFormat : devFormat,
  defaultMeta: { service: 'booking-backend', env: config.nodeEnv },
  transports: [
    new winston.transports.Console({
      format: isProduction ? jsonFormat : winston.format.combine(winston.format.colorize(), devFormat),
    }),
  ],
});

// File transports only when configured (won't fail on read-only filesystems)
if (config.logging?.fileEnabled !== false && !isProduction) {
  logger.add(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  logger.add(new winston.transports.File({ filename: 'logs/combined.log' }));
}

export default logger;