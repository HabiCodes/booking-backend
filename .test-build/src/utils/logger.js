"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const config_1 = require("../config");
/**
 * Production-grade structured logger.
 *
 * Outputs JSON in production (so log aggregators like Datadog/Loki/CloudWatch
 * can parse fields) and colorised human-readable text in development.
 *
 * Use the child logger pattern for request-scoped metadata:
 *   logger.child({ requestId: '...', route: '/api/...' })
 */
const jsonFormat = winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json());
const devFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.splat(), winston_1.default.format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
}));
const isProduction = config_1.config.nodeEnv === 'production';
exports.logger = winston_1.default.createLogger({
    level: isProduction ? 'info' : 'debug',
    format: isProduction ? jsonFormat : devFormat,
    defaultMeta: { service: 'booking-backend', env: config_1.config.nodeEnv },
    transports: [
        new winston_1.default.transports.Console({
            format: isProduction ? jsonFormat : winston_1.default.format.combine(winston_1.default.format.colorize(), devFormat),
        }),
    ],
});
// File transports only when configured (won't fail on read-only filesystems)
if (config_1.config.logging?.fileEnabled !== false && !isProduction) {
    exports.logger.add(new winston_1.default.transports.File({ filename: 'logs/error.log', level: 'error' }));
    exports.logger.add(new winston_1.default.transports.File({ filename: 'logs/combined.log' }));
}
exports.default = exports.logger;
