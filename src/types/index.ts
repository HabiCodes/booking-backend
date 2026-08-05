export interface UserPublic {
  id: number;
  email: string;
  created_at: Date;
}

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: Date;
}

export interface EventRow {
  id: number;
  title: string;
  venue: string;
  banner_url: string | null;
  logo_url: string | null;
  start_at: Date;
  end_at: Date;
  capacity: number;
  description: string | null;
  created_at: Date;
}

export interface BookingRow {
  id: number;
  user_id: number;
  event_id: number;
  ticket_count: number;
  created_at: Date;
}

export interface BookingWithEventRow extends BookingRow {
  event_title: string;
  event_venue: string;
  event_start_at: Date;
}

export interface TicketRow {
  id: number;
  booking_id: number;
  ticket_uuid: string;
  attendee_name: string;
  attendee_phone: string;
  attendee_age: number | null;
  attendee_gender: string | null;
  checked_in: boolean;
  checked_in_at: Date | null;
  checked_in_by: number | null;
  created_at: Date;
}

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  created_at: Date;
}

export interface AttendeeInput {
  full_name: string;
  phone: string;
  age?: string | number | null;
  gender?: string | null;
}

export interface CreateBookingInput {
  event_id: number | string;
  attendees: AttendeeInput[];
}
