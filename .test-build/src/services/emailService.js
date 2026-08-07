"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostingerEmailService = exports.ConsoleEmailService = exports.BRAND = void 0;
exports.escapeHtml = escapeHtml;
exports.renderBrandedLayout = renderBrandedLayout;
exports.buildVerificationEmail = buildVerificationEmail;
exports.buildPasswordResetEmail = buildPasswordResetEmail;
exports.buildOtpEmail = buildOtpEmail;
exports.createEmailService = createEmailService;
const logger_1 = require("../utils/logger");
// ── HTML templates (BookMyTurf branding) ──────────────────────────────────────
/**
 * Escape characters that have meaning in HTML. Centralised so every template
 * rendered by this module is XSS-safe regardless of the source string.
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
exports.BRAND = {
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
};
/**
 * Wrap an email body in the canonical BookMyTurf layout. Every customer-facing
 * email shares this wrapper so a brand refresh only needs to change it here.
 */
function renderBrandedLayout(opts) {
    const year = new Date().getFullYear();
    return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(exports.BRAND.name)}</title>
</head>
<body style="margin:0;padding:0;background:${exports.BRAND.bgColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${exports.BRAND.textColor};">
  <span style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtml(opts.preheader)}</span>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${exports.BRAND.bgColor};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:${exports.BRAND.surfaceColor};border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(17,24,39,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,${exports.BRAND.primaryColor} 0%,${exports.BRAND.primaryDark} 100%);padding:28px 36px;text-align:left;">
              <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
                ${escapeHtml(exports.BRAND.name)}
              </div>
              <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px;">
                ${escapeHtml(exports.BRAND.tagline)}
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
            <td style="padding:18px 36px 28px 36px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:${exports.BRAND.mutedColor};">
              ${opts.footerNote ?? ''}
              <div style="margin-top:18px;">
                Need help? Reach us at
                <a href="mailto:${escapeHtml(exports.BRAND.supportEmail)}" style="color:${exports.BRAND.primaryColor};text-decoration:none;">${escapeHtml(exports.BRAND.supportEmail)}</a>.
              </div>
              <div style="margin-top:18px;color:#9ca3af;font-size:12px;">
                &copy; ${year} ${escapeHtml(exports.BRAND.name)}. All rights reserved.
              </div>
            </td>
          </tr>
        </table>
        <div style="font-size:12px;color:#9ca3af;margin-top:16px;">
          You are receiving this email because you have an account on ${escapeHtml(exports.BRAND.name)}.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
