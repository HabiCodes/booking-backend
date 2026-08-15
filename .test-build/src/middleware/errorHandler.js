"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.notFoundHandler = notFoundHandler;
exports.errorHandler = errorHandler;
const config_1 = require("../config");
class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
function notFoundHandler(req, res) {
    res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
}
function errorHandler(err, req, res, _next) {
    const statusCode = err instanceof AppError ? err.statusCode : 500;
    const message = err instanceof AppError ? err.message : 'Internal server error';
    if (statusCode === 500) {
        console.error('Unhandled error:', err);
    }
    res.status(statusCode).json({
        success: false,
        message,
        ...(config_1.config.nodeEnv === 'development' && { stack: err.stack }),
        ...(err instanceof AppError && err.retryInMs != null && { retryInMs: err.retryInMs }),
    });
}
