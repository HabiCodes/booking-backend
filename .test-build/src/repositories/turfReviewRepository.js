"use strict";
/**
 * Turf review repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfReviewRepository = exports.TurfReviewRepository = void 0;
const pool_1 = require("../db/pool");
class TurfReviewRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_reviews WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByVenue(venueId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_reviews WHERE venue_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [venueId]);
        return rows;
    }
    async getRatingSummary(venueId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total_reviews, COALESCE(AVG(rating)::numeric(3,2), 0) as average_rating FROM turf_reviews WHERE venue_id = $1 AND deleted_at IS NULL`, [venueId]);
        const r = rows[0];
        return { total_reviews: Number(r.total_reviews), average_rating: parseFloat(r.average_rating) };
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query('INSERT INTO turf_reviews (venue_id, user_id, booking_id, rating, review, is_verified) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *', [input.venue_id, input.user_id, input.booking_id, input.rating, input.review ?? null]);
        return rows[0];
    }
}
exports.TurfReviewRepository = TurfReviewRepository;
exports.turfReviewRepository = new TurfReviewRepository();
