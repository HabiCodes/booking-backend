/**
 * MoviePriceCapService — business logic for configurable price caps.
 * Used to enforce regulatory limits (e.g., Tamil Nadu govt price controls).
 */

import { moviePriceCapRepository } from '../repositories/moviePriceCapRepository';
import type {
  MoviePriceCapRow, MoviePriceCapPublic, MoviePriceCapCreateInput,
} from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class MoviePriceCapService {

  async findByOrganization(organizationId: number, query?: { page?: number; pageSize?: number }): Promise<PaginatedResult<MoviePriceCapPublic>> {
    return moviePriceCapRepository.findByOrganization(organizationId, query);
  }

  async findAll(query?: { page?: number; pageSize?: number }): Promise<PaginatedResult<MoviePriceCapPublic>> {
    return moviePriceCapRepository.findAll(query);
  }

  async create(input: Partial<MoviePriceCapCreateInput> & { organization_id?: number }): Promise<MoviePriceCapRow> {
    return moviePriceCapRepository.create(input as MoviePriceCapCreateInput & { organization_id?: number });
  }

  async update(id: number, input: Partial<MoviePriceCapCreateInput>): Promise<MoviePriceCapRow | null> {
    return moviePriceCapRepository.update(id, input);
  }

  async softDelete(id: number): Promise<void> {
    return moviePriceCapRepository.softDelete(id);
  }
}

export const moviePriceCapService = new MoviePriceCapService();