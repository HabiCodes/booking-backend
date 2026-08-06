/**
 * Unit tests for the email service layer (HTML builders + Hostinger client).
 *
 * These tests mock `fetch` so they never touch the real Hostinger Mail API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  escapeHtml,
  renderBrandedLayout,
  BRAND,
  HostingerEmailService,
  createEmailService,
  ConsoleEmailService,
} from '../../src/services/emailService';

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('email > escapeHtml', () => {
  it('passes through plain text', () => {
    assert.strictEqual(escapeHtml('hello'), 'hello');
  });

  it('escapes the five special chars', () => {
    assert.strictEqual(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#039;');
  });
});

// ── renderBrandedLayout ───────────────────────────────────────────────────────

describe('email > renderBrandedLayout', () => {
  it('includes the brand name in the header', () => {
    const html = renderBrandedLayout({
      preheader: 'test preheader',
      bodyHtml: '<p>hi</p>',
    });
    assert.ok(html.includes(BRAND.name));
  });

  it('includes the bodyHtml', () => {
    const html = renderBrandedLayout({
      preheader: 'x',
      bodyHtml: '<p>test body</p>',
    });
    assert.ok(html.includes('<p>test body</p>'));
  });

  it('includes ctaHtml when provided', () => {
    const html = renderBrandedLayout({
      preheader: 'x',
      bodyHtml: '<p>hi</p>',
      ctaHtml: '<button>Click me</button>',
    });
    assert.ok(html.includes('<button>Click me</button>'));
  });

  it('includes footer note when provided', () => {
    const html = renderBrandedLayout({
      preheader: 'x',
      bodyHtml: '<p>hi</p>',
      footerNote: '<span>extra footer</span>',
    });
    assert.ok(html.includes('<span>extra footer</span>'));
  });
});

// ── buildVerificationEmail ────────────────────────────────────────────────────

describe('email > buildVerificationEmail', () => {
  it('returns the correct to / subject fields', () => {
    const msg = buildVerificationEmail({
      verificationLink: 'https://example.com/verify?token=abc',
      recipientEmail: 'user@example.com',
      username: 'John',
    });
    assert.strictEqual(msg.to, 'user@example.com');
    assert.ok(msg.subject.includes('Verify'));
  });

  it('falls back display name to email when username is null', () => {
    const msg = buildVerificationEmail({
      verificationLink: 'https://example.com/verify?token=abc',
      recipientEmail: 'user@example.com',
      username: null,
    });
    assert.ok(msg.text?.includes('user@example.com'));
  });

  it('includes the verification link in both text and html', () => {
    const link = 'https://example.com/verify?token=xyz';
    const msg = buildVerificationEmail({
      verificationLink: link,
      recipientEmail: 'u@e.com',
      username: null,
    });
    assert.ok(msg.text?.includes(link));
    assert.ok(msg.html?.includes(link));
  });

  it('includes the expiry info', () => {
    const msg = buildVerificationEmail({
      verificationLink: 'https://example.com/verify?token=abc',
      recipientEmail: 'u@e.com',
      username: null,
      expiresInHours: 2,
    });
    assert.ok(msg.text?.includes('2 hours'));
    assert.ok(msg.html?.includes('2 hours'));
  });
});

// ── buildPasswordResetEmail ───────────────────────────────────────────────────

describe('email > buildPasswordResetEmail', () => {
  it('returns a message with the reset subject', () => {
    const msg = buildPasswordResetEmail({
      resetLink: 'https://example.com/reset?token=abc',
      recipientEmail: 'user@example.com',
      username: 'Alice',
    });
    assert.ok(msg.subject.includes('password') || msg.subject.includes('Reset'));
    assert.ok(msg.html?.includes('reset'));
  });
});

// ── ConsoleEmailService ───────────────────────────────────────────────────────

describe('email > ConsoleEmailService', () => {
  it('resolves successfully for a basic message', async () => {
    const svc = new ConsoleEmailService();
    await assert.doesNotReject(
      () => svc.send({ to: 'x@y.com', subject: 'test', text: 'hello' }),
    );
  });
});

// ── HostingerEmailService ──────────────────────────────────────────────────────

describe('email > HostingerEmailService', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let calls: Array<{ url: string; opts: { method: string; body?: string; headers: Record<string, string> } }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url: any, opts: any) => {
      const body = typeof opts?.body === 'string' ? opts.body : JSON.stringify(opts?.body ?? {});
      const headers: Record<string, string> = {};
      if (opts?.headers) {
        if (typeof opts.headers === 'string') {
          // unlikely
          void opts.headers;
        } else if (Array.isArray(opts.headers)) {
          for (const h of opts.headers as string[][]) {
            if (Array.isArray(h) && h.length >= 2) headers[h[0]!] = String(h[1]);
          }
        } else if (typeof (opts.headers as Headers).forEach === 'function') {
          (opts.headers as Headers).forEach((v: string, k: string) => {
            headers[k] = v;
          });
        } else {
          Object.assign(headers, opts.headers as Record<string, string>);
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
      }) as any;
    };
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as any).fetch;
    }
  });

  it('POSTs to the messages/send endpoint with the correct payload', async () => {
    const svc = new HostingerEmailService({
      apiToken: 'test-token',
      from: 'no-reply@bigmembres.in',
      mailboxId: 'mb-123',
    });
    await svc.send({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>body</p>',
    });

    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0]!.url.includes('/mailboxes/mb-123'));
    assert.ok(calls[0]!.url.endsWith('/send'));
    assert.strictEqual(calls[0]!.opts.method, 'POST');
    const body = JSON.parse(calls[0]!.opts.body || '{}');
    assert.deepStrictEqual(body.to, ['user@example.com']);
    assert.strictEqual(body.subject, 'Hello');
    assert.strictEqual(body.html, '<p>body</p>');
    assert.strictEqual(body.from, 'no-reply@bigmembres.in');
  });

  it('uses apiToken (no Bearer prefix) in Authorization header', async () => {
    const svc = new HostingerEmailService({ apiToken: 'h-token', from: 'from@x.com', mailboxId: 'mb-1' });
    await svc.send({ to: 'u@x.com', subject: 's', text: 't' });
    assert.strictEqual(calls[0]!.opts.headers.Authorization, 'h-token');
  });

  it('retries on 503 then succeeds', async () => {
    let attempt = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      attempt++;
      if (attempt === 1) {
        return new Response('Service unavailable', { status: 503 }) as any;
      }
      return new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as any;
    };

    try {
      const svc = new HostingerEmailService({ apiToken: 'k', from: 'f@x.com', mailboxId: 'mb-1', retries: 2 });
      await svc.send({ to: 'u@x.com', subject: 's', text: 't' });
      assert.strictEqual(attempt, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws after final failure', async () => {
    globalThis.fetch = async () => {
      return new Response('Still 503', { status: 503 }) as any;
    };

    const svc = new HostingerEmailService({ apiToken: 'k', from: 'f@x.com', mailboxId: 'mb-1', retries: 1 });
    await assert.rejects(
      () => svc.send({ to: 'u@x.com', subject: 's', text: 't' }),
      /Failed to send email/,
    );
  });

  it('throws on construction with empty apiToken', () => {
    assert.throws(() => {
      new HostingerEmailService({ apiToken: '', from: 'f@x.com', mailboxId: 'mb-1' });
    }, /apiToken is required/);
  });

  it('throws on construction with empty from', () => {
    assert.throws(() => {
      new HostingerEmailService({ apiToken: 'k', from: '', mailboxId: 'mb-1' });
    }, /from address is required/);
  });

  it('throws on construction with empty mailboxId', () => {
    assert.throws(() => {
      new HostingerEmailService({ apiToken: 'k', from: 'f@x.com', mailboxId: '' });
    }, /mailboxId is required/);
  });
});

// ── createEmailService (factory) ──────────────────────────────────────────────

describe('email > createEmailService', () => {
  const origApiToken = process.env.HOSTINGER_API_TOKEN;
  const origMailboxId = process.env.HOSTINGER_MAILBOX_ID;
  const origFrom = process.env.EMAIL_FROM;

  beforeEach(() => {
    delete process.env.HOSTINGER_API_TOKEN;
    delete process.env.HOSTINGER_MAILBOX_ID;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    if (origApiToken !== undefined) process.env.HOSTINGER_API_TOKEN = origApiToken;
    else delete process.env.HOSTINGER_API_TOKEN;
    if (origMailboxId !== undefined) process.env.HOSTINGER_MAILBOX_ID = origMailboxId;
    else delete process.env.HOSTINGER_MAILBOX_ID;
    if (origFrom !== undefined) process.env.EMAIL_FROM = origFrom;
    else delete process.env.EMAIL_FROM;
  });

  it('returns a ConsoleEmailService when HOSTINGER_API_TOKEN is not set', () => {
    const svc = createEmailService();
    assert.ok(svc instanceof ConsoleEmailService);
  });

  it('returns a HostingerEmailService when HOSTINGER_API_TOKEN is set', () => {
    process.env.HOSTINGER_API_TOKEN = 'h-token';
    process.env.HOSTINGER_MAILBOX_ID = 'mb-abc';
    const svc = createEmailService();
    assert.ok(svc instanceof HostingerEmailService);
  });
});
