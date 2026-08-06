import { config } from '../config';
import { fileUploadRepository } from '../repositories/fileUploadRepository';
import { bannerRepository } from '../repositories/bannerRepository';
import type { BannerRow, UpdateBannerInput, BannerPlacement } from '../types';

interface CreateBannerResult {
  banner: BannerRow;
}

export class BannerService {
  /**
   * Create a new banner (uploaded file + DB record). Does NOT activate it.
   */
  async createBanner(input: {
    imageUrl: string;
    mimeType: string;
    fileSizeBytes: number;
    width: number | null;
    height: number | null;
    cloudinaryPublicId?: string | null;
    uploadedBy: number;
    placement: BannerPlacement;
    altText?: string | null;
    linkUrl?: string | null;
    priority?: number;
  }): Promise<CreateBannerResult> {
    const banner = await bannerRepository.createBanner(undefined, {
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
    await fileUploadRepository.createFileUpload(undefined, {
      originalName: input.imageUrl.split('/').pop() ?? 'banner',
      storedName: input.imageUrl,
      mimeType: input.mimeType,
      sizeBytes: input.fileSizeBytes,
      width: input.width,
      height: input.height,
      entityType: 'banner',
      entityId: banner.id,
      uploadedBy: input.uploadedBy,
    }).catch(() => {});

    return { banner };
  }

  /**
   * Activate a banner. For ticket_advertisement this deactivates all other
   * active ticket_advertisement banners first.
   */
  async activateBanner(id: number): Promise<BannerRow | null> {
    const banner = await bannerRepository.getBannerById(id);
    if (!banner) return null;
    if (banner.deleted_at !== null) return null;

    return bannerRepository.activateBanner(id);
  }

  async deactivateBanner(id: number): Promise<BannerRow | null> {
    const banner = await bannerRepository.getBannerById(id);
    if (!banner || banner.deleted_at !== null) return null;

    return bannerRepository.deactivateBanner(id);
  }

  async softDeleteBanner(id: number): Promise<boolean> {
    const banner = await bannerRepository.getBannerById(id);
    if (!banner) return false;

    return bannerRepository.softDeleteBanner(id);
  }

  async updateBanner(
    id: number,
    input: UpdateBannerInput
  ): Promise<BannerRow | null> {
    return bannerRepository.updateBanner(id, input);
  }

  async getBanner(id: number): Promise<BannerRow | null> {
    return bannerRepository.getBannerById(id);
  }

  async listBanners(options: {
    placement?: BannerPlacement;
    isActive?: boolean;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ items: BannerRow[]; total: number }> {
    return bannerRepository.listBanners(options);
  }

  async getActiveTicketAd(): Promise<BannerRow | null> {
    return bannerRepository.getActiveBannerByPlacement('ticket_advertisement');
  }
}

export const bannerService = new BannerService();