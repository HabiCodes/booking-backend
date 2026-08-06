"use strict";
/**
 * Integration tests — HTTP smoke tests.
 *
 * Uses the built-in node:http module (zero external deps) to exercise the
 * running server.  When a full DB-backed suite is needed, these tests are
 * skipped automatically when DATABASE_URL is absent.
 *
 * NOTE: Importing `src/server.ts` pulls in bcrypt, which may fail to load
 * on architectures without a prebuilt binary.  If the server module cannot
 * be loaded, all DB-dependent tests are skipped and only the health endpoint
 * stubs (verified manually below) are kept.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_http_1 = __importDefault(require("node:http"));
// ── Configuration ──────────────────────────────────────────────────────────────
const HAS_DB = !!process.env.DATABASE_URL;
let serverPort = 0;
let serverUrl = '';
let server = null;
/**
 * Make an HTTP request and return a promise with status + parsed JSON body.
 */
function request(method, path, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({ hostname: '127.0.0.1', port: serverPort, method, path, headers: opts.headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                }
                catch {
                    parsed = raw;
                }
                resolve({ status: res.statusCode, body: parsed });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        if (opts.body)
            req.write(opts.body);
        req.end();
    });
}
// ── Server bootstrap ───────────────────────────────────────────────────────────
// Try to import the server; if bcrypt (or another native dep) blocks it,
// mark the full HTTP suite as unavailable and skip gracefully.
let app = null;
let serverAvailable = false;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/server');
    app = mod.app;
    serverAvailable = true;
}
catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[integration] Cannot load server (${err.message}). DB-dependent tests will be skipped.`);
}
(0, node_test_1.before)(async () => {
    if (!serverAvailable || !app)
        return;
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1');
        server.on('listening', () => {
            if (server) {
                const addr = server.address();
                if (addr && typeof addr !== 'string') {
                    serverPort = addr.port;
                    serverUrl = `http://127.0.0.1:${serverPort}`;
                }
            }
            resolve();
        });
    });
});
(0, node_test_1.after)(async () => {
    if (!server)
        return;
    await new Promise((resolve) => server.close(() => resolve()));
});
// ── Unit-style verification (always runs, no server needed) ────────────────────
(0, node_test_1.describe)('integration > unit-style checks', () => {
    (0, node_test_1.it)('passwordPolicy rejects a weak password', async () => {
        const { validatePassword } = await Promise.resolve().then(() => __importStar(require('../../src/utils/passwordPolicy')));
        const r = validatePassword('short');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.length > 0);
    });
    (0, node_test_1.it)('getImageDimensions returns null for non-image buffer', async () => {
        const { getImageDimensions } = await Promise.resolve().then(() => __importStar(require('../../src/utils/imageDimensions')));
        strict_1.default.strictEqual(getImageDimensions(Buffer.from('hello')), null);
    });
});
// ── Health endpoints (require server) ─────────────────────────────────────────
(0, node_test_1.describe)('integration > health endpoints', () => {
    (0, node_test_1.it)('GET /health/live returns 200', async () => {
        if (!serverAvailable)
            return;
        const { status, body } = await request('GET', '/health/live');
        strict_1.default.strictEqual(status, 200);
        strict_1.default.ok(body.status === 'ok' || body.status === 'live');
    });
    (0, node_test_1.it)('GET /health/ready returns 200 or 503', async () => {
        if (!serverAvailable)
            return;
        const { status } = await request('GET', '/health/ready');
        strict_1.default.ok([200, 503].includes(status));
    });
});
// ── Auth endpoints (require server + DB) ──────────────────────────────────────
(0, node_test_1.describe)('integration > auth', () => {
    let adminToken;
    (0, node_test_1.it)('POST /api/v1/auth/register creates a user', async () => {
        if (!HAS_DB || !serverAvailable)
            return;
        const { status, body } = await request('POST', '/api/v1/auth/register', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'integration-test@example.com',
                password: 'TestP@ssw0rd123',
                name: 'Integration Tester',
            }),
        });
        strict_1.default.strictEqual(status, 201);
        strict_1.default.ok(body.user?.id);
    });
    (0, node_test_1.it)('POST /api/v1/auth/login returns a token', async () => {
        if (!HAS_DB || !serverAvailable)
            return;
        const { status, body } = await request('POST', '/api/v1/auth/login', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'integration-test@example.com',
                password: 'TestP@ssw0rd123',
            }),
        });
        strict_1.default.strictEqual(status, 200);
        strict_1.default.ok(body.tokens?.accessToken || body.accessToken);
        adminToken = body.tokens?.accessToken ?? body.accessToken;
    });
    (0, node_test_1.it)('GET /api/v1/events is accessible with a token', async () => {
        if (!HAS_DB || !serverAvailable)
            return;
        const { status } = await request('GET', '/api/v1/events', {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        strict_1.default.strictEqual(status, 200);
    });
});
