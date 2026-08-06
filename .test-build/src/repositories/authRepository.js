"use strict";
/**
 * Auth-related repository — login attempts, refresh tokens,
 * email verification, device sessions.
 *
 * Pattern: one repository per aggregate, same as userRepository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRepository = exports.AuthRepository = void 0;
const pool_1 = require("../db/pool");
function rowToNumber(row) {
    return row?.id ?? 0;
}
class AuthRepository {
    // ── Login Attempts ──────────────────────────────────────────────────────
    async recordLoginAttempt(email, ipAddress, userAgent, success) {
        await (0, pool_1.getPool)().query(`INSERT INTO login_attempts (email, ip_address, user_agent, success)
       VALUES ($1, $2, $3, $4)`, [email.toLowerCase().trim(), ipAddress, userAgent ?? null, success]);
    }
    async countRecentFailedAttempts(identifier, minutes = 15) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as count FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - INTERVAL '1 minute' * $2`, [identifier, minutes]);
        const row = rows;
        const val = row[0]?.count ?? 0;
        return typeof val === 'string' ? parseInt(val, 10) : Number(val);
    }
    async countFailedAttemptsSince(identifier, sinceMinutes) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as count FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - (INTERVAL '1 minute' * $2)`, [identifier, sinceMinutes]);
        const row = rows;
        const val = row[0]?.count ?? 0;
        return typeof val === 'string' ? parseInt(val, 10) : Number(val);
    }
    async getRecentFailureWindow(identifier) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT MIN(attempted_at) as earliest FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - (INTERVAL '1 minute' * 60)
       LIMIT 1`, [identifier]);
        const row = rows;
        return row[0]?.earliest ? new Date(row[0].earliest) : null;
    }
    async getRecentSuccessfulLogin(email) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT attempted_at FROM login_attempts
       WHERE email = $1 AND success = true
       ORDER BY attempted_at DESC LIMIT 1`, [email]);
        const row = rows;
        return row[0]?.attempted_at ? new Date(row[0].attempted_at) : null;
    }
    // ── Refresh Tokens ──────────────────────────────────────────────────────
    async createRefreshToken(userId, tokenHash, deviceInfo, ipAddress, expiresAt) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [userId, tokenHash, deviceInfo, ipAddress, expiresAt]);
        return rowToNumber(rows[0]);
    }
    async findRefreshTokenByHash(tokenHash) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1', [tokenHash]);
        return rows[0] || null;
    }
    async revokeRefreshToken(tokenHash) {
        const result = await (0, pool_1.getPool)().query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
        return (result.rowCount ?? 0) > 0;
    }
    async revokeAllUserRefreshTokens(userId) {
        const result = await (0, pool_1.getPool)().query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false', [userId]);
        return result.rowCount ?? 0;
    }
    async revokeExpiredTokens() {
        const result = await (0, pool_1.getPool)().query('UPDATE refresh_tokens SET revoked = true WHERE expires_at < NOW() AND revoked = false');
        return result.rowCount ?? 0;
    }
    // ── Email Verification Tokens ───────────────────────────────────────────
    async createVerificationToken(userId, tokenHash, expiresAt, type = 'email_verification') {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO verification_tokens (user_id, token_hash, type, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`, [userId, tokenHash, type, expiresAt]);
        return rowToNumber(rows[0]);
    }
    async findVerificationToken(tokenHash) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM verification_tokens WHERE token_hash = $1 AND used_at IS NULL LIMIT 1', [tokenHash]);
        return rows[0] || null;
    }
    async markVerificationTokenUsed(tokenHash) {
        const result = await (0, pool_1.getPool)().query('UPDATE verification_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL', [tokenHash]);
        return (result.rowCount ?? 0) > 0;
    }
    async invalidateUserVerificationTokens(userId) {
        await (0, pool_1.getPool)().query('UPDATE verification_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    }
    async markUserVerified(userId) {
        await (0, pool_1.getPool)().query('UPDATE users SET is_verified = true, email_verified_at = NOW() WHERE id = $1', [userId]);
    }
    // ── User Sessions ───────────────────────────────────────────────────────
    async createSession(userId, deviceInfo, ipAddress, userAgent, isCurrent = false) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO user_sessions (user_id, device_info, ip_address, user_agent, is_current)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [userId, deviceInfo, ipAddress, userAgent, isCurrent]);
        return rowToNumber(rows[0]);
    }
    async revokeSession(sessionId) {
        await (0, pool_1.getPool)().query('UPDATE user_sessions SET revoked = true WHERE id = $1', [sessionId]);
    }
    async revokeAllUserSessions(userId, exceptSessionId) {
        let result;
        if (exceptSessionId) {
            result = await (0, pool_1.getPool)().query('UPDATE user_sessions SET revoked = true WHERE user_id = $1 AND id != $2 AND revoked = false', [userId, exceptSessionId]);
        }
        else {
            result = await (0, pool_1.getPool)().query('UPDATE user_sessions SET revoked = true WHERE user_id = $1 AND revoked = false', [userId]);
        }
        return result.rowCount ?? 0;
    }
    async getUserSessions(userId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        return rows;
    }
    // ── Pending Registrations (OTP) ───────────────────────────────────────────
    async createPendingRegistration(input) {
        // Use a transaction to atomically invalidate any existing unconsumed
        // row for this email and insert the new one.  The unique partial
        // index (email WHERE consumed_at IS NULL) guarantees only one active
        // row per email; the explicit invalidate makes the intent clear and
        // avoids "could not obtain exclusive lock" races under concurrency.
        return (0, pool_1.withTransaction)(async (client) => {
            await client.query(`UPDATE pending_registrations SET consumed_at = NOW()
         WHERE email = $1 AND consumed_at IS NULL`, [input.email.toLowerCase().trim()]);
            const { rows } = await client.query(`INSERT INTO pending_registrations (email, username, password_hash, otp_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
                input.email.toLowerCase().trim(),
                input.username?.trim() ?? null,
                input.passwordHash,
                input.otpHash,
                input.expiresAt,
            ]);
            return rowToNumber(rows[0]);
        });
    }
    async findPendingRegistrationByEmail(email) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM pending_registrations WHERE email = $1 AND consumed_at IS NULL LIMIT 1', [email.toLowerCase().trim()]);
        return rows[0] || null;
    }
    async findPendingRegistrationByOtpHash(otpHash) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM pending_registrations WHERE otp_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() LIMIT 1', [otpHash]);
        return rows[0] || null;
    }
    async incrementPendingAttempts(id) {
        await (0, pool_1.getPool)().query('UPDATE pending_registrations SET otp_attempts = otp_attempts + 1 WHERE id = $1', [id]);
    }
    async markPendingConsumed(id) {
        await (0, pool_1.getPool)().query('UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1', [id]);
    }
    async deletePendingRegistration(id) {
        await (0, pool_1.getPool)().query('DELETE FROM pending_registrations WHERE id = $1', [id]);
    }
    async invalidateAllPendingForEmail(email) {
        const result = await (0, pool_1.getPool)().query('UPDATE pending_registrations SET consumed_at = NOW() WHERE email = $1 AND consumed_at IS NULL', [email.toLowerCase().trim()]);
        return result.rowCount ?? 0;
    }
    async cleanupExpiredPendingRegistrations() {
        const result = await (0, pool_1.getPool)().query('DELETE FROM pending_registrations WHERE expires_at < NOW() OR consumed_at IS NOT NULL');
        return result.rowCount ?? 0;
    }
}
exports.AuthRepository = AuthRepository;
exports.authRepository = new AuthRepository();
