"use strict";
/**
 * URL-safe token generation.
 * Uses crypto.randomBytes for cryptographic strength.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSecureToken = generateSecureToken;
exports.hashToken = hashToken;
const crypto_1 = require("crypto");
function generateSecureToken(byteLength = 32) {
    return (0, crypto_1.randomBytes)(byteLength).toString('base64url');
}
function hashToken(token) {
    return (0, crypto_1.createHash)('sha256').update(token).digest('hex');
}
