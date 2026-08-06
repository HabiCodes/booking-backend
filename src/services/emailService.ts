/**
 * Email delivery abstraction.
 *
 * Production implementation calls the Hostinger Mail REST API directly (Node 22
 * has native `fetch`, no SDK needed).  A console-based implementation is kept
 * as the default fallback for development / test environments where no
 * HOSTINGER_API_TOKEN is configured.
 *
 * Each call to `send()` is wrapped in timeout + retry-with-backoff so a
 * flaky mail gateway cannot stall registration or password-reset flows.
 *
 * Selecting the implementation:
 *
 *   const svc = createDefaultEmailService();
 *   // → HostingerEmailService if HOSTINGER_API_TOKEN is set
 *   // → ConsoleEmailService otherwise
 */

import { logger } from '../utils/logger';

// ── Public types ──────────────────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<void>;
}

// ── HTML templates (BookMyTurf branding) ──────────────────────────────────────

/**
 * Escape characters that have meaning in HTML. Centralised so every template
 * rendered by this module is XSS-safe regardless of the source string.
 */
export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const BRAND = {
  name: 'BookMyTurf',
  tagline: 'Book your game. Own your turf.',
  primaryColor: '#7c3aed',
  primaryDark: '#5b21b6',
  accentColor: '#f59e0b',
  textColor: '#1a1a2e',
  mutedColor: '#6b7280',
  bgColor: '#f9fafb',
  surfaceColor: '#ffffff',
  logoUrl: 'https://bigmembres.in/logo.png',
  supportEmail: 'info@bigmembres.in',
} as const;

/**
 * Wrap an email body in the canonical BookMyTurf layout. Every customer-facing
 * email shares this wrapper so a brand refresh only needs to change it here.
 */
export function renderBrandedLayout(opts: {
  preheader: string;
  bodyHtml: string;
  ctaHtml?: string;
  footerNote?: string;
}): string {
  const year = new Date().getFullYear();
  return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(BRAND.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bgColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND.textColor};">
  <span style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtml(opts.preheader)}</span>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.bgColor};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:${BRAND.surfaceColor};border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(17,24,39,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND.primaryColor} 0%,${BRAND.primaryDark} 100%);padding:28px 36px;text-align:left;">
              <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
                ${escapeHtml(BRAND.name)}
              </div>
              <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px;">
                ${escapeHtml(BRAND.tagline)}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 36px 24px 36px;font-size:16px;line-height:1.55;">
              ${opts.bodyHtml}
              ${opts.ctaHtml ?? ''}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 28px 36px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:${BRAND.mutedColor};">
              ${opts.footerNote ?? ''}
              <div style="margin-top:18px;">
                Need help? Reach us at
                <a href="mailto:${escapeHtml(BRAND.supportEmail)}" style="color:${BRAND.primaryColor};text-decoration:none;">${escapeHtml(BRAND.supportEmail)}</a>.
              </div>
              <div style="margin-top:18px;color:#9ca3af;font-size:12px;">
                &copy; ${year} ${escapeHtml(BRAND.name)}. All rights reserved.
              </div>
            </td>
          </tr>
        </table>
        <div style="font-size:12px;color:#9ca3af;margin-top:16px;">
          You are receiving this email because you have an account on ${escapeHtml(BRAND.name)}.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderCtaButton(label: string, href: string): string {
  return `
<p style="text-align:center;margin:28px 0 8px 0;">
  <a href="${escapeHtml(href)}"
     target="_blank"
     rel="noopener noreferrer"
     style="display:inline-block;background:${BRAND.primaryColor};color:#ffffff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;letter-spacing:0.2px;">
    ${escapeHtml(label)}
  </a>
</p>
<p style="text-align:center;margin:8px 0 0 0;font-size:13px;color:${BRAND.mutedColor};">
  Or copy this link into your browser:
  <br/>
  <span style="word-break:break-all;color:${BRAND.primaryColor};">${escapeHtml(href)}</span>
</p>`;
}

// ── Specific email builders ───────────────────────────────────────────────────

export interface BuildVerificationEmailInput {
  verificationLink: string;
  recipientEmail: string;
  username: string | null;
  expiresInHours?: number;
}

