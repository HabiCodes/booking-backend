"use strict";
/**
 * Shared test helpers — database pool, server boot, and factory utilities.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetTestDatabase = resetTestDatabase;
exports.cleanupTestDatabase = cleanupTestDatabase;
exports.buildAdminToken = buildAdminToken;
exports.defaultPermissions = defaultPermissions;
exports.buildUserToken = buildUserToken;
const pool_1 = require("../../src/db/pool");
// ── Test database ──────────────────────────────────────────────────────────────
/**
 * Reset the test database to a clean state.
 * Runs all migration files and then seeds minimal data.
 * Call this in a beforeAll() block.
 */
async function resetTestDatabase() {
    const pool = (0, pool_1.getPool)();
    // Drop all tables (CASCADE) and re-run migrations
    await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
    await Promise.resolve().then(() => __importStar(require('../../src/db/migrations'))).then((m) => m.runMigrations());
}
/**
 * Close the DB pool after all tests.
 * Call this in an afterAll() block.
 */
async function cleanupTestDatabase() {
    await (0, pool_1.closePool)();
}
// ── Admin JWT helper ───────────────────────────────────────────────────────────
const jwt_1 = require("../../src/utils/jwt");
function buildAdminToken(overrides) {
    return (0, jwt_1.generateAdminAccessToken)(overrides?.adminId ?? 1, overrides?.email ?? 'admin@test.com', overrides?.role ?? 'admin', overrides?.permissions ?? defaultPermissions());
}
function defaultPermissions() {
    return {
        'users:read': true,
        'users:write': true,
        'users:delete': true,
        'events:read': true,
        'events:write': true,
        'events:delete': true,
        'events:publish': true,
        'events:feature': true,
        'bookings:read': true,
        'bookings:cancel': true,
        'bookings:delete': true,
        'banners:read': true,
        'banners:write': true,
        'banners:delete': true,
        'banners:activate': true,
        'uploads:read': true,
        'uploads:write': true,
        'uploads:delete': true,
        'scanner:verify': true,
        'scanner:checkin': true,
        'admins:read': true,
        'admins:write': true,
        'admins:delete': true,
        'audit:read': true,
        'analytics:read': true,
    };
}
// ── User JWT helper ────────────────────────────────────────────────────────────
const jwt_2 = require("../../src/utils/jwt");
function buildUserToken(userId, email) {
    return (0, jwt_2.generateAccessToken)(userId, email);
}
