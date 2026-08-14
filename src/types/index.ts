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

export type EventStatus = 'draft' | 'pending_review' | 'approved' | 'published' | 'hidden' | 'archived' | 'cancelled';
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
  organization_id: number | null;  // Migration 016
  organizer_status: string | null; // Migration 016
  submitted_at: string | null;         // Migration 019 - when organizer submitted for review
  rejection_reason: string | null;     // Migration 019
  reviewed_by: number | null;          // Migration 019
  reviewed_at: string | null;          // Migration 019
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
  submitted_for_review_at: string | null;   // Migration 014
  approved_at: string | null;               // Migration 014
  approved_by: number | null;               // Migration 014
  archived_at: string | null;               // Migration 014
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
  // Platform admin permissions
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
  | 'media:read'
  | 'media:write'
  | 'media:delete'
  | 'scanner:verify'
  | 'scanner:checkin'
  | 'admins:read'
  | 'admins:write'
  | 'admins:delete'
  | 'audit:read'
  | 'analytics:read'
  // Organizer / partner platform permissions
  | 'organizer:applications:read'
  | 'organizer:applications:approve'
  | 'organizer:applications:reject'
  | 'organizer:applications:reopen'
  | 'organizer:events:read'
  | 'organizer:events:write'
  | 'organizer:events:approve'
  | 'organizer:bookings:read'
  | 'organizer:bookings:cancel'
  | 'organizer:bookings:write'
  | 'organizer:tickets:read'
  | 'organizer:tickets:scan'
  | 'organizer:tickets:checkin'
  | 'organizer:venues:read'
  | 'organizer:venues:write'
  | 'organizer:tiers:read'
  | 'organizer:tiers:write'
  | 'organizer:seats:read'
  | 'organizer:seats:write'
  | 'organizer:analytics:read'
  | 'organizer:staff:read'
  | 'organizer:staff:write'
  | 'organizer:staff:delete'
  | 'organizer:profile:read'
  | 'organizer:profile:write'
  | 'organizer:banking:read'
  | 'organizer:banking:write'
  | 'organizer:payments:read'
  | 'organizer:payments:write'
  | 'organizer:payments:refund';

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
  session_id?: number | null;
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
// Pending registrations (OTP-based signup — user row not created yet)
// ---------------------------------------------------------------------------

