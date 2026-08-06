/**
 * Domain types — single source of truth for every row shape the app reads
 * from PostgreSQL.  Keep this file in sync with migrations/versions/*.sql.
 *
 * Conventions:
 *  - Row interfaces  → exactly match DB columns (snake_case)
 *  - DTO interfaces  → what the API returns to the client (camelCase)
 *  - Input interfaces → what the client sends to us (camelCase)
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  username: string | null;
  password_hash: string;
  is_verified: boolean;
  is_active: boolean;
  last_login_at: string | null;
  email_verified_at: string | null;
  created_at: string;
}

export interface UserPublic {
  id: number;
  email: string;
  username: string | null;
  is_verified: boolean;
  is_active: boolean;
  created_at: string;
}

export interface UserCreateInput {
  email: string;
  username?: string;
  password: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventStatus = 'draft' | 'published' | 'hidden' | 'cancelled';
export type EventVisibility = 'public' | 'private' | 'unlisted';

export interface EventRow {
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string;
  venue: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  event_date: string | null;       // DATE
  start_time: string | null;       // TIME
  end_time: string | null;         // TIME
  start_at: string;                // TIMESTAMPTZ
  end_at: string;                  // TIMESTAMPTZ
  banner_url: string | null;
  thumbnail_url: string | null;
  logo_url: string | null;
  gallery: string[];               // JSONB array of URLs
  organizer: string | null;
  capacity: number;
  remaining_capacity: number | null;
  price: number | string;          // pg returns NUMERIC as string
  currency: string;
  status: EventStatus;
  visibility: EventVisibility;
  is_featured: boolean;
  is_active: boolean;
  cancel_window_hours: number;
  cancellable_until: string | null;
  published_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingStats {
  capacity: number;
  bookedCount: number;
  remaining: number;
}

export interface EventListQuery {
  page?: number;
  pageSize?: number;
  offset?: number;
  limit?: number;       // alias for pageSize (backward compat)
  sortBy?: 'created_at' | 'event_date' | 'title';
  sortOrder?: 'ASC' | 'DESC';
  category?: string;
  city?: string;
  q?: string;
  search?: string;
  status?: EventStatus;
  featured?: boolean;
  fromDate?: string;
  toDate?: string;
  include_deleted?: boolean;
}

export interface EventListResult<T = EventRow> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EventCreateInput {
  title: string;
  subtitle?: string;
  description?: string;
  category?: string;
  venue: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  event_date?: string;
  start_time?: string;
  end_time?: string;
  start_at: string;
  end_at: string;
  banner_url?: string;
  thumbnail_url?: string;
  logo_url?: string;
  gallery?: string[];
  organizer?: string;
  capacity: number;
  remaining_capacity?: number;
  price?: number;
  currency?: string;
  status?: EventStatus;
  visibility?: EventVisibility;
  is_featured?: boolean;
  cancel_window_hours?: number;
}

export interface EventUpdateInput extends Partial<EventCreateInput> {
  is_active?: boolean;
  cancel_window_hours?: number;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'attended';

export interface BookingRow {
  id: number;
  user_id: number;
  event_id: number;
  ticket_count: number;
  status: BookingStatus;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingWithEventRow extends BookingRow {
  event_title: string;
  event_venue: string;
  event_start_at: string;
  event_banner_url: string | null;
}

export interface BookingListItem {
  id: number;
  user_email: string;
  user_username: string | null;
  event_id: number;
  event_title: string;
  ticket_count: number;
  status: BookingStatus;
  created_at: string;
  cancelled_at: string | null;
}

export interface CreateBookingInput {
  event_id: number;
  attendees: AttendeeInput[];
}

export interface AttendeeInput {
  full_name: string;
  phone: string;
  age?: string | number | null;
  gender?: string | null;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface TicketRow {
  id: number;
  booking_id: number;
  ticket_uuid: string;
  attendee_name: string;
  attendee_phone: string;
  attendee_age: number | null;
  attendee_gender: string | null;
  checked_in: boolean;
  checked_in_at: string | null;
  checked_in_by: number | null;
  signature: string | null;
  issued_at: string;
  deleted_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

export type AdminRole = 'super_admin' | 'admin' | 'event_manager' | 'ticket_scanner';

/**
 * Granular permission keys. Adding a new permission only requires extending this
 * union and adding it to the role → permissions map in `src/rbac/permissions.ts`.
 */