function renderCtaButton(label, href) {
    return `
<p style="text-align:center;margin:28px 0 8px 0;">
  <a href="${escapeHtml(href)}"
     target="_blank"
     rel="noopener noreferrer"
     style="display:inline-block;background:${exports.BRAND.primaryColor};color:#ffffff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;letter-spacing:0.2px;">
    ${escapeHtml(label)}
  </a>
</p>
<p style="text-align:center;margin:8px 0 0 0;font-size:13px;color:${exports.BRAND.mutedColor};">
  Or copy this link into your browser:
  <br/>
  <span style="word-break:break-all;color:${exports.BRAND.primaryColor};">${escapeHtml(href)}</span>
</p>`;
}
function buildVerificationEmail(input) {
    const displayName = input.username || input.recipientEmail;
    const recipientFirstName = displayName.split(/[\s._-]/)[0] || displayName;
    const ttl = input.expiresInHours ?? 24;
    const preheader = `Confirm your ${exports.BRAND.name} email address — link expires in ${ttl} hours.`;
    const bodyHtml = `
    <h2 style="margin:0 0 12px 0;font-size:22px;color:${exports.BRAND.textColor};">
      Welcome, ${escapeHtml(recipientFirstName)}!
    </h2>
    <p style="margin:0 0 14px 0;">
      Thanks for signing up to ${escapeHtml(exports.BRAND.name)}. To start booking turfs and managing your games, please confirm this email address.
    </p>
    <p style="margin:0;">
      This link will expire in <strong>${ttl} hours</strong> for security reasons.
    </p>`;
    const html = renderBrandedLayout({
        preheader,
        bodyHtml,
        ctaHtml: renderCtaButton('Verify my email', input.verificationLink),
        footerNote: 'If the button above does not work, please copy and paste the URL into your browser. ' +
            'If you did not create this account, you can safely ignore this email.',
    });
    return {
        to: input.recipientEmail,
        subject: `Verify your ${exports.BRAND.name} email`,
        text: `Hi ${displayName},\n\n` +
            `Thanks for signing up to ${exports.BRAND.name}. ` +
            `Please confirm your email address by visiting:\n\n${input.verificationLink}\n\n` +
            `This link expires in ${ttl} hours.\n\n` +
            `If you did not create this account, please ignore this email.\n\n` +
            `— The ${exports.BRAND.name} team`,
        html,
    };
}
function buildPasswordResetEmail(input) {
    const displayName = input.username || input.recipientEmail;
    const recipientFirstName = displayName.split(/[\s._-]/)[0] || displayName;
    const ttl = input.expiresInMinutes ?? 60;
    const preheader = `Reset your ${exports.BRAND.name} password — link expires in ${ttl} minutes.`;
    const bodyHtml = `
    <h2 style="margin:0 0 12px 0;font-size:22px;color:${exports.BRAND.textColor};">
      Reset your password
    </h2>
    <p style="margin:0 0 14px 0;">
      Hi ${escapeHtml(recipientFirstName)}, we received a request to reset the password for your ${escapeHtml(exports.BRAND.name)} account (${escapeHtml(input.recipientEmail)}).
    </p>
    <p style="margin:0;">
      Click the button below to choose a new password. This link will expire in <strong>${ttl} minutes</strong>.
    </p>
    <p style="margin:18px 0 0 0;color:${exports.BRAND.mutedColor};font-size:14px;">
      If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.
    </p>`;
    const html = renderBrandedLayout({
        preheader,
        bodyHtml,
        ctaHtml: renderCtaButton('Reset my password', input.resetLink),
    });
    return {
        to: input.recipientEmail,
        subject: `Reset your ${exports.BRAND.name} password`,
        text: `Hi ${displayName},\n\n` +
            `Reset your ${exports.BRAND.name} password by visiting:\n\n${input.resetLink}\n\n` +
            `This link expires in ${ttl} minutes.\n\n` +
            `If you did not request this, you can ignore this email.\n\n` +
            `— The ${exports.BRAND.name} team`,
        html,
    };
}
function buildOtpEmail(input) {
    const displayName = input.username || input.recipientEmail;
    const recipientFirstName = displayName.split(/[\s._-]/)[0] || displayName;
    const ttl = input.expiresInMinutes ?? 10;
    const preheader = `Your ${exports.BRAND.name} verification code is ${input.otpCode} — valid for ${ttl} minutes.`;
    const bodyHtml = `
    <h2 style="margin:0 0 16px 0;font-size:22px;color:${exports.BRAND.textColor};">
      Verify your email, ${escapeHtml(recipientFirstName)}
    </h2>
    <p style="margin:0 0 20px 0;">
      Thanks for signing up to ${escapeHtml(exports.BRAND.name)}. Use the verification code below to complete your registration.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;">
      <tr>
        <td align="center" style="background:${exports.BRAND.bgColor};border-radius:10px;padding:20px 24px;">
          <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:${exports.BRAND.primaryColor};font-family:'Courier New',Courier,monospace;">
            ${escapeHtml(input.otpCode)}
          </span>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0;font-size:14px;color:${exports.BRAND.mutedColor};">
      This code expires in <strong>${ttl} minutes</strong>. Do not share it with anyone.
    </p>
    <p style="margin:18px 0 0 0;padding:14px 16px;background:#fef3c7;border-left:4px solid ${exports.BRAND.accentColor};border-radius:0 8px 8px 0;font-size:13px;color:#92400e;line-height:1.5;">
      <strong>Security notice:</strong> ${escapeHtml(exports.BRAND.name)} will never ask you for this code by phone, SMS, or email. If you did not request this code, you can safely ignore this message.
    </p>`;
    const html = renderBrandedLayout({
        preheader,
        bodyHtml,
    });
    return {
        to: input.recipientEmail,
        subject: `Your ${exports.BRAND.name} verification code`,
        text: `Hi ${displayName},\n\n` +
            `Your ${exports.BRAND.name} verification code is:\n\n` +
            `    ${input.otpCode}\n\n` +
            `This code expires in ${ttl} minutes.\n` +
            `Do not share this code with anyone.\n\n` +
            `If you did not request this code, please ignore this email.\n\n` +
            `— The ${exports.BRAND.name} team`,
        html,
    };
}
// ── Console implementation (default fallback) ─────────────────────────────────
class ConsoleEmailService {
    async send(message) {
        logger_1.logger.info('=====================================================');
        logger_1.logger.info(`[EMAIL:console] To: ${message.to}`);
        logger_1.logger.info(`[EMAIL:console] Subject: ${message.subject}`);
        if (message.text) {
            logger_1.logger.info(`[EMAIL:console] Body (text):\n${message.text}`);
        }
        else if (message.html) {
            const stripped = message.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            logger_1.logger.info(`[EMAIL:console] Body (text-stripped): ${stripped.slice(0, 400)}…`);
        }
        logger_1.logger.info('=====================================================');
    }
}
exports.ConsoleEmailService = ConsoleEmailService;
/**
 * Send emails via the Hostinger Mail REST API.
 *
 * The Hostinger endpoint expects the token in a plain `Authorization` header
 * (not `Bearer`-prefixed) and accepts recipients as a JSON array rather than
 * the nested structure Resend used.  Timeout / 5xx failures are retried with
 * exponential backoff; 4xx (other than 429) fail immediately.
 */
