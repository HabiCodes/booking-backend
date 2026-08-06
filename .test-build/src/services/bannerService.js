"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bannerService = exports.BannerService = void 0;
const fileUploadRepository_1 = require("../repositories/fileUploadRepository");
const bannerRepository_1 = require("../repositories/bannerRepository");
class BannerService {
    /**
     * Create a new banner (uploaded file + DB record). Does NOT activate it.
     */
    async createBanner(input) {
        const banner = await bannerRepository_1.bannerRepository.createBanner(undefined, {
            imageUrl: input.imageUrl,
            cloudinaryPublicId: input.cloudinaryPublicId ?? null,
            width: input.width,
            height: input.height,
            fileSizeBytes: input.fileSizeBytes,
            mimeType: input.mimeType,
            placement: input.placement,
            uploadedBy: input.uploadedBy,
            altText: input.altText ?? null,
            linkUrl: input.linkUrl ?? null,
            priority: input.priority ?? 0,
        });
        // Best-effort ledger link
        await fileUploadRepository_1.fileUploadRepository.createFileUpload(undefined, {
            originalName: input.imageUrl.split('/').pop() ?? 'banner',
            storedName: input.imageUrl,
            mimeType: input.mimeType,
            sizeBytes: input.fileSizeBytes,
            width: input.width,
            height: input.height,
            entityType: 'banner',
            entityId: banner.id,
            uploadedBy: input.uploadedBy,
        }).catch(() => { });
        return { banner };
    }
    /**
     * Activate a banner. For ticket_advertisement this deactivates all other
     * active ticket_advertisement banners first.
     */
    async activateBanner(id) {
        const banner = await bannerRepository_1.bannerRepository.getBannerById(id);
        if (!banner)
            return null;
        if (banner.deleted_at !== null)
            return null;
        return bannerRepository_1.bannerRepository.activateBanner(id);
    }
    async deactivateBanner(id) {
        const banner = await bannerRepository_1.bannerRepository.getBannerById(id);
        if (!banner || banner.deleted_at !== null)
            return null;
        return bannerRepository_1.bannerRepository.deactivateBanner(id);
    }
    async softDeleteBanner(id) {
        const banner = await bannerRepository_1.bannerRepository.getBannerById(id);
        if (!banner)
            return false;
        return bannerRepository_1.bannerRepository.softDeleteBanner(id);
    }
    async updateBanner(id, input) {
        return bannerRepository_1.bannerRepository.updateBanner(id, input);
    }
    async getBanner(id) {
        return bannerRepository_1.bannerRepository.getBannerById(id);
    }
    async listBanners(options = {}) {
        return bannerRepository_1.bannerRepository.listBanners(options);
    }
    async getActiveTicketAd() {
        return bannerRepository_1.bannerRepository.getActiveBannerByPlacement('ticket_advertisement');
    }
}
exports.BannerService = BannerService;
exports.bannerService = new BannerService();