export function buildVerificationEmail(input: BuildVerificationEmailInput): EmailMessage {
  const displayName = input.username || input.recipientEmail;
  const recipientFirstName = displayName.split(/[\s._-]/)[0] || displayName;
  const ttl = input.expiresInHours ?? 24;
  const preheader = `Confirm your ${BRAND.name} email address — link expires in ${ttl} hours.`;

  const bodyHtml = `
    <h2 style="margin:0 0 12px 0;font-size:22px;color:${BRAND.textColor};">
      Welcome, ${escapeHtml(recipientFirstName)}!
    </h2>
    <p style="margin:0 0 14px 0;">
      Thanks for signing up to ${escapeHtml(BRAND.name)}. To start booking turfs and managing your games, please confirm this email address.
    </p>
    <p style="margin:0;">
      This link will expire in <strong>${ttl} hours</strong> for security reasons.
    </p>`;

  const html = renderBrandedLayout({
    preheader,
    bodyHtml,
    ctaHtml: renderCtaButton('Verify my email', input.verificationLink),
    footerNote:
      'If the button above does not work, please copy and paste the URL into your browser. ' +
      'If you did not create this account, you can safely ignore this email.',
  });

  return {
    to: input.recipientEmail,
    subject: `Verify your ${BRAND.name} email`,
    text:
      `Hi ${displayName},\n\n` +
      `Thanks for signing up to ${BRAND.name}. ` +
      `Please confirm your email address by visiting:\n\n${input.verificationLink}\n\n` +
      `This link expires in ${ttl} hours.\n\n` +
      `If you did not create this account, please ignore this email.\n\n` +
      `— The ${BRAND.name} team`,
    html,
  };
}

export interface BuildPasswordResetEmailInput {
  resetLink: string;
  recipientEmail: string;
  username: string | null;
  expiresInMinutes?: number;
}

export function buildPasswordResetEmail(input: BuildPasswordResetEmailInput): EmailMessage {
  const displayName = input.username || input.recipientEmail;
  const recipientFirstName = displayName.split(/[\s._-]/)[0] || displayName;
  const ttl = input.expiresInMinutes ?? 60;
  const preheader = `Reset your ${BRAND.name} password — link expires in ${ttl} minutes.`;

  const bodyHtml = `
    <h2 style="margin:0 0 12px 0;font-size:22px;color:${BRAND.textColor};">
      Reset your password
    </h2>
    <p style="margin:0 0 14px 0;">
      Hi ${escapeHtml(recipientFirstName)}, we received a request to reset the password for your ${escapeHtml(BRAND.name)} account (${escapeHtml(input.recipientEmail)}).
    </p>
    <p style="margin:0;">
      Click the button below to choose a new password. This link will expire in <strong>${ttl} minutes</strong>.
    </p>
    <p style="margin:18px 0 0 0;color:${BRAND.mutedColor};font-size:14px;">
      If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.
    </p>`;

  const html = renderBrandedLayout({
    preheader,
    bodyHtml,
    ctaHtml: renderCtaButton('Reset my password', input.resetLink),
  });

  return {
    to: input.recipientEmail,
    subject: `Reset your ${BRAND.name} password`,
    text:
      `Hi ${displayName},\n\n` +
      `Reset your ${BRAND.name} password by visiting:\n\n${input.resetLink}\n\n` +
      `This link expires in ${ttl} minutes.\n\n` +
      `If you did not request this, you can ignore this email.\n\n` +
      `— The ${BRAND.name} team`,
    html,
  };
}

// ── Console implementation (default fallback) ─────────────────────────────────

export class ConsoleEmailService implements EmailService {
  async send(message: EmailMessage): Promise<void> {
    logger.info('=====================================================');
    logger.info(`[EMAIL:console] To: ${message.to}`);
    logger.info(`[EMAIL:console] Subject: ${message.subject}`);
    if (message.text) {
      logger.info(`[EMAIL:console] Body (text):\n${message.text}`);
    } else if (message.html) {
      const stripped = message.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      logger.info(`[EMAIL:console] Body (text-stripped): ${stripped.slice(0, 400)}…`);
    }
    logger.info('=====================================================');
  }
}

// ── Hostinger implementation ──────────────────────────────────────────────────

export interface HostingerEmailServiceConfig {
  apiToken: string;
  from: string;
  mailboxId: string;
  /** Per-request timeout in ms */
  timeoutMs?: number;
  /** Number of retries on transient failures (default 2) */
  retries?: number;
}

/**
 * Send emails via the Hostinger Mail REST API.
 *
 * The Hostinger endpoint expects the token in a plain `Authorization` header
 * (not `Bearer`-prefixed) and accepts recipients as a JSON array rather than
 * the nested structure Resend used.  Timeout / 5xx failures are retried with
 * exponential backoff; 4xx (other than 429) fail immediately.
 */
