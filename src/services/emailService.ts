/**
 * Email delivery abstraction.
 *
 * Current implementation: logs the message content to the console.
 * To use a real SMTP provider, install `nodemailer` and implement
 * `NodemailerEmailService` — the rest of the auth layer does not change.
 */

import { generateSecureToken, hashToken } from '../utils/safeToken';
import type { VerificationTokenRow } from '../types';

export interface EmailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<void>;
}

/** Console-based implementation — safe for development / no external deps. */
export class ConsoleEmailService implements EmailService {
  async send(message: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[EMAIL]', message.subject, '→', message.to);
    if (message.text) {
      // eslint-disable-next-line no-console
      console.log(message.text);
    }
  }
}

export function buildVerificationEmail(verificationLink: string, recipientEmail: string, username: string | null): EmailMessage {
  const displayName = username || recipientEmail;
  return {
    to: recipientEmail,
    subject: 'Verify your email address',
    text: `Hi ${displayName},\n\nPlease verify your email by clicking this link:\n${verificationLink}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #333;">
        <h2 style="color: #1a1a2e;">Welcome, ${escapeHtml(displayName)}!</h2>
        <p>Please verify your email address by clicking the button below:</p>
        <p style="text-align:center;">
          <a href="${escapeHtml(verificationLink)}"
             style="background: #7c3aed; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Verify Email
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">This link expires in 24 hours.</p>
        <p style="color: #999; font-size: 12px;">If you did not create an account, please ignore this email.</p>
      </div>`,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}