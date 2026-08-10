"use strict";
/**
 * Turf organizer controller — organization-level turf management.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrgBookings = listOrgBookings;
exports.listOrgVenues = listOrgVenues;
exports.createOrgVenue = createOrgVenue;
exports.listCoupons = listCoupons;
exports.createCoupon = createCoupon;
exports.listSettlements = listSettlements;
const turfBookingRepository_1 = require("../../repositories/turfBookingRepository");
const turfVenueService_1 = require("../../services/turfVenueService");
const turfCouponService_1 = require("../../services/turfCouponService");
const turfSettlementService_1 = require("../../services/turfSettlementService");
async function listOrgBookings(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const result = await turfBookingRepository_1.turfBookingRepository.findByOrganization(orgId, req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function listOrgVenues(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const venues = await turfVenueService_1.turfVenueService.listByOrganization(orgId);
        res.json({ success: true, data: venues });
    }
    catch (err) {
        next(err);
    }
}
async function createOrgVenue(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const venue = await turfVenueService_1.turfVenueService.create(orgId, req.body);
        res.status(201).json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
}
async function listCoupons(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const coupons = await turfCouponService_1.turfCouponService.listByOrganization(orgId);
        res.json({ success: true, data: coupons });
    }
    catch (err) {
        next(err);
    }
}
async function createCoupon(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const coupon = await turfCouponService_1.turfCouponService.create(orgId, req.body);
        res.status(201).json({ success: true, data: coupon });
    }
    catch (err) {
        next(err);
    }
}
async function listSettlements(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const result = await turfSettlementService_1.turfSettlementService.listByOrganization(orgId, req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