export class HostingerEmailService implements EmailService {
  private readonly apiToken: string;
  private readonly from: string;
  private readonly mailboxId: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(cfg: HostingerEmailServiceConfig) {
    if (!cfg.apiToken || cfg.apiToken.trim().length === 0) {
      throw new Error('HostingerEmailService: apiToken is required');
    }
    if (!cfg.from || cfg.from.trim().length === 0) {
      throw new Error('HostingerEmailService: from address is required');
    }
    if (!cfg.mailboxId || cfg.mailboxId.trim().length === 0) {
      throw new Error('HostingerEmailService: mailboxId is required');
    }
    this.apiToken = cfg.apiToken;
    this.from = cfg.from;
    this.mailboxId = cfg.mailboxId;
    this.apiBaseUrl = `https://api.mail.hostinger.com/api/v1/mailboxes/${this.mailboxId}`;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.retries = cfg.retries ?? 2;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!message.to) throw new Error('EmailMessage.to is required');

    const payload: Record<string, unknown> = {
      from: this.from,
      to: [message.to],
      subject: message.subject,
    };
    // Hostinger accepts html/text alongside subject in the same payload.
    if (message.html) payload.html = message.html;
    if (message.text) payload.text = message.text;
    if (!message.html && !message.text) {
      throw new Error('EmailMessage must contain at least one of html or text');
    }

    await this.sendWithRetries(payload, message);
  }

  private async sendWithRetries(payload: Record<string, unknown>, message: EmailMessage): Promise<void> {
    const maxAttempts = Math.max(1, this.retries + 1);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.sendOnce(payload);
        return;
      } catch (err) {
        lastError = err;
        const classified = classifyError(err);
        logger.warn(
          `[email:hostinger] send attempt ${attempt}/${maxAttempts} failed (${classified.code}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
        if (classified.permanent) {
          // 4xx other than 429 — no point retrying
          break;
        }
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
        }
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    logger.error(`[email:hostinger] giving up on email to ${message.to}: ${detail}`);
    throw new Error(`Failed to send email to ${message.to}: ${detail}`);
  }

  private async sendOnce(payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.apiBaseUrl}/send`, {
        method: 'POST',
        headers: {
          Authorization: this.apiToken,
          'Content-Type': 'application/json',
          'User-Agent': `${BRAND.name}-backend/1.0`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        // Optionally surface the provider message ID for log correlation
        try {
          const body = (await response.json()) as { id?: string };
          if (body?.id) logger.debug(`[email:hostinger] accepted message id=${body.id}`);
        } catch {
          // body parsing is best-effort
        }
        return;
      }

      // Build an error object that classifyError can read
      const text = await safeReadText(response);
      const err = new Error(`Hostinger API ${response.status}: ${text || response.statusText}`);
      (err as Error & { status?: number; code?: string }).status = response.status;
      (err as Error & { status?: number; code?: string }).code = `hostinger_${response.status}`;
      throw err;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        const timeoutErr = new Error(`Hostinger request timed out after ${this.timeoutMs}ms`);
        (timeoutErr as Error & { code?: string }).code = 'hostinger_timeout';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyError(err: unknown): { permanent: boolean; code: string } {
  const e = err as Error & { status?: number; code?: string };
  const status = e?.status;
  const code = e?.code ?? 'unknown';

  // Timeout or network failure → retryable
  if (!status) return { permanent: false, code };

  if (status === 429) return { permanent: false, code }; // rate-limited → retry
  if (status >= 500) return { permanent: false, code }; // server-side → retry
  if (status >= 400) return { permanent: true, code }; // 4xx other than 429 → permanent
  return { permanent: false, code };
}

function backoffMs(attempt: number): number {
  // Exponential with jitter: 250ms, 750ms, 1750ms … capped at 8s.
  const base = Math.min(250 * Math.pow(2, attempt - 1), 8_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

// ── Factory: pick the right service based on env ──────────────────────────────

export interface CreateEmailServiceOptions {
  apiToken?: string | undefined;
  from?: string | undefined;
  mailboxId?: string | undefined;
}

export function createEmailService(opts: CreateEmailServiceOptions = {}): EmailService {
  const apiToken = (opts.apiToken ?? process.env.HOSTINGER_API_TOKEN ?? '').trim();
  const from = (opts.from ?? process.env.EMAIL_FROM ?? BRAND.supportEmail).trim();
  const mailboxId = (opts.mailboxId ?? process.env.HOSTINGER_MAILBOX_ID ?? '').trim();

  if (!apiToken) {
    logger.warn(
      '[email] HOSTINGER_API_TOKEN not set — falling back to ConsoleEmailService. ' +
        'Set HOSTINGER_API_TOKEN in production to actually send mail.',
    );
    return new ConsoleEmailService();
  }

  logger.info(`[email] Using Hostinger sender "${from}".`);
  return new HostingerEmailService({ apiToken, from, mailboxId });
}
