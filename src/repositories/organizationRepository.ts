/**
 * Organization repository — tenant CRUD.
 */

import { getPool } from '../db/pool';
import type { OrganizationRow, OrganizationPublic, OrganizationUpdateInput, OrganizationBankUpdateInput } from '../types';

export class OrganizationRepository {
  async findById(id: number): Promise<OrganizationRow | null> {
    const { rows } = await getPool().query('SELECT * FROM organizations WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as OrganizationRow[])[0] || null;
  }

  async findBySlug(slug: string): Promise<OrganizationRow | null> {
    const { rows } = await getPool().query('SELECT * FROM organizations WHERE slug = $1 LIMIT 1', [slug]);
    return (rows as unknown as OrganizationRow[])[0] || null;
  }

  async findAll(query: { page?: number; pageSize?: number; search?: string; isActive?: boolean }): Promise<{ items: OrganizationPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (query.isActive !== undefined) { whereClauses.push(`is_active = $${idx++}`); params.push(query.isActive); }
    if (query.search) { params.push(`%${query.search}%`, `%${query.search}%`); whereClauses.push(`(name ILIKE $${idx++} OR display_name ILIKE $${idx - 1} OR email ILIKE $${idx - 1})`); }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) as total FROM organizations ${where}`, params);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, name, display_name, slug, email, phone, address, city, state, country, logo_url, description, is_active, created_at, updated_at FROM organizations ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as OrganizationPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: Record<string, unknown>): Promise<OrganizationRow> {
    const { rows } = await getPool().query(
      `INSERT INTO organizations (name, display_name, slug, email, phone, address, city, state, country, logo_url, description, branding_metadata, bank_details, payout_details, application_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [input.name, input.display_name, input.slug, input.email ?? null, input.phone ?? null, input.address ?? null, input.city ?? null, input.state ?? null, input.country ?? 'India', input.logo_url ?? null, input.description ?? null, JSON.stringify(input.branding_metadata || {}), JSON.stringify(input.bank_details || {}), JSON.stringify(input.payout_details || {}), input.application_id ?? null]
    );
    return (rows as unknown as OrganizationRow[])[0];
  }

  async update(id: number, input: OrganizationUpdateInput): Promise<OrganizationRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    const map: Record<string, string> = { name: 'name', display_name: 'display_name', email: 'email', phone: 'phone', address: 'address', city: 'city', state: 'state', country: 'country', logo_url: 'logo_url', description: 'description', branding_metadata: 'branding_metadata' };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && map[key]) { fields.push(`${map[key]} = $${idx++}`); params.push(key === 'branding_metadata' ? JSON.stringify(value) : value); }
    }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE organizations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as OrganizationRow[])[0] || null;
  }

  async updateBanking(id: number, input: OrganizationBankUpdateInput): Promise<OrganizationRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.account_holder_name !== undefined) { fields.push(`account_holder_name = $${idx++}`); params.push(input.account_holder_name); }
    if (input.bank_details !== undefined) { fields.push(`bank_details = $${idx++}`); params.push(JSON.stringify(input.bank_details)); }
    if (input.payout_details !== undefined) { fields.push(`payout_details = $${idx++}`); params.push(JSON.stringify(input.payout_details)); }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE organizations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as OrganizationRow[])[0] || null;
  }

  async deactivate(id: number): Promise<void> { await getPool().query('UPDATE organizations SET is_active = false WHERE id = $1', [id]); }
  async reactivate(id: number): Promise<void> { await getPool().query('UPDATE organizations SET is_active = true WHERE id = $1', [id]); }
}

export const organizationRepository = new OrganizationRepository();
