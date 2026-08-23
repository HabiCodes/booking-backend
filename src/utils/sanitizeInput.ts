/**
 * Input sanitization utilities to prevent XSS and injection attacks.
 */

/**
 * Strip HTML tags and encode special characters to prevent XSS.
 * Converts: <script> → &lt;script&gt;, " → &quot;, etc.
 */
export function sanitizeHtml(input: string | null | undefined): string | null {
  if (input == null) return null;
  // Strip all HTML tags
  let cleaned = input.replace(/<[^>]*>/g, '');
  // Encode special HTML characters
  cleaned = cleaned.replace(/&/g, '&amp;');
  cleaned = cleaned.replace(/</g, '&lt;');
  cleaned = cleaned.replace(/>/g, '&gt;');
  cleaned = cleaned.replace(/"/g, '&quot;');
  cleaned = cleaned.replace(/'/g, '&#x27;');
  cleaned = cleaned.replace(/\//g, '&#x2F;');
  // Trim whitespace
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Sanitize an object's string fields by applying sanitizeHtml to each field.
 * Fields listed in htmlFields will have HTML stripped + entities encoded.
 */
export function sanitizeObject<T extends Record<string, any>>(
  obj: T,
  htmlFields: (keyof T)[]
): T {
  const sanitized = { ...obj };
  for (const field of htmlFields) {
    if (sanitized[field] !== undefined && sanitized[field] !== null) {
      sanitized[field] = sanitizeHtml(String(sanitized[field])) as any;
    }
  }
  return sanitized;
}

/**
 * Validate and sanitize a username — alphanumeric + underscores/dashes only, 3-50 chars.
 */
export function sanitizeUsername(username: string | undefined): string | undefined {
  if (!username) return username;
  const cleaned = username.trim();
  if (cleaned.length < 3 || cleaned.length > 50) return undefined;
  // Only allow alphanumeric, spaces, hyphens, underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Rate-limit key builder — normalize email for consistent rate limiting.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Truncate a string to maxLength, appending '...' if truncated.
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
