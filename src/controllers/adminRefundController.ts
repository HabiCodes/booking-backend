import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { AppError } from '../middleware/errorHandler';
import { refundRepository } from '../repositories/refundRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { logger } from '../utils/logger';
import { createPaymentService } from '../services/paymentService';
import { FederalBankPaymentProvider } from '../services/federalBankProvider';
import { config } from '../config';

// Local PaymentService lazy initialization
let paymentService: ReturnType<typeof createPaymentService> | null = null;
function getLocalPaymentService() {
  if (!paymentService) {
    const provider = new FederalBankPaymentProvider(config.paymentProvider);
    paymentService = createPaymentService(provider);
  }
  return paymentService;
}

/**
 * GET /api/v1/admin/refunds
 * List all refunds with optional filters.
 * Query params: status, organizationId, page, pageSize
 */
export async function adminListRefunds(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const page = parseInt((req.query.page as string) || '1', 10);
    const pageSize = parseInt((req.query.pageSize as string) || '20', 10);
    const status = req.query.status as string | undefined;
    const organizationId = req.query.organizationId
      ? parseInt(req.query.organizationId as string, 10)
      : undefined;

    const result = await refundRepository.listAll({
      page,
      pageSize,
      status: status as any,
      organizationId,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/refunds/:id
 * Get a single refund by ID.
 */
export async function adminGetRefund(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid refund ID', 400);

    const refund = await refundRepository.findById(id);
    if (!refund) throw new AppError('Refund not found', 404);
    res.json({ success: true, data: refund });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/admin/refunds
 * Create a refund for a payment order.
 * Body: { payment_order_id, amount, reason?, refund_type? }
 */
export async function adminCreateRefund(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const { payment_order_id, amount, reason, refund_type } = req.body || {};

    if (!payment_order_id || amount === undefined) {
      throw new AppError('payment_order_id and amount are required', 400);
    }

    const paymentOrderId = Number(payment_order_id);
    if (!Number.isFinite(paymentOrderId)) {
      throw new AppError('Invalid payment_order_id', 400);
    }

    const order = await paymentOrderRepository.findById(paymentOrderId);
    if (!order) throw new AppError('Payment order not found', 404);

    const result = await getLocalPaymentService().processRefund(
      {
        payment_order_id: paymentOrderId,
        booking_id: order.booking_id,
        amount: Number(amount),
        reason: reason as string | undefined,
        refund_type: refund_type as any,
      },
      { adminId: req.admin.id }
    );

    logger.info(`[AdminRefund] Refund created by admin ${req.admin.id}: ${result.id}`);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
