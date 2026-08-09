"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOwnOrganization = getOwnOrganization;
exports.getOrganization = getOrganization;
exports.updateOrganization = updateOrganization;
exports.updateBanking = updateBanking;
exports.deactivateOrganization = deactivateOrganization;
exports.reactivateOrganization = reactivateOrganization;
const organizerOrganizationService_1 = require("../services/organizerOrganizationService");
async function getOwnOrganization(req, res, next) {
    try {
        const org = await organizerOrganizationService_1.organizerOrganizationService.getOwnOrganization(req.organizerUser.id);
        res.json({ success: true, data: org });
    }
    catch (err) {
        next(err);
    }
}
async function getOrganization(req, res, next) {
    try {
        const org = await organizerOrganizationService_1.organizerOrganizationService.getById(Number(req.params.id), req.organizerUser.id);
        res.json({ success: true, data: org });
    }
    catch (err) {
        next(err);
    }
}
async function updateOrganization(req, res, next) {
    try {
        const org = await organizerOrganizationService_1.organizerOrganizationService.update(Number(req.params.id), req.body, req.organizerUser.id);
        res.json({ success: true, data: org });
    }
    catch (err) {
        next(err);
    }
}
async function updateBanking(req, res, next) {
    try {
        const org = await organizerOrganizationService_1.organizerOrganizationService.updateBanking(Number(req.params.id), req.body, req.organizerUser.id);
        res.json({ success: true, data: org });
    }
    catch (err) {
        next(err);
    }
}
async function deactivateOrganization(req, res, next) {
    try {
        await organizerOrganizationService_1.organizerOrganizationService.deactivate(Number(req.params.id), req.organizerUser.id);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
async function reactivateOrganization(req, res, next) {
    try {
        await organizerOrganizationService_1.organizerOrganizationService.reactivate(Number(req.params.id), req.organizerUser.id);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
