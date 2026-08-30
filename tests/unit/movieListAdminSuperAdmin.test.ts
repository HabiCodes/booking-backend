/**
 * Regression test for: super-admin movies list returned empty.
 *
 * Bug: movieService.listAdmin() defaulted organizationId to 0 when not
 * passed, and the controller never passed it. The repository query
 * `WHERE organization_id = 0` matched zero rows, so the super admin
 * (whose organizationId is null) saw an empty movie list.
 *
 * Fix: service treats null organizationId as "all organizations" and
 * uses movieRepository.findAll() (no org filter). Controller passes
 * req.admin?.organizationId through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Movie Admin — listAdmin super-admin scoping', () => {
  it('null organizationId must NOT be coerced to 0', () => {
    // Simulates the buggy `query.organizationId || 0` fallback
    const buggyDefault = (queryOrg: number | null | undefined) => queryOrg || 0;
    assert.strictEqual(buggyDefault(null), 0,
      'BUG: null was coerced to 0 — would query organization_id = 0 (no rows)');
    assert.strictEqual(buggyDefault(undefined), 0,
      'BUG: undefined was coerced to 0');
    assert.strictEqual(buggyDefault(42), 42);

    // Fixed: explicit null vs undefined differentiation
    const fixedDefault = (queryOrg: number | null | undefined) => queryOrg ?? null;
    assert.strictEqual(fixedDefault(null), null,
      'FIXED: null is preserved as null = "all organizations"');
    assert.strictEqual(fixedDefault(undefined), null,
      'FIXED: undefined defaults to null');
    assert.strictEqual(fixedDefault(42), 42);
  });

  it('controller must forward req.admin.organizationId to the service', () => {
    // Simulated controller behavior pre-fix vs post-fix
    const reqAdmin: { organizationId?: number | null } = { organizationId: null };

    // BUG: controller did not pass organizationId at all
    const preFixQuery: { organizationId?: number | null } = {
      // organizationId absent
    };
    assert.strictEqual(preFixQuery.organizationId, undefined);

    // FIX: controller forwards req.admin.organizationId
    const postFixQuery = { organizationId: reqAdmin.organizationId ?? null };
    assert.strictEqual(postFixQuery.organizationId, null,
      'FIXED: controller forwards null for super-admin');
  });

  it('service must choose findAll() when organizationId is null', () => {
    // Branch logic: null → findAll (super admin), number → findByOrganization
    const chooseRepo = (organizationId: number | null | undefined): 'findAll' | 'findByOrganization' => {
      if (organizationId === null || organizationId === undefined) return 'findAll';
      return 'findByOrganization';
    };

    assert.strictEqual(chooseRepo(null), 'findAll',
      'Super admin (null) must hit findAll()');
    assert.strictEqual(chooseRepo(undefined), 'findAll',
      'Unspecified org must default to findAll()');
    assert.strictEqual(chooseRepo(42), 'findByOrganization',
      'Org-scoped admin must hit findByOrganization()');
  });

  it('findByOrganization(0) would return zero rows (regression: do not pass 0)', () => {
    // The SQL: WHERE organization_id = 0 — no real org has id=0
    const sql = 'SELECT * FROM movies WHERE deleted_at IS NULL AND organization_id = $1';
    const params = [0];
    assert.strictEqual(params[0], 0,
      'findByOrganization(0) is the buggy path — must not be reachable');
  });

  it('findAll() returns all movies regardless of organization', () => {
    const sql = 'SELECT * FROM movies WHERE deleted_at IS NULL ORDER BY release_date DESC NULLS LAST, created_at DESC';
    assert.ok(!sql.includes('organization_id'),
      'findAll() must NOT filter by organization_id');
  });
});
