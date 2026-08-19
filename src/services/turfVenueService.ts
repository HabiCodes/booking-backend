/**
 * Turf venue service — manages sports turf/ground venues.
 */

import { turfVenueRepository } from '../repositories/turfVenueRepository';
import { turfResourceRepository } from '../repositories/turfResourceRepository';
import { turfResourceRepository as repo } from '../repositories/turfResourceRepository';
import { AppError } from '../middleware/errorHandler';
import type { TurfResourceCreateInput } from '../types';

export class TurfVenueService {
  async create(organizationId: number, input: { name: string; description?: string | null; address?: string | null; city?: string | null; state?: string | null; country?: string | null; latitude?: number | null; longitude?: number | null; amenities?: string[] }) {
    return turfVenueRepository.create({ ...input, organization_id: organizationId });
  }

  async listByOrganization(organizationId: number) {
    return turfVenueRepository.findByOrganization(organizationId);
  }

  async findPublic(query: { category?: string; city?: string; page?: number; pageSize?: number }) {
    return turfResourceRepository.findPublic(query);
  }

  private async assertOrgAccess(venueId: number, organizationId: number | undefined): Promise<void> {
    if (organizationId === undefined) return; // admin/public — skip org check
    const venue = await turfVenueRepository.findById(venueId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
  }

  async getById(id: number, organizationId?: number) {
    if (organizationId !== undefined) {
      const venue = await turfVenueRepository.findById(id);
      if (!venue) throw new AppError('Venue not found', 404);
      if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
      return venue;
    }
    const venue = await turfVenueRepository.findById(id);
    if (!venue) throw new AppError('Venue not found', 404);
    return venue;
  }

  async update(id: number, organizationId?: number, input: Record<string, unknown> = {}) {
    if (organizationId !== undefined) {
      const venue = await turfVenueRepository.findById(id);
      if (!venue) throw new AppError('Venue not found', 404);
      if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    } else {
      const venue = await turfVenueRepository.findById(id);
      if (!venue) throw new AppError('Venue not found', 404);
    }
    return turfVenueRepository.update(id, input);
  }

  async softDelete(id: number, organizationId?: number) {
    if (organizationId !== undefined) {
      const venue = await turfVenueRepository.findById(id);
      if (!venue) throw new AppError('Venue not found', 404);
      if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    } else {
      const venue = await turfVenueRepository.findById(id);
      if (!venue) throw new AppError('Venue not found', 404);
    }
    turfVenueRepository.softDelete(id);
  }

  async createResource(venueId: number, organizationId: number, input: TurfResourceCreateInput) {
    const venue = await turfVenueRepository.findById(venueId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    return turfResourceRepository.create(input);
  }

  async listResources(venueId: number, organizationId: number, query?: { resourceType?: string; category?: string }) {
    const venue = await turfVenueRepository.findById(venueId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    return turfResourceRepository.findAll({ venueId, ...query });
  }

  async getResource(id: number, organizationId: number) {
    const resource = await turfResourceRepository.findById(id);
    if (!resource) throw new AppError('Resource not found', 404);
    if (organizationId !== undefined) {
      const venue = await turfVenueRepository.findById(resource.venue_id);
      if (!venue || venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    }
    return resource;
  }

  async updateResource(id: number, organizationId?: number, input: Record<string, unknown> = {}) {
    const resource = await turfResourceRepository.findById(id);
    if (!resource) throw new AppError('Resource not found', 404);
    if (organizationId !== undefined) {
      const venue = await turfVenueRepository.findById(resource.venue_id);
      if (!venue || venue.organization_id !== organizationId) throw new AppError('Access denied', 403);
    }
    return turfResourceRepository.update(id, input);
  }
}

export const turfVenueService = new TurfVenueService();
