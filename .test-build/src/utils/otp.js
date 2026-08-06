"use strict";
/**
 * One-time passcode (OTP) utilities — cryptographically secure generation,
 * SHA-256 hashing, and constant-time verification.
 *
 * Design:
 *  - OTPs are short-lived numeric codes (default 6 digits) sent by email.
 *  - Only the SHA-256 hash is ever stored or compared — the plain OTP is
 *    never written to the database, logs, or any persistent medium.
 *  - Verification uses crypto.timingSafeEqual to prevent timing attacks.
 *
 * All functions are pure and side-effect free.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNumericOtp = generateNumericOtp;
exports.hashOtp = hashOtp;
exports.verifyOtpConstantTime = verifyOtpConstantTime;
exports.verifyOtp = verifyOtp;
const crypto_1 = require("crypto");
/**
 * Generate a numeric OTP of the given length.
 *
 * @param length - Number of digits.  6 gives 900 000 valid codes (000000-999999).
 *                 Higher values increase entropy but hurt UX.  Default 6.
 * @returns String of decimal digits, zero-padded to `length`.
 * @throws RangeError if length is 0 or > 32.
 */
function generateNumericOtp(length = 6) {
    if (length <= 0 || length > 32) {
        throw new RangeError(`generateNumericOtp: length must be in [1, 32] (got ${length})`);
    }
    // crypto.randomInt is a CSPRNG — safe for verification codes.
    const max = 10 ** length;
    const num = (0, crypto_1.randomInt)(0, max);
    return String(num).padStart(length, '0');
}
/**
 * SHA-256 hex digest of an OTP string.
 *
 * @param otp - Plain OTP (6 digits).  Caller must never log this.
 * @returns 64-char lowercase hex string (the hash).
 */
function hashOtp(otp) {
    return (0, crypto_1.createHash)('sha256').update(otp, 'utf8').digest('hex');
}
/**
 * Compare two values in constant time.
 *
 * Used when comparing the user-supplied OTP (hashed) against the stored
 * hash, so an attacker cannot learn anything from timing differences.
 *
 * @param a - First value (typically the stored hash).
 * @param b - Second value (typically the freshly computed hash).
 * @returns true if the values are identical.
 * @throws Error if the values have different lengths.
 */
function verifyOtpConstantTime(a, b) {
    if (a.length !== b.length) {
        // timingSafeEqual requires equal-length buffers — fall through to a
        // fake comparison so the timing profile is indistinguishable.
        const buf = Buffer.alloc(a.length);
        (0, crypto_1.timingSafeEqual)(buf, buf);
        return false;
    }
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return (0, crypto_1.timingSafeEqual)(bufA, bufB);
}
/**
 * Verify a plain OTP against a stored hash.
 *
 * Convenience wrapper: hashes the plain OTP and compares in constant time.
 *
 * @param plainOtp   - OTP supplied by the user (from the HTTP body).
 * @param storedHash - SHA-256 hex hash retrieved from the database.
 * @returns true if the OTP matches, false otherwise.
 */
function verifyOtp(plainOtp, storedHash) {
    return verifyOtpConstantTime(hashOtp(plainOtp), storedHash);
}