class HostingerEmailService {
    constructor(cfg) {
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
        this.timeoutMs = cfg.timeoutMs ?? 10000;
        this.retries = cfg.retries ?? 2;
    }
    async send(message) {
        if (!message.to)
            throw new Error('EmailMessage.to is required');
        const payload = {
            from: this.from,
            to: [message.to],
            subject: message.subject,
        };
        // Hostinger accepts html/text alongside subject in the same payload.
        if (message.html)
            payload.html = message.html;
        if (message.text)
            payload.text = message.text;
        if (!message.html && !message.text) {
            throw new Error('EmailMessage must contain at least one of html or text');
        }
        await this.sendWithRetries(payload, message);
    }
    async sendWithRetries(payload, message) {
        const maxAttempts = Math.max(1, this.retries + 1);
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this.sendOnce(payload);
                return;
            }
            catch (err) {
                lastError = err;
                const classified = classifyError(err);
                logger_1.logger.warn(`[email:hostinger] send attempt ${attempt}/${maxAttempts} failed (${classified.code}): ` +
                    (err instanceof Error ? err.message : String(err)));
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
        logger_1.logger.error(`[email:hostinger] giving up on email to ${message.to}: ${detail}`);
        throw new Error(`Failed to send email to ${message.to}: ${detail}`);
    }
    async sendOnce(payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.apiBaseUrl}/send`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `${exports.BRAND.name}-backend/1.0`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            if (response.ok) {
                // Optionally surface the provider message ID for log correlation
                try {
                    const body = (await response.json());
                    if (body?.id)
                        logger_1.logger.debug(`[email:hostinger] accepted message id=${body.id}`);
                }
                catch {
                    // body parsing is best-effort
                }
                return;
            }
            // Build an error object that classifyError can read
            const text = await safeReadText(response);
            const err = new Error(`Hostinger API ${response.status}: ${text || response.statusText}`);
            err.status = response.status;
            err.code = `hostinger_${response.status}`;
            throw err;
        }
        catch (err) {
            if (err.name === 'AbortError') {
                const timeoutErr = new Error(`Hostinger request timed out after ${this.timeoutMs}ms`);
                timeoutErr.code = 'hostinger_timeout';
                throw timeoutErr;
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.HostingerEmailService = HostingerEmailService;
// ── Helpers ───────────────────────────────────────────────────────────────────
function classifyError(err) {
    const e = err;
    const status = e?.status;
    const code = e?.code ?? 'unknown';
    // Timeout or network failure → retryable
    if (!status)
        return { permanent: false, code };
    if (status === 429)
        return { permanent: false, code }; // rate-limited → retry
    if (status >= 500)
        return { permanent: false, code }; // server-side → retry
    if (status >= 400)
        return { permanent: true, code }; // 4xx other than 429 → permanent
    return { permanent: false, code };
}
function backoffMs(attempt) {
    // Exponential with jitter: 250ms, 750ms, 1750ms … capped at 8s.
    const base = Math.min(250 * Math.pow(2, attempt - 1), 8000);
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function safeReadText(response) {
    try {
        return (await response.text()).slice(0, 500);
    }
    catch {
        return '';
    }
}
function createEmailService(opts = {}) {
    const apiToken = (opts.apiToken ?? process.env.HOSTINGER_API_TOKEN ?? '').trim();
    const from = (opts.from ?? process.env.EMAIL_FROM ?? exports.BRAND.supportEmail).trim();
    const mailboxId = (opts.mailboxId ?? process.env.HOSTINGER_MAILBOX_ID ?? '').trim();
    if (!apiToken) {
        logger_1.logger.warn('[email] HOSTINGER_API_TOKEN not set — falling back to ConsoleEmailService. ' +
            'Set HOSTINGER_API_TOKEN in production to actually send mail.');
        return new ConsoleEmailService();
    }
    logger_1.logger.info(`[email] Using Hostinger sender "${from}".`);
    return new HostingerEmailService({ apiToken, from, mailboxId });
}