export interface PendingRegistrationRow {
  id: number;
  email: string;
  username: string | null;
  password_hash: string;
  otp_hash: string;
  otp_attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
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

// ---------------------------------------------------------------------------
// Media (Migration 013)
// ---------------------------------------------------------------------------

export type MediaType = 'poster' | 'banner' | 'gallery' | 'thumbnail' | 'logo';

export type MediaStatus = 'active' | 'archived';

export interface MediaRow {
  id: number;
  uploaded_by: number | null;
  storage_provider: 'local' | 's3' | 'cdn' | 'gcs';
  storage_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256_hash: string;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_provider: 'local' | 'youtube' | 'vimeo' | 'mux' | 'cloudflare' | null;
  thumbnail_media_id: number | null;
  public_url: string;
  blur_hash: string | null;
  dominant_color: string | null;
  alt_text: string | null;
  is_public: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaPublic {
  id: number;
  storage_provider: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_provider: string | null;
  public_url: string;
  blur_hash: string | null;
  dominant_color: string | null;
  alt_text: string | null;
  is_public: boolean;
  created_at: string;
}

export interface MediaCreateInput {
  storage_provider?: 'local' | 's3' | 'cdn' | 'gcs';
  storage_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256_hash: string;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  video_provider?: string | null;
  public_url: string;
  blur_hash?: string | null;
  dominant_color?: string | null;
  alt_text?: string | null;
  is_public?: boolean;
}

export interface MediaUpdateInput {
  file_name?: string;
  mime_type?: string;
  public_url?: string;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  blur_hash?: string | null;
  dominant_color?: string | null;
  alt_text?: string | null;
  is_public?: boolean;
  deleted_at?: string | null;
}

export interface EventMediaRow {
  id: number;
  event_id: number;
  media_id: number;
  media_type: MediaType;
  display_order: number;
  status: MediaStatus;
  is_primary: boolean;
  deleted_at: string | null;
  created_at: string;
}

export interface EventMediaPublic {
  id: number;
  event_id: number;
  media_id: number;
  media: MediaPublic;
  media_type: MediaType;
  display_order: number;
  status: MediaStatus;
  is_primary: boolean;
  created_at: string;
}

export interface EventMediaCreateInput {
  media_id: number;
  media_type: MediaType;
  display_order?: number;
  is_primary?: boolean;
}

export interface EventMediaUpdateInput {
  media_type?: MediaType;
  display_order?: number;
  status?: MediaStatus;
  is_primary?: boolean;
}

export interface MediaListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  mime_type?: string;
  is_public?: boolean;
  include_deleted?: boolean;
  fromDate?: string;
  toDate?: string;
}

export interface MediaListResult {
  items: MediaPublic[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EventMediaListQuery {
  event_id: number;
  media_type?: MediaType;
  status?: MediaStatus;
  include_deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Event Lifecycle (Migration 014)
// ---------------------------------------------------------------------------

/**
 * Every valid event status value.  The state machine enforces which
 * transitions are allowed (see eventLifecycleService.ts).
 */
export type EventLifecycleAction =
  | 'submit_for_review'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'hide'
  | 'show'
  | 'archive'
  | 'restore'
  | 'cancel';

// Organizer-side event status (parallel to the admin EventStatus workflow)
export type EventOrganizerStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface EventOrganizerReviewInput {
  action: 'approve' | 'reject';
  reason?: string | null;
}

/**
 * One row in the event_status_history audit trail.
 */
export interface EventStatusHistoryRow {
  id: number;
  event_id: number;
  actor_admin_id: number | null;    // null when triggered by a system action
  from_status: EventStatus | null;  // null on creation
  to_status: EventStatus;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Safe subset of EventStatusHistoryRow returned to API consumers
 * (omits the full metadata blob — callers needing details use the
 * audit endpoint).
 */
export interface EventStatusHistoryPublic {
  id: number;
  event_id: number;
  actor_admin_id: number | null;
  actor_name: string | null;        // joined from admins
  from_status: EventStatus | null;
  to_status: EventStatus;
  reason: string | null;
  created_at: string;
}

/**
 * Input for requesting a status transition.
 */
export interface EventStatusTransitionInput {
  action: EventLifecycleAction;
  reason?: string | null;
}

/**
 * Snapshot of the workflow columns on events (Migration 014).
 */
export interface EventWorkflowInfo {
  submitted_for_review_at: string | null;
  approved_at: string | null;
  approved_by: number | null;
  archived_at: string | null;
}

/**
 * Combined view — event + its workflow snapshot.
 */
export interface EventWithWorkflow extends EventRow, EventWorkflowInfo {}

// ---------------------------------------------------------------------------
// Organizer Applications (Migration 015)
// ---------------------------------------------------------------------------

export type OrganizerAppStatus = 'pending' | 'approved' | 'soft_rejected' | 'hard_rejected';

export interface OrganizerApplicationRow {
  id: number;
  legal_name: string;
  display_name: string;
  email: string;
  phone: string | null;
  business_address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  gst_tax_id: string | null;
  pan: string | null;
  identity_document_url: string | null;
  business_document_url: string | null;
  supporting_document_urls: string[];
  account_holder_name: string | null;
  bank_details: Record<string, unknown>;
  payout_details: Record<string, unknown>;
  logo_url: string | null;
  description: string | null;
  branding_metadata: Record<string, unknown>;
  status: OrganizerAppStatus;
  rejection_type: 'soft' | 'hard' | null;
  rejection_reason: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  hard_rejected_by: number | null;
  hard_rejected_at: string | null;
  organization_id: number | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizerApplicationCreateInput {
  legal_name: string;
  display_name: string;
  email: string;
  phone?: string | null;
  business_address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  gst_tax_id?: string | null;
  pan?: string | null;
  identity_document_url?: string | null;
  business_document_url?: string | null;
  supporting_document_urls?: string[];
  account_holder_name?: string | null;
  bank_details?: Record<string, unknown>;
  payout_details?: Record<string, unknown>;
  logo_url?: string | null;
  description?: string | null;
  branding_metadata?: Record<string, unknown>;
}

export interface OrganizerApplicationReviewInput {
  action: 'approve' | 'soft_reject' | 'hard_reject' | 'reopen';
  reason?: string | null;
}

export interface OrganizerApplicationPublic {
  id: number;
  legal_name: string;
  display_name: string;
  email: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string;
  status: OrganizerAppStatus;
  rejection_type: 'soft' | 'hard' | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface OrganizerApplicationHistoryRow {
  id: number;
  application_id: number;
  from_status: OrganizerAppStatus | null;
  to_status: OrganizerAppStatus;
  reason: string | null;
  actor_admin_id: number | null;
  actor_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface OrganizerEventHistoryRow {
  id: number;
  event_id: number;
  organization_id: number;
  actor_type: string;
  actor_user_id: number | null;
  actor_admin_id: number | null;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Organizations (Migration 016)
// ---------------------------------------------------------------------------

export interface OrganizationRow {
  id: number;
  name: string;
  display_name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  logo_url: string | null;
  description: string | null;
  branding_metadata: Record<string, unknown>;
  bank_details: Record<string, unknown>;
  payout_details: Record<string, unknown>;
  is_active: boolean;
  application_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationPublic {
  id: number;
  name: string;
  display_name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  logo_url: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrganizationUpdateInput {
  name?: string;
  display_name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  logo_url?: string | null;
  description?: string | null;
  branding_metadata?: Record<string, unknown>;
}

export interface OrganizationBankUpdateInput {
  account_holder_name?: string | null;
  bank_details?: Record<string, unknown>;
  payout_details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Organizer Users (Migration 016)
// ---------------------------------------------------------------------------

export type OrganizerUserRole = 'owner' | 'manager';

export interface OrganizerUserRow {
  id: number;
  organization_id: number;
  email: string;
  password_hash: string;
  name: string;
  phone: string | null;
  role: OrganizerUserRole;
  permissions: Record<string, boolean>;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizerUserPublic {
  id: number;
  organization_id: number;
  email: string;
  name: string;
  phone: string | null;
  role: OrganizerUserRole;
  permissions: Record<string, boolean>;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizerUserCreateInput {
  email: string;
  name: string;
  phone?: string | null;
  password: string;
  role: OrganizerUserRole;
  permissions?: Record<string, boolean>;
}

export interface OrganizerUserUpdateInput {
  email?: string;
  name?: string;
  phone?: string | null;
  role?: OrganizerUserRole;
  permissions?: Record<string, boolean>;
  is_active?: boolean;
}

export interface OrganizerPasswordTokenRow {
  id: number;
  organizer_user_id: number;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface OrganizerLoginInput {
  email: string;
  password: string;
}

export interface OrganizerLoginResult {
  user: OrganizerUserPublic;
  token: string;
  organization: OrganizationPublic;
}

// ---------------------------------------------------------------------------
// Venues (Migration 017)
// ---------------------------------------------------------------------------

export interface VenueRow {
  id: number;
  organization_id: number | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  seating_map: Record<string, unknown>;
  notes: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VenuePublic {
  id: number;
  organization_id: number | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VenueCreateInput {
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;
  seating_map?: Record<string, unknown>;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Ticket Tiers (Migration 017)
// ---------------------------------------------------------------------------

export type TicketTierType = 'general' | 'reserved';
export type TicketTierStatus = 'active' | 'paused' | 'sold_out' | 'archived';

export interface TicketTierRow {
  id: number;
  event_id: number;
  name: string;
  description: string | null;
  type: TicketTierType;
  price: string;
  currency: string;
  total_quantity: number;
  sold_quantity: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  status: TicketTierStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TicketTierPublic {
  id: number;
  event_id: number;
  name: string;
  description: string | null;
  type: TicketTierType;
  price: number;
  currency: string;
  total_quantity: number;
  sold_quantity: number;
  remaining_quantity: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  status: TicketTierStatus;
  created_at: string;
  updated_at: string;
}

export interface TicketTierCreateInput {
  name: string;
  description?: string | null;
  type?: TicketTierType;
  price: number;
  currency?: string;
  total_quantity: number;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TicketTierUpdateInput {
  name?: string;
  description?: string | null;
  price?: number;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  status?: TicketTierStatus;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Seats (Migration 017)
// ---------------------------------------------------------------------------

export type SeatType = 'standard' | 'vip' | 'premium' | 'accessible' | 'wheelchair';

export interface SeatRow {
  id: number;
  event_id: number;
  tier_id: number | null;
  section: string;
  row_label: string;
  seat_number: number;
  label: string | null;
  seat_type: SeatType;
  is_available: boolean;
  is_reserved: boolean;
  is_held: boolean;
  hold_expires_at: string | null;
  hold_booking_id: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SeatPublic {
  id: number;
  event_id: number;
  tier_id: number | null;
  section: string;
  row_label: string;
  seat_number: number;
  label: string | null;
  seat_type: SeatType;
  is_available: boolean;
  is_reserved: boolean;
  created_at: string;
}

export interface SeatBulkCreateInput {
  section: string;
  rows: Array<{
    row_label: string;
    seat_numbers: number[];
    seat_type?: SeatType;
  }>;
}

// ---------------------------------------------------------------------------
// Check-ins (Migration 017)
// ---------------------------------------------------------------------------

export type CheckInStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED' | 'CANCELLED' | 'WRONG_EVENT';

export interface CheckInRow {
  id: number;
  ticket_id: number;
  event_id: number;
  scanned_by: number;
  status: CheckInStatus;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CheckInRecord {
  id: number;
  ticket_id: number;
  ticket_uuid: string;
  event_id: number;
  event_title: string;
  attendee_name: string;
  scanned_by: number;
  scanner_name: string;
  status: CheckInStatus;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Analytics DTOs (VS3 backend)
// ---------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Cashfree Payments (Migration 020)
// --------------------------------------------------------------------------

export type PaymentOrderStatus =
  | 'CREATED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export type PaymentGateway = 'cashfree';

export type VerificationSource = 'webhook' | 'api_poll';

export interface PaymentOrderRow {
  id: number;
  order_id: string;
  booking_id: number;
  organization_id: number;
  event_id: number;
  amount: string;
  currency: string;
  cf_payment_id: string | null;
  cf_order_token: string | null;
  cf_payment_session_id: string | null;
  cf_authorization_id: string | null;
  status: PaymentOrderStatus;
  payment_method: string | null;
  payment_gateway: PaymentGateway;
  error_code: string | null;
  error_message: string | null;
  verified_at: string | null;
  verified_by: VerificationSource | null;
  idempotency_key: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentOrderPublic {
  id: number;
  order_id: string;
  booking_id: number;
  organization_id: number;
  event_id: number;
  amount: number;
  currency: string;
  cf_payment_id: string | null;
  status: PaymentOrderStatus;
  payment_method: string | null;
  payment_gateway: PaymentGateway;
  error_code: string | null;
  error_message: string | null;
  verified_at: string | null;
  verified_by: VerificationSource | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentOrderCreateInput {
  booking_id: number;
  order_id: string;
  organization_id: number;
  event_id?: number | null;
  amount: number;
  currency?: string;
  idempotency_key?: string;
  payment_method?: string | null;
}

export type RefundStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type RefundType =
  | 'customer_initiated'
  | 'organizer_initiated'
  | 'admin_initiated'
  | 'fraud'
  | 'payment_failure';

export interface RefundRow {
  id: number;
  payment_order_id: number;
  booking_id: number;
  cf_refund_id: string | null;
  cf_refund_status: string | null;
  amount: string;
  currency: string;
  reason: string | null;
  refund_type: RefundType;
  status: RefundStatus;
  created_by_admin_id: number | null;
  created_by_user_id: number | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundPublic {
  id: number;
  payment_order_id: number;
  booking_id: number;
  cf_refund_id: string | null;
  cf_refund_status: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  refund_type: RefundType;
  status: RefundStatus;
  created_by_admin_id: number | null;
  created_by_user_id: number | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundCreateInput {
  payment_order_id: number;
  booking_id: number;
  amount: number;
  reason?: string | null;
  refund_type?: RefundType;
}

// ── Cancellation Requests + Refund Policies (Migration 029) ─────────────────

export type CancellationRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'READY_FOR_MANUAL_PAYMENT' | 'PAID';

export type RefundPolicyScope = 'global' | 'organization';

export interface RefundPolicyRow {
  id: number;
  scope: RefundPolicyScope;
  organization_id: number | null;
  version: number;
  hours_before: string;          // NUMERIC -> string from pg
  refund_percentage: string;     // NUMERIC -> string from pg
  is_active: boolean;
  notes: string | null;
  created_by_admin_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RefundPolicyPublic {
  id: number;
  scope: RefundPolicyScope;
  organization_id: number | null;
  version: number;
  hours_before: number;
  refund_percentage: number;
  is_active: boolean;
  notes: string | null;
  created_by_admin_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RefundPolicyCreateInput {
  scope?: RefundPolicyScope;
  organization_id?: number | null;
  version?: number;
  hours_before: number;
  refund_percentage: number;
  is_active?: boolean;
  notes?: string | null;
  created_by_admin_id?: number | null;
}

export interface CancellationRequestRow {
  id: number;
  booking_id: number;
  payment_order_id: number;
  organization_id: number;
  requested_by: number;
  requested_at: string;
  reason: string | null;
  hours_before_event: string;
  policy_id: number | null;
  calculated_refund_percentage: string;
  calculated_refund_amount_paise: string | number;
  status: CancellationRequestStatus;
  approved_by_admin_id: number | null;
  approved_at: string | null;
  approved_refund_percentage: string | null;
  approved_refund_amount_paise: string | number | null;
  override_reason: string | null;
  rejection_reason: string | null;
  refund_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CancellationRequestPublic {
  id: number;
  booking_id: number;
  payment_order_id: number;
  organization_id: number;
  requested_by: number;
  requested_at: string;
  reason: string | null;
  hours_before_event: number;
  policy_id: number | null;
  calculated_refund_percentage: number;
  calculated_refund_amount_paise: number;
  status: CancellationRequestStatus;
  approved_by_admin_id: number | null;
  approved_at: string | null;
  approved_refund_percentage: number | null;
  approved_refund_amount_paise: number | null;
  override_reason: string | null;
  rejection_reason: string | null;
  refund_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CancellationRequestCreateInput {
  booking_id: number;
  payment_order_id: number;
  organization_id: number;
  requested_by: number;
  reason?: string | null;
  hours_before_event: number;
  policy_id: number | null;
  calculated_refund_percentage: number;
  calculated_refund_amount_paise: number;
}

export interface CancellationApprovalInput {
  admin_id: number;
  approved_percentage?: number;   // if omitted, uses calculated
  override_reason?: string | null;
}

export interface CancellationRejectionInput {
  admin_id: number;
  rejection_reason?: string | null;
}

// ── Manual Payments (Migration 030) ──────────────────────────────────────────

export interface ManualPaymentRow {
  id: number;
  cancellation_request_id: number;
  customer_upi_id: string;
  amount_paise: number;
  transaction_ref_id: string;
  payment_date: string;
  paid_at: string;
  created_by_admin_id: number;
  created_at: string;
  updated_at: string;
}

export interface ManualPaymentCreateInput {
  cancellation_request_id: number;
  customer_upi_id: string;
  amount_paise: number;
  transaction_ref_id: string;
  payment_date: string;
  created_by_admin_id: number;
}

export interface MarkManualPaymentInput {
  admin_id: number;
  customer_upi_id: string;
  amount_paise: number;
  transaction_ref_id: string;
  payment_date: string;
}

export interface WebhookEventRow {
  id: number;
  source: string;
  event_type: string;
  event_id: string;
  idempotency_key: string;
  raw_payload: Record<string, unknown>;
  processed_at: string | null;
  processing_error: string | null;
  related_order_id: string | null;
  created_at: string;
}

export interface WebhookEventPublic {
  id: number;
  source: string;
  event_type: string;
  event_id: string;
  processed_at: string | null;
  processing_error: string | null;
  related_order_id: string | null;
  created_at: string;
}

// --------------------------------------------------------------------------
// Manager Invitations (Migration 021)
// --------------------------------------------------------------------------

export interface ManagerInvitationRow {
  id: number;
  organization_id: number;
  invited_by_user_id: number;
  email: string;
  name: string | null;
  token_hash: string;
  permissions: Record<string, boolean>;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: number | null;
  revoked_at: string | null;
  revoked_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ManagerInvitationPublic {
  id: number;
  organization_id: number;
  email: string;
  name: string | null;
  permissions: Record<string, boolean>;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManagerInvitationCreateInput {
  email: string;
  name?: string | null;
  permissions?: Record<string, boolean>;
  expires_in_hours?: number;
}

export interface ManagerInvitationAcceptInput {
  token: string;
  name: string;
  password: string;
}

export interface ManagerInvitationTokenPayload {
  invitation_id: number;
  organization_id: number;
  email: string;
  permissions: Record<string, boolean>;
}

// --------------------------------------------------------------------------
// Analytics DTOs (VS2 enhanced)
// --------------------------------------------------------------------------

export interface OrganizerOverviewStats {
  total_events: number;
  draft_events: number;
  pending_approval_events: number;
  approved_events: number;
  published_events: number;
  total_bookings: number;
  total_tickets_sold: number;
  total_revenue: number;
  upcoming_events: number;
}

export interface OrganizerSalesByEvent {
  event_id: number;
  event_title: string;
  tickets_sold: number;
  revenue: number;
  booking_count: number;
  capacity: number;
  remaining_tickets: number;
}

export interface OrganizerSalesByTier {
  tier_id: number;
  tier_name: string;
  tickets_sold: number;
  revenue: number;
}

export interface OrganizerDailyStats {
  date: string;
  tickets_sold: number;
  revenue: number;
  booking_count: number;
}

export interface OrganizerCheckInStats {
  total_scans: number;
  valid_scans: number;
  duplicate_scans: number;
  invalid_scans: number;
  expired_scans: number;
  cancelled_scans: number;
  by_manager: Array<{
    user_id: number;
    user_name: string;
    scan_count: number;
  }>;
  by_event: Array<{
    event_id: number;
    event_title: string;
    scan_count: number;
  }>;
}

export interface OrganizerDashboardData {
  overview: OrganizerOverviewStats;
  sales_by_event: OrganizerSalesByEvent[];
  sales_by_tier: OrganizerSalesByTier[];
  daily_stats: OrganizerDailyStats[];
  check_in_stats: OrganizerCheckInStats;
}

export interface OrganizerSalesByEvent {
  event_id: number;
  event_title: string;
  tickets_sold: number;
  revenue: number;
  booking_count: number;
  capacity: number;
  remaining_tickets: number;
}

export interface OrganizerSalesByTier {
  tier_id: number;
  tier_name: string;
  tickets_sold: number;
  revenue: number;
}

export interface OrganizerDailyStats {
  date: string;
  tickets_sold: number;
  revenue: number;
  booking_count: number;
}

export interface OrganizerCheckInStats {
  total_scans: number;
  valid_scans: number;
  duplicate_scans: number;
  invalid_scans: number;
  expired_scans: number;
  cancelled_scans: number;
  by_manager: Array<{
    user_id: number;
    user_name: string;
    scan_count: number;
  }>;
  by_event: Array<{
    event_id: number;
    event_title: string;
    scan_count: number;
  }>;
}

export interface OrganizerDashboardData {
  overview: OrganizerOverviewStats;
  sales_by_event: OrganizerSalesByEvent[];
  sales_by_tier: OrganizerSalesByTier[];
  daily_stats: OrganizerDailyStats[];
  check_in_stats: OrganizerCheckInStats;
}

// ---------------------------------------------------------------------------
// Organizer Audit Logs (Migration 018)
// ---------------------------------------------------------------------------

export interface OrganizerAuditLogRow {
  id: number;
  organization_id: number;
  actor_user_id: number | null;
  actor_type: string;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// ===========================================================================
// TURF DOMAIN (Migration 022)
// ===========================================================================
// Independent business domain — NOT an event, NOT a special event type.
// Uses the same users / organizations / payments infrastructure.

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

export type TurfResourceType = 'slot_based' | 'seat_based' | 'zone_based';

export interface TurfVenueRow {
  id: number;
  organization_id: number;
  name: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  amenities: string[];
  status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TurfVenuePublic {
  id: number;
  organization_id: number;
  name: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  amenities: string[];
  status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TurfVenueCreateInput {
  name: string;
  description?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
}

export interface TurfVenueUpdateInput {
  name?: string;
  description?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
  status?: string;
  is_active?: boolean;
}

export interface TurfResourceRow {
  id: number;
  venue_id: number;
  resource_type: TurfResourceType;
  category: string;
  name: string;
  base_price: string;
  attributes: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TurfResourcePublic {
  id: number;
  venue_id: number;
  resource_type: TurfResourceType;
  category: string;
  name: string;
  base_price: number;
  attributes: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TurfResourceCreateInput {
  venue_id: number;
  resource_type: TurfResourceType;
  category: string;
  name: string;
  base_price: number;
  attributes?: Record<string, unknown>;
}

export interface TurfResourceUpdateInput {
  name?: string;
  category?: string;
  base_price?: number;
  attributes?: Record<string, unknown>;
  is_active?: boolean;
}

export interface TurfAvailabilityUnitRow {
  id: number;
  resource_id: number;
  starts_at: string;
  ends_at: string;
  price: string | null;
  seat_label: string | null;
  total_capacity: number | null;
  capacity_remaining: number;
  status: string;
  lock_holder_id: number | null;
  lock_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurfAvailabilityUnitPublic {
  id: number;
  resource_id: number;
  starts_at: string;
  ends_at: string;
  price: number | null;
  seat_label: string | null;
  total_capacity: number | null;
  capacity_remaining: number;
  status: string;
  lock_expires_at: string | null;
}

export type TurfBookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'expired';

export interface TurfBookingRow {
  id: number;
  booking_reference: string;
  user_id: number;
  organization_id: number;
  venue_id: number;
  resource_id: number;
  availability_unit_id: number;
  booking_type: string;
  offline_by_user_id: number | null;
  quantity: number;
  amount: string;
  currency: string;
  status: TurfBookingStatus;
  payment_status: string;
  payment_gateway_ref: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancellation_fee: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TurfBookingPublic {
  id: number;
  booking_reference: string;
  user_id: number;
  organization_id: number;
  venue_id: number;
  resource_id: number;
  availability_unit_id: number;
  booking_type: string;
  quantity: number;
  amount: number;
  currency: string;
  status: TurfBookingStatus;
  payment_status: string;
  payment_gateway_ref: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancellation_fee: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurfBookingDetail extends TurfBookingPublic {
  venue_name: string;
  resource_name: string;
  resource_type: string;
  category: string;
  slot_start: string;
  slot_end: string;
  qr_token: string | null;
  qr_status: string | null;
  customer_email: string;
  customer_name: string | null;
}

export interface TurfBookingCreateInput {
  availability_unit_id: number;
  quantity?: number;
  booking_type?: 'online' | 'offline';
  coupon_code?: string | null;
}

export interface TurfBookingConfirmInput {
  payment_order_id: string;
}

export interface TurfQRTicketRow {
  id: number;
  booking_id: number;
  token: string;
  status: string;
  used_at: string | null;
  used_by: number | null;
  created_at: string;
}

export interface TurfQRTicketPublic {
  id: number;
  booking_id: number;
  token: string;
  status: string;
  used_at: string | null;
  created_at: string;
}

export interface TurfCouponRow {
  id: number;
  organization_id: number;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: string;
  min_booking_amount: string;
  max_discount: string | null;
  usage_limit: number | null;
  used_count: number;
  per_user_limit: number;
  valid_from: string;
  valid_until: string;
  applicable_resource_ids: number[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TurfCouponPublic {
  id: number;
  organization_id: number;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: number;
  min_booking_amount: number;
  max_discount: number | null;
  usage_limit: number | null;
  used_count: number;
  per_user_limit: number;
  valid_from: string;
  valid_until: string;
  applicable_resource_ids: number[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TurfCouponCreateInput {
  code: string;
  description?: string | null;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  min_booking_amount?: number;
  max_discount?: number | null;
  usage_limit?: number | null;
  per_user_limit?: number;
  valid_until: string;
  applicable_resource_ids?: number[];
}

export interface TurfCouponUsageRow {
  id: number;
  coupon_id: number;
  booking_id: number;
  user_id: number;
  discount_amount: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TurfSettlementRow {
  id: number;
  organization_id: number;
  gross_amount: string;
  commission_amount: string;
  tax_amount: string;
  net_amount: string;
  status: string;
  gateway_payout_id: string | null;
  scheduled_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

export interface TurfSettlementPublic {
  id: number;
  organization_id: number;
  gross_amount: number;
  commission_amount: number;
  tax_amount: number;
  net_amount: number;
  status: string;
  gateway_payout_id: string | null;
  scheduled_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurfSettlementItemRow {
  id: number;
  settlement_id: number;
  booking_id: number;
  gross_amount: string;
  commission_amount: string;
  tax_amount: string;
  net_amount: string;
  created_at: string;
}

export interface TurfRefundRow {
  id: number;
  settlement_item_id: number | null;
  booking_id: number;
  amount: string;
  currency: string;
  reason: string | null;
  refund_type: string;
  status: string;
  gateway_refund_id: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurfRefundPublic {
  id: number;
  booking_id: number;
  amount: number;
  currency: string;
  reason: string | null;
  refund_type: string;
  status: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurfWalletTransactionRow {
  id: number;
  user_id: number;
  organization_id: number;
  coins: number;
  balance_after: number;
  type: string;
  category: string | null;
  booking_id: number | null;
  description: string | null;
  actor_type: string | null;
  actor_id: number | null;
  created_at: string;
}

export interface TurfWalletTransactionPublic {
  id: number;
  user_id: number;
  organization_id: number;
  coins: number;
  balance_after: number;
  type: string;
  category: string | null;
  booking_id: number | null;
  description: string | null;
  created_at: string;
}

export interface TurfReviewRow {
  id: number;
  venue_id: number;
  user_id: number;
  booking_id: number;
  rating: number;
  review: string | null;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TurfReviewPublic {
  id: number;
  venue_id: number;
  user_id: number;
  booking_id: number;
  rating: number;
  review: string | null;
  is_verified: boolean;
  created_at: string;
}

export interface TurfBookingAuditRow {
  id: number;
  booking_id: number;
  ticket_id: number | null;
  actor_type: string;
  actor_id: number | null;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TurfSearchCacheRow {
  id: number;
  cache_key: string;
  payload: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

// ── Customer-facing availability ──────────────────────────────────────────────

export interface CustomerSlotAvailability {
  unit_id: number;
  starts_at: string;
  ends_at: string;
  status: 'available' | 'held' | 'booked' | 'blocked' | 'unavailable';
  price: number | null;
  currency: string;
  formatted_time: string;
  duration_minutes: number;
  blocked_reason: string | null;
}

export interface ResourceAvailabilityResponse {
  resource_id: number;
  resource_name: string;
  venue_id: number;
  venue_name: string;
  date: string;
  timezone: string;
  slots: CustomerSlotAvailability[];
  summary: {
    available: number;
    held: number;
    booked: number;
    blocked: number;
    unavailable: number;
  };
}

export interface CustomerAvailabilityQuery {
  resourceId: number;
  date: string;
}

// ── Financial Configuration ───────────────────────────────────────────────────

export type FinancialConfigType = 'gst' | 'platform_fee' | 'commission' | 'tds' | 'cancellation_fee' | 'payout_minimum';
export type FinancialConfigScope = 'global' | 'organization';

export interface FinancialConfigRow {
  id: number;
  config_type: FinancialConfigType;
  scope: FinancialConfigScope;
  organization_id: number | null;
  value_bps: number;
  value_paise: number | null;
  applies_to: string;
  effective_date: string;
  expires_at: string | null;
  is_active: boolean;
  created_by_admin_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinancialConfigPublic {
  id: number;
  config_type: FinancialConfigType;
  scope: FinancialConfigScope;
  organization_id: number | null;
  value_bps: number;
  value_paise: number | null;
  applies_to: string;
  effective_date: string;
  expires_at: string | null;
  is_active: boolean;
  created_by_admin_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinancialConfigCreateInput {
  config_type: FinancialConfigType;
  scope?: FinancialConfigScope;
  organization_id?: number | null;
  value_bps: number;
  value_paise?: number | null;
  applies_to?: string;
  effective_date?: string;
  expires_at?: string | null;
  notes?: string | null;
}

// ── Financial Ledger ──────────────────────────────────────────────────────────

export type LedgerEntryType =
  | 'payment_received' | 'refund_issued' | 'platform_fee' | 'gst_collected'
  | 'gst_refunded' | 'commission_earned' | 'commission_reversed'
  | 'settlement_paid' | 'cancellation_fee' | 'coupon_discount'
  | 'ad_revenue' | 'sponsorship_revenue' | 'platform_fee_refunded' | 'adjustment';

export type LedgerDirection = 'debit' | 'credit';
export type LedgerReferenceType = 'booking' | 'refund' | 'settlement' | 'coupon'
  | 'advertisement' | 'sponsorship' | 'payment_order' | 'adjustment' | 'cancellation'
  | 'promotion_campaign';

export interface FinancialLedgerEntryRow {
  id: number;
  organization_id: number | null;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount_paise: number;
  currency: string;
  reference_type: LedgerReferenceType;
  reference_id: number;
  idempotency_key: string;
  config_snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  is_reversed: boolean;
  reversed_by_id: number | null;
  reversal_reason: string | null;
  posted_at: string;
  created_at: string;
}

export interface FinancialLedgerEntryPublic {
  id: number;
  organization_id: number | null;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount_paise: number;
  currency: string;
  reference_type: LedgerReferenceType;
  reference_id: number;
  idempotency_key: string;
  config_snapshot: Record<string, unknown>;
  is_reversed: boolean;
  reversal_reason: string | null;
  posted_at: string;
  created_at: string;
}

// ── Financial Adjustments ─────────────────────────────────────────────────────

export type AdjustmentType = 'settlement_correction' | 'fee_waiver' | 'penalty' | 'bonus' | 'other';

export interface FinancialAdjustmentRow {
  id: number;
  admin_id: number;
  organization_id: number | null;
  adjustment_type: AdjustmentType;
  amount_paise: number;
  currency: string;
  reference_type: string | null;
  reference_id: number | null;
  reason: string;
  approved_by_admin_id: number | null;
  approved_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ── Financial Calculation DTOs ────────────────────────────────────────────────

export interface BookingFinancialBreakdown {
  gross_amount_paise: number;
  currency: string;
  platform_fee_paise: number;
  gst_on_platform_fee_paise: number;
  commission_paise: number;
  tds_paise: number;
  cancellation_fee_paise: number;
  coupon_discount_paise: number;
  net_payable_to_business_paise: number;
  total_customer_charged_paise: number;
  config_snapshot: Record<string, unknown>;
}

export interface RefundFinancialBreakdown {
  refund_amount_paise: number;
  platform_fee_refund_paise: number;
  gst_refund_paise: number;
  commission_reversal_paise: number;
  business_debit_paise: number;
  config_snapshot: Record<string, unknown>;
}

export interface SettlementCalculation {
  booking_id: number;
  gross_amount_paise: number;
  platform_fee_paise: number;
  gst_paise: number;
  commission_paise: number;
  tds_paise: number;
  net_settlement_paise: number;
  config_snapshot: Record<string, unknown>;
}

// ── Report DTOs ───────────────────────────────────────────────────────────────

export interface FinancialReportSummary {
  organization_id: number | null;
  report_date: string;
  total_bookings: number;
  total_gross_amount_paise: number;
  total_gst_paise: number;
  total_platform_fee_paise: number;
  total_commission_paise: number;
  total_tds_paise: number;
  total_coupon_discount_paise: number;
  total_cancellation_fee_paise: number;
  total_refunded_paise: number;
  total_net_payable_paise: number;
  total_settled_paise: number;
  total_pending_paise: number;
  total_ad_revenue_paise: number;
  total_sponsorship_revenue_paise: number;
  total_adjustments_paise: number;
}

export interface LedgerBalance {
  entry_type: LedgerEntryType;
  total_debit_paise: number;
  total_credit_paise: number;
  net_paise: number;
}

// ============================================================================
// Phase 5 — Promotion & Advertisement Engine Types
// ===========================================================================

// ── Placement ────────────────────────────────────────────────────────────────

export type PromotionPlacement =
  | 'HOME_HERO'
  | 'CATEGORY_FEED'
  | 'SEARCH_FEED'
  | 'NEAR_YOU'
  | 'LISTING_CARD'
  | 'DETAIL_PAGE';

// ── Entity Types ─────────────────────────────────────────────────────────────

export type PromotionEntityType = 'turf_resource' | 'event' | 'venue' | 'organization';

// ── Campaign Status ──────────────────────────────────────────────────────────

export type PromotionCampaignStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'DEPLETED'
  | 'REJECTED'
  | 'REFUNDED';

// ── Promotion Packages ────────────────────────────────────────────────────────

export interface PromotionPackageRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  price_paise: number;
  currency: string;
  duration_days: number;
  max_impressions: number;
  priority_weight: number;
  eligible_categories: string[];
  eligible_entity_types: string[];
  eligible_placements: string[];
  metadata: Record<string, unknown>;
  is_active: boolean;
  is_featured: boolean;
  sort_order: number;
  created_by_admin_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PromotionPackagePublic {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  price_paise: number;
  currency: string;
  duration_days: number;
  max_impressions: number;
  priority_weight: number;
  eligible_categories: string[];
  eligible_entity_types: string[];
  eligible_placements: string[];
  is_active: boolean;
  is_featured: boolean;
  sort_order: number;
  created_at: string;
}

export interface PromotionPackageCreateInput {
  name: string;
  description?: string | null;
  price_paise: number;
  duration_days: number;
  max_impressions: number;
  priority_weight?: number;
  eligible_categories: string[];
  eligible_entity_types?: string[];
  eligible_placements: string[];
  is_active?: boolean;
  is_featured?: boolean;
  sort_order?: number;
  metadata?: Record<string, unknown>;
}

export interface PromotionPackageUpdateInput {
  name?: string;
  description?: string | null;
  price_paise?: number;
  duration_days?: number;
  max_impressions?: number;
  priority_weight?: number;
  eligible_categories?: string[];
  eligible_entity_types?: string[];
  eligible_placements?: string[];
  is_active?: boolean;
  is_featured?: boolean;
  sort_order?: number;
  metadata?: Record<string, unknown>;
}

// ── Promotion Campaigns ───────────────────────────────────────────────────────

export interface PromotionCampaignRow {
  id: number;
  organization_id: number;
  package_id: number;
  entity_type: PromotionEntityType;
  entity_id: number;
  entity_name: string;
  entity_image_url: string | null;
  entity_location: string | null;
  status: PromotionCampaignStatus;
  start_at: string;
  end_at: string;
  max_impressions: number;
  impressions_delivered: number;
  clicks: number;
  priority_weight: number;
  config_snapshot: Record<string, unknown>;
  payment_order_id: string | null;
  total_spend_paise: number;
  created_by_organizer_id: number | null;
  approved_by_admin_id: number | null;
  approved_at: string | null;
  rejection_reason: string | null;
  cancelled_at: string | null;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PromotionCampaignPublic {
  id: number;
  organization_id: number;
  package_id: number;
  package_name: string;
  entity_type: PromotionEntityType;
  entity_id: number;
  entity_name: string;
  entity_image_url: string | null;
  entity_location: string | null;
  status: PromotionCampaignStatus;
  start_at: string;
  end_at: string;
  max_impressions: number;
  impressions_delivered: number;
  clicks: number;
  priority_weight: number;
  config_snapshot: Record<string, unknown>;
  total_spend_paise: number;
  created_at: string;
  updated_at: string;
}

export interface PromotionCampaignCreateInput {
  organization_id: number;
  package_id: number;
  entity_type: PromotionEntityType;
  entity_id: number;
  entity_name: string;
  entity_image_url?: string | null;
  entity_location?: string | null;
  start_at: string;
  end_at: string;
  max_impressions: number;
  priority_weight?: number;
  created_by_organizer_id?: number;
}

export interface PromotionCampaignUpdateInput {
  status?: PromotionCampaignStatus;
  start_at?: string;
  end_at?: string;
  priority_weight?: number;
  paused_reason?: string | null;
  rejection_reason?: string | null;
  payment_order_id?: string | null;
}

// ── Promoted Entity (for listing injection) ──────────────────────────────────

export interface PromotedEntity {
  campaign_id: number;
  entity_type: PromotionEntityType;
  entity_id: number;
  entity_name: string;
  entity_image_url: string | null;
  entity_location: string | null;
  placement: PromotionPlacement;
  position: number;
  ranking_score: number;
  priority_weight: number;
  sponsored: true;
}

// ── Impressions ──────────────────────────────────────────────────────────────

export interface PromotionImpressionRow {
  id: number;
  campaign_id: number;
  placement: PromotionPlacement;
  position: number;
  ranking_score: number;
  user_session_id: string | null;
  request_id: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  device_type: string | null;
  location_context: Record<string, unknown>;
  is_unique: boolean;
  delivered_at: string;
}

export interface PromotionImpressionInput {
  campaign_id: number;
  placement: PromotionPlacement;
  position: number;
  ranking_score: number;
  user_session_id?: string | null;
  request_id?: string | null;
  ip_hash?: string | null;
  user_agent?: string | null;
  device_type?: string;
  location_context?: Record<string, unknown>;
}

// ── Clicks ───────────────────────────────────────────────────────────────────

export interface PromotionClickRow {
  id: number;
  campaign_id: number;
  impression_id: number | null;
  user_session_id: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  device_type: string | null;
  clicked_at: string;
}

// ── Attributions ─────────────────────────────────────────────────────────────

export interface PromotionAttributionCreateInput {
  campaign_id: number;
  booking_id: number;
  attribution_type: 'click' | 'view';
  attribution_window_hours: number;
  interaction_at: string;
  booking_amount_paise: number;
  metadata?: Record<string, unknown>;
}

export interface PromotionAttributionRow {
  id: number;
  campaign_id: number;
  booking_id: number;
  attribution_type: 'click' | 'view';
  attribution_window_hours: number;
  interaction_at: string;
  attributed_at: string;
  booking_amount_paise: number;
  metadata: Record<string, unknown>;
}

// ── Inventory Slots ──────────────────────────────────────────────────────────

export interface AdInventorySlotRow {
  id: number;
  location_key: string;
  category: string;
  placement: PromotionPlacement;
  max_slots: number;
  is_active: boolean;
  created_by_admin_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AdInventorySlotPublic {
  id: number;
  location_key: string;
  category: string;
  placement: PromotionPlacement;
  max_slots: number;
  is_active: boolean;
  created_at: string;
}

export interface AdInventorySlotCreateInput {
  location_key: string;
  category: string;
  placement: PromotionPlacement;
  max_slots: number;
  is_active?: boolean;
}

export interface AdInventorySlotUpdateInput {
  max_slots?: number;
  is_active?: boolean;
}

// ── Rank Weights ─────────────────────────────────────────────────────────────

export interface PromotionRankWeightsRow {
  id: number;
  w1_priority: number;
  w2_relevance: number;
  w3_deficit: number;
  updated_by_admin_id: number | null;
  updated_at: string;
}

// ── Daily Aggregates ─────────────────────────────────────────────────────────

export interface PromotionCampaignDailyRow {
  id: number;
  campaign_id: number;
  date: string;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  unique_clicks: number;
  attributed_bookings: number;
  attributed_revenue_paise: number;
  spend_paise: number;
  created_at: string;
  updated_at: string;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface PromotionCampaignAnalytics {
  campaign_id: number;
  campaign_name: string;
  status: PromotionCampaignStatus;
  start_at: string;
  end_at: string;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  unique_clicks: number;
  ctr: number;
  attributed_bookings: number;
  attributed_revenue_paise: number;
  conversion_rate: number;
  spend_paise: number;
  roi: number;
  remaining_impressions: number;
  delivery_rate: number;
  max_impressions: number;
  impressions_delivered: number;
}

export interface PromotionAnalyticsByPlacement {
  placement: PromotionPlacement;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  ctr: number;
}

export interface PromotionAnalyticsByCategory {
  category: string;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  attributed_bookings: number;
}

export interface PromotionAnalyticsByLocation {
  location_key: string;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  attributed_bookings: number;
}

export interface PromotionDailyPerformance {
  date: string;
  impressions: number;
  unique_impressions: number;
  clicks: number;
  attributed_bookings: number;
  attributed_revenue_paise: number;
  spend_paise: number;
}

export interface PromotionPlatformAnalytics {
  total_campaigns: number;
  active_campaigns: number;
  total_impressions: number;
  total_clicks: number;
  total_attributed_bookings: number;
  total_attributed_revenue_paise: number;
  total_spend_paise: number;
  avg_ctr: number;
  avg_conversion_rate: number;
  avg_roi: number;
  by_placement: PromotionAnalyticsByPlacement[];
  by_category: PromotionAnalyticsByCategory[];
  by_location: PromotionAnalyticsByLocation[];
  daily: PromotionDailyPerformance[];
}

// ── Ranking ──────────────────────────────────────────────────────────────────

export interface RankedCampaign {
  campaign_id: number;
  entity_type: PromotionEntityType;
  entity_id: number;
  entity_name: string;
  entity_image_url: string | null;
  entity_location: string | null;
  placement: PromotionPlacement;
  position: number;
  ranking_score: number;
  priority_weight: number;
  impressions_delivered: number;
  max_impressions: number;
  relevance_score: number;
  impression_deficit: number;
  bid_weight: number;
}

export interface RankingContext {
  placement: PromotionPlacement;
  category?: string;
  location_key?: string;
  entity_type?: PromotionEntityType;
  limit: number;
}

export interface RankWeights {
  w1_priority: number;
  w2_relevance: number;
  w3_deficit: number;
}

// ── Permissions ──────────────────────────────────────────────────────────────

export type PromotionPermission =
  | 'promotion_packages:create'
  | 'promotion_packages:read'
  | 'promotion_packages:update'
  | 'promotion_packages:delete'
  | 'promotion_packages:activate'
  | 'promotion_campaigns:read'
  | 'promotion_campaigns:approve'
  | 'promotion_campaigns:cancel'
  | 'promotion_campaigns:refund'
  | 'promotion_campaigns:adjust'
  | 'promotion_analytics:read'
  | 'ad_inventory:manage'
  | 'ranking:configure';

// ── Organizer Permission Sets ────────────────────────────────────────────────

export const ORGANIZER_PROMOTION_PERMISSIONS: readonly string[] = [
  'promotion_campaigns:read',
  'promotion_campaigns:create',
  'promotion_campaigns:update',
  'promotion_campaigns:cancel',
  'promotion_analytics:read',
] as const;
