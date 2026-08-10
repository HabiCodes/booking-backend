"use strict";
/**
 * Turf venue service — manages sports turf/ground venues.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfVenueService = exports.TurfVenueService = void 0;
const turfVenueRepository_1 = require("../repositories/turfVenueRepository");
const turfResourceRepository_1 = require("../repositories/turfResourceRepository");
const errorHandler_1 = require("../middleware/errorHandler");
class TurfVenueService {
    async create(organizationId, input) {
        return turfVenueRepository_1.turfVenueRepository.create({ ...input, organization_id: organizationId });
    }
    async listByOrganization(organizationId) {
        return turfVenueRepository_1.turfVenueRepository.findByOrganization(organizationId);
    }
    async findPublic(query) {
        return turfResourceRepository_1.turfResourceRepository.findPublic(query);
    }
    async getById(id) {
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(id);
        if (!venue)
            throw new errorHandler_1.AppError('Venue not found', 404);
        return venue;
    }
    async update(id, input) {
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(id);
        if (!venue)
            throw new errorHandler_1.AppError('Venue not found', 404);
        return turfVenueRepository_1.turfVenueRepository.update(id, input);
    }
    async softDelete(id) {
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(id);
        if (!venue)
            throw new errorHandler_1.AppError('Venue not found', 404);
        turfVenueRepository_1.turfVenueRepository.softDelete(id);
    }
    async createResource(venueId, input) {
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(venueId);
        if (!venue)
            throw new errorHandler_1.AppError('Venue not found', 404);
        return turfResourceRepository_1.turfResourceRepository.create(input);
    }
    async listResources(venueId, query) {
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(venueId);
        if (!venue)
            throw new errorHandler_1.AppError('Venue not found', 404);
        return turfResourceRepository_1.turfResourceRepository.findAll({ venueId, ...query });
    }
    async getResource(id) {
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(id);
        if (!resource)
            throw new errorHandler_1.AppError('Resource not found', 404);
        return resource;
    }
    async updateResource(id, input) {
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(id);
        if (!resource)
            throw new errorHandler_1.AppError('Resource not found', 404);
        return turfResourceRepository_1.turfResourceRepository.update(id, input);
    }
}
exports.TurfVenueService = TurfVenueService;
exports.turfVenueService = new TurfVenueService();
