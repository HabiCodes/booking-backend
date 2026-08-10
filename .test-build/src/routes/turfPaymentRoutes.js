"use strict";
/**
 * Turf payment routes — uses main backend's Cashfree infrastructure.
 * Mounted at /api/v1/turf/payments
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfPaymentRoutes = void 0;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const errorHandler_1 = require("../middleware/errorHandler");
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const paymentService_1 = require("../services/paymentService");
const turfBookingService_1 = require("../services/turfBookingService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
exports.turfPaymentRoutes = router;
// Lazily create the payment service to avoid circular deps
let paymentService = null;
function getPaymentService() {
    if (!paymentService) {
        paymentService = (0, paymentService_1.createPaymentService)({
            appId: config_1.config.cashfree.appId,
            secretKey: config_1.config.cashfree.secretKey,
            webhookSecret: config_1.config.cashfree.webhookSecret,
            returnUrl: config_1.config.cashfree.returnUrl,
            notifyUrl: config_1.config.cashfree.notifyUrl,
        });
    }
    return paymentService;
}
/**
 * POST /api/v1/turf/payments/create-order
 * Creates a Cashfree payment order for a Turf booking.
 */
router.post('/create-order', auth_1.authMiddleware, async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const { bookingId } = req.body;
        if (!bookingId)
            throw new errorHandler_1.AppError('bookingId is required', 400);
        const booking = await turfBookingRepository_1.turfBookingRepository.findById(bookingId);
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        if (booking.user_id !== userId)
            throw new errorHandler_1.AppError('Not your booking', 403);
        if (booking.status !== 'pending_payment') {
            throw new errorHandler_1.AppError('Booking is not in pending_payment state', 409);
        }
        // Get customer details
        const userResult = await (require('../db/pool').getPool()).query('SELECT email, username, phone FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        // Create payment order via main Cashfree service
        const orderId = `turf_${booking.booking_reference}`;
        const result = await getPaymentService().createOrder({
            booking_id: booking.id,
            order_id: orderId,
            orderId: orderId,
            organization_id: booking.organization_id,
            event_id: null,
            amount: parseFloat(booking.amount),
            currency: booking.currency || 'INR',
            idempotency_key: `turf_pay_${booking.id}`,
            customerEmail: user?.email || '',
            customerPhone: user?.phone || '',
            customerName: user?.username || user?.email || `User ${userId}`,
            metadata: { source: 'turf' },
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
/**
 * POST /api/v1/turf/payments/verify
 * Verifies payment and confirms the booking.
 */
router.post('/verify', auth_1.authMiddleware, async (req, res, next) => {
    try {
        const { bookingId, gatewayOrderId, gatewayPaymentId } = req.body;
        if (!bookingId || !gatewayOrderId || !gatewayPaymentId) {
            throw new errorHandler_1.AppError('bookingId, gatewayOrderId, gatewayPaymentId required', 400);
        }
        const booking = await turfBookingRepository_1.turfBookingRepository.findById(bookingId);
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        if (booking.status !== 'pending_payment') {
            throw new errorHandler_1.AppError('Booking is not in pending_payment state', 409);
        }
        // Verify with Cashfree
        const { CashfreePaymentGateway } = await Promise.resolve().then(() => __importStar(require('../services/cashfreeService')));
        const gateway = new CashfreePaymentGateway({
            appId: config_1.config.cashfree.appId,
            secretKey: config_1.config.cashfree.secretKey,
            webhookSecret: config_1.config.cashfree.webhookSecret,
            returnUrl: config_1.config.cashfree.returnUrl,
            notifyUrl: config_1.config.cashfree.notifyUrl,
        });
        const verifyResult = await gateway.verifyPayment(gatewayOrderId, {
            cf_payment_id: gatewayPaymentId,
            order_id: gatewayOrderId,
        });
        if (verifyResult.success) {
            // Confirm the booking (this also generates QR, creates settlement, awards coins)
            const confirmed = await turfBookingService_1.turfBookingService.confirmBooking(bookingId, {
                actorId: req.user?.id || 0,
                actorType: 'customer',
            });
            res.json({ success: true, data: { status: 'confirmed', booking: confirmed } });
        }
        else {
            // Payment failed — cancel booking and release slot
            await turfBookingService_1.turfBookingService.cancelBooking(bookingId, booking.user_id, 'Payment failed', {
                actorId: req.user?.id || 0,
                actorType: 'customer',
            });
            res.json({ success: true, data: { status: 'cancelled', reason: verifyResult.errorMessage } });
        }
    }
    catch (err) {
        next(err);
    }
});
