"use strict";
/**
 * Unit tests for the email service layer (HTML builders + Resend client).
 *
 * These tests mock `fetch` so they never touch the real Resend API.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const emailService_1 = require("../../src/services/emailService");
// ── escapeHtml ────────────────────────────────────────────────────────────────
(0, node_test_1.describe)('email > escapeHtml', () => {
    (0, node_test_1.it)('passes through plain text', () => {
        strict_1.default.strictEqual((0, emailService_1.escapeHtml)('hello'), 'hello');
    });
    (0, node_test_1.it)('escapes the five special chars', () => {
        strict_1.default.strictEqual((0, emailService_1.escapeHtml)(`<>&"'`), '&lt;&gt;&amp;&quot;&#039;');
    });
});
// ── renderBrandedLayout ───────────────────────────────────────────────────────
(0, node_test_1.describe)('email > renderBrandedLayout', () => {
    (0, node_test_1.it)('includes the brand name in the header', () => {
        const html = (0, emailService_1.renderBrandedLayout)({
            preheader: 'test preheader',
            bodyHtml: '<p>hi</p>',
        });
        strict_1.default.ok(html.includes(emailService_1.BRAND.name));
    });
    (0, node_test_1.it)('includes the bodyHtml', () => {
        const html = (0, emailService_1.renderBrandedLayout)({
            preheader: 'x',
            bodyHtml: '<p>test body</p>',
        });
        strict_1.default.ok(html.includes('<p>test body</p>'));
    });
    (0, node_test_1.it)('includes ctaHtml when provided', () => {
        const html = (0, emailService_1.renderBrandedLayout)({
            preheader: 'x',
            bodyHtml: '<p>hi</p>',
            ctaHtml: '<button>Click me</button>',
        });
        strict_1.default.ok(html.includes('<button>Click me</button>'));
    });
    (0, node_test_1.it)('includes footer note when provided', () => {
        const html = (0, emailService_1.renderBrandedLayout)({
            preheader: 'x',
            bodyHtml: '<p>hi</p>',
            footerNote: '<span>extra footer</span>',
        });
        strict_1.default.ok(html.includes('<span>extra footer</span>'));
    });
});
// ── buildVerificationEmail ────────────────────────────────────────────────────
(0, node_test_1.describe)('email > buildVerificationEmail', () => {
    (0, node_test_1.it)('returns the correct to / subject fields', () => {
        const msg = (0, emailService_1.buildVerificationEmail)({
            verificationLink: 'https://example.com/verify?token=abc',
            recipientEmail: 'user@example.com',
            username: 'John',
        });
        strict_1.default.strictEqual(msg.to, 'user@example.com');
        strict_1.default.ok(msg.subject.includes('Verify'));
    });
    (0, node_test_1.it)('falls back display name to email when username is null', () => {
        const msg = (0, emailService_1.buildVerificationEmail)({
            verificationLink: 'https://example.com/verify?token=abc',
            recipientEmail: 'user@example.com',
            username: null,
        });
        strict_1.default.ok(msg.text?.includes('user@example.com'));
    });
    (0, node_test_1.it)('includes the verification link in both text and html', () => {
        const link = 'https://example.com/verify?token=xyz';
        const msg = (0, emailService_1.buildVerificationEmail)({
            verificationLink: link,
            recipientEmail: 'u@e.com',
            username: null,
        });
        strict_1.default.ok(msg.text?.includes(link));
        strict_1.default.ok(msg.html?.includes(link));
    });
    (0, node_test_1.it)('includes the expiry info', () => {
        const msg = (0, emailService_1.buildVerificationEmail)({
            verificationLink: 'https://example.com/verify?token=abc',
            recipientEmail: 'u@e.com',
            username: null,
            expiresInHours: 2,
        });
        strict_1.default.ok(msg.text?.includes('2 hours'));
        strict_1.default.ok(msg.html?.includes('2 hours'));
    });
});
// ── buildPasswordResetEmail ───────────────────────────────────────────────────
(0, node_test_1.describe)('email > buildPasswordResetEmail', () => {
    (0, node_test_1.it)('returns a message with the reset subject', () => {
        const msg = (0, emailService_1.buildPasswordResetEmail)({
            resetLink: 'https://example.com/reset?token=abc',
            recipientEmail: 'user@example.com',
            username: 'Alice',
        });
        strict_1.default.ok(msg.subject.includes('password') || msg.subject.includes('Reset'));
        strict_1.default.ok(msg.html?.includes('reset'));
    });
});
// ── ConsoleEmailService ───────────────────────────────────────────────────────
(0, node_test_1.describe)('email > ConsoleEmailService', () => {
    (0, node_test_1.it)('resolves successfully for a basic message', async () => {
        const svc = new emailService_1.ConsoleEmailService();
        await strict_1.default.doesNotReject(() => svc.send({ to: 'x@y.com', subject: 'test', text: 'hello' }));
    });
});
// ── ResendEmailService ────────────────────────────────────────────────────────
(0, node_test_1.describe)('email > ResendEmailService', () => {
    let originalFetch;
    let calls;
    (0, node_test_1.beforeEach)(() => {
        originalFetch = globalThis.fetch;
        calls = [];
        globalThis.fetch = async (url, opts) => {
            const body = typeof opts?.body === 'string' ? opts.body : JSON.stringify(opts?.body ?? {});
            const headers = {};
            if (opts?.headers) {
                if (typeof opts.headers === 'string') {
                    // unlikely
                    void opts.headers;
                }
                else if (Array.isArray(opts.headers)) {
                    for (const h of opts.headers) {
                        if (Array.isArray(h) && h.length >= 2)
                            headers[h[0]] = String(h[1]);
                    }
                }
                else if (typeof opts.headers.forEach === 'function') {
                    opts.headers.forEach((v, k) => {
                        headers[k] = v;
                    });
                }
                else {
                    Object.assign(headers, opts.headers);
                }
            }
            calls.push({
                url: String(url),
                opts: {
                    method: String(opts?.method ?? 'POST'),
                    body,
                    headers,
                },
            });
            return new Response(JSON.stringify({ id: 'test-msg-id' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };
    });
    (0, node_test_1.afterEach)(() => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        else {
            delete globalThis.fetch;
        }
    });
    (0, node_test_1.it)('POSTs to the emails endpoint with the correct payload', async () => {
        const svc = new emailService_1.ResendEmailService({
            apiKey: 'test-key',
            from: 'no-reply@bigmembres.in',
        });
        await svc.send({
            to: 'user@example.com',
            subject: 'Hello',
            html: '<p>body</p>',
        });
        strict_1.default.strictEqual(calls.length, 1);
        strict_1.default.ok(calls[0].url.includes('/emails'));
        strict_1.default.strictEqual(calls[0].opts.method, 'POST');
        const body = JSON.parse(calls[0].opts.body || '{}');
        strict_1.default.deepStrictEqual(body.to, ['user@example.com']);
        strict_1.default.strictEqual(body.subject, 'Hello');
        strict_1.default.strictEqual(body.html, '<p>body</p>');
        strict_1.default.strictEqual(body.from, 'no-reply@bigmembres.in');
    });
    (0, node_test_1.it)('includes auth header', async () => {
        const svc = new emailService_1.ResendEmailService({ apiKey: 'sk-test', from: 'from@x.com' });
        await svc.send({ to: 'u@x.com', subject: 's', text: 't' });
        strict_1.default.strictEqual(calls[0].opts.headers.Authorization, 'Bearer sk-test');
    });
    (0, node_test_1.it)('retries on 503 then succeeds', async () => {
        let attempt = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            attempt++;
            if (attempt === 1) {
                return new Response('Service unavailable', { status: 503 });
            }
            return new Response(JSON.stringify({ id: 'ok' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };
        try {
            const svc = new emailService_1.ResendEmailService({ apiKey: 'k', from: 'f@x.com', retries: 2 });
            await svc.send({ to: 'u@x.com', subject: 's', text: 't' });
            strict_1.default.strictEqual(attempt, 2);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    (0, node_test_1.it)('throws after final failure', async () => {
        globalThis.fetch = async () => {
            return new Response('Still 503', { status: 503 });
        };
        const svc = new emailService_1.ResendEmailService({ apiKey: 'k', from: 'f@x.com', retries: 1 });
        await strict_1.default.rejects(() => svc.send({ to: 'u@x.com', subject: 's', text: 't' }), /Failed to send email/);
    });
    (0, node_test_1.it)('throws on construction with empty apiKey', () => {
        strict_1.default.throws(() => {
            new emailService_1.ResendEmailService({ apiKey: '', from: 'f@x.com' });
        }, /apiKey is required/);
    });
    (0, node_test_1.it)('throws on construction with empty from', () => {
        strict_1.default.throws(() => {
            new emailService_1.ResendEmailService({ apiKey: 'k', from: '' });
        }, /from address is required/);
    });
});
// ── createEmailService (factory) ──────────────────────────────────────────────
(0, node_test_1.describe)('email > createEmailService', () => {
    const origApiKey = process.env.RESEND_API_KEY;
    const origFrom = process.env.EMAIL_FROM;
    (0, node_test_1.beforeEach)(() => {
        delete process.env.RESEND_API_KEY;
        delete process.env.EMAIL_FROM;
    });
    (0, node_test_1.afterEach)(() => {
        if (origApiKey !== undefined)
            process.env.RESEND_API_KEY = origApiKey;
        else
            delete process.env.RESEND_API_KEY;
        if (origFrom !== undefined)
            process.env.EMAIL_FROM = origFrom;
        else
            delete process.env.EMAIL_FROM;
    });
    (0, node_test_1.it)('returns a ConsoleEmailService when RESEND_API_KEY is not set', () => {
        const svc = (0, emailService_1.createEmailService)();
        strict_1.default.ok(svc instanceof emailService_1.ConsoleEmailService);
    });
    (0, node_test_1.it)('returns a ResendEmailService when RESEND_API_KEY is set', () => {
        process.env.RESEND_API_KEY = 'sk-live';
        const svc = (0, emailService_1.createEmailService)();
        strict_1.default.ok(svc instanceof emailService_1.ResendEmailService);
    });
});