export type AdminPermission =
  | 'users:read'
  | 'users:write'
  | 'users:delete'
  | 'events:read'
  | 'events:write'
  | 'events:delete'
  | 'events:publish'
  | 'events:feature'
  | 'bookings:read'
  | 'bookings:cancel'
  | 'bookings:delete'
  | 'banners:read'
  | 'banners:write'
  | 'banners:delete'
  | 'banners:activate'
  | 'uploads:read'
  | 'uploads:write'
  | 'uploads:delete'
  | 'scanner:verify'
  | 'scanner:checkin'
  | 'admins:read'
  | 'admins:write'
  | 'admins:delete'
  | 'audit:read'
  | 'analytics:read';

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  role: AdminRole;
  is_active: boolean;
  last_login_at: string | null;
  permissions: Record<string, boolean>;
  created_at: string;
}

export interface AdminPublic {
  id: number;
  email: string;
  name: string;
  role: AdminRole;
  is_active: boolean;
  last_login_at: string | null;
  permissions: Record<string, boolean>;
  created_at: string;
}

export interface AdminLoginInput {
  email: string;
  password: string;
}

// ---------------------------------------------------------------------------
// Security / Auth tokens
// ---------------------------------------------------------------------------

export interface RefreshTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  device_info: string | null;
  ip_address: string | null;
  expires_at: string;
  revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface VerificationTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  type: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface UserSessionRow {
  id: number;
  user_id: number;
  device_info: string | null;
  ip_address: string | null;
  user_agent: string | null;
  is_current: boolean;
  revoked: boolean;
  last_active_at: string;
  created_at: string;
}

export interface AdminSessionRow {
  id: number;
  admin_id: number;
  device_info: string | null;
  ip_address: string | null;
  user_agent: string | null;
  revoked: boolean;
  last_active_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Login attempts (brute-force tracking)
// ---------------------------------------------------------------------------

export interface LoginAttemptRow {
  id: number;
  email: string;
  ip_address: string;
  user_agent: string | null;
  success: boolean;
  attempted_at: string;
}

// ---------------------------------------------------------------------------
// Banners & File Uploads
// ---------------------------------------------------------------------------

export type BannerPlacement = 'ticket_advertisement' | 'homepage_hero' | 'event_thumbnail';

export interface BannerRow {
  id: number;
  image_url: string;
  cloudinary_public_id: string | null;
  placement: BannerPlacement;
  is_active: boolean;
  uploaded_by: number | null;
  activated_at: string | null;
  deactivated_at: string | null;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  alt_text: string | null;
  link_url: string | null;
  priority: number;
  deleted_at: string | null;
  created_at: string;
}

export interface FileUploadRow {
  id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  entity_type: string | null;
  entity_id: number | null;
  uploaded_by: number | null;
  deleted_at: string | null;
  created_at: string;
}

export interface UploadBannerInput {
  placement: BannerPlacement;
  alt_text?: string | null;
  link_url?: string | null;
  priority?: number;
}

export interface UpdateBannerInput {
  alt_text?: string | null;
  link_url?: string | null;
  priority?: number;
}

export interface UploadedFileMeta {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  fullPath: string;
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: number;
  admin_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface BookingAuditLogRow {
  id: number;
  booking_id: number | null;
  ticket_id: number | null;
  actor_type: string;
  actor_id: number | null;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Scan (QR validation)
// ---------------------------------------------------------------------------

export type ScanStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';

export interface ScanResult {
  status: ScanStatus;
  ticket?: {
    uuid: string;
    attendee_name: string;
    event_title: string;
    checked_in: boolean;
    checked_in_at: string | null;
    signature_valid?: boolean;
  };
  message: string;
}

export interface CancelBookingInput {
  booking_id: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

export interface PdfTicketPayload {
  event: EventRow;
  tickets: TicketRow[];
  bannerUrl?: string | null;
}

// ---------------------------------------------------------------------------
// API response wrapper
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  pagination?: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}
