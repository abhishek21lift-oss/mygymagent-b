import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Organization, Prisma } from '@prisma/client';
import {
  FileStorageService,
  sniffMimeType,
} from '../files/file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateOrganizationDto } from './dto/update-organization.dto';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface UploadedLogo {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** The organization as clients see it: the logo as a short-lived URL,
 * never its storage key. */
export type OrganizationView = Omit<Organization, 'logoKey'> & {
  logoUrl: string | null;
};

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileStorageService,
  ) {}

  async getCurrent(organizationId: string): Promise<OrganizationView> {
    return this.view(await this.find(organizationId));
  }

  async updateCurrent(
    organizationId: string,
    dto: UpdateOrganizationDto,
  ): Promise<OrganizationView> {
    // organizationId always comes from the authenticated user's JWT-derived
    // context (see OrganizationsController) -- there is no route param an
    // attacker could substitute to target a different tenant.
    await this.find(organizationId);
    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...dto,
        settings: dto.settings as Prisma.InputJsonValue | undefined,
      },
    });
    return this.view(updated);
  }

  async setLogo(
    organizationId: string,
    file: UploadedLogo | undefined,
  ): Promise<OrganizationView> {
    if (!file) throw new BadRequestException('Choose an image to upload.');
    if (file.size > MAX_LOGO_BYTES) {
      throw new BadRequestException('The logo must be 2 MB or smaller.');
    }
    // The file's own bytes, not the name or the browser's claim.
    const type = sniffMimeType(file.buffer);
    if (!type || !LOGO_TYPES.includes(type)) {
      throw new BadRequestException(
        'The logo must be a PNG, JPEG or WebP image.',
      );
    }
    const current = await this.find(organizationId);
    const { key } = await this.files.upload({
      organizationId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: type,
      pathPrefix: 'branding',
    });
    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoKey: key },
    });
    await this.forget(current.logoKey);
    return this.view(updated);
  }

  async removeLogo(organizationId: string): Promise<OrganizationView> {
    const current = await this.find(organizationId);
    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoKey: null },
    });
    await this.forget(current.logoKey);
    return this.view(updated);
  }

  private async find(organizationId: string): Promise<Organization> {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  private async view(org: Organization): Promise<OrganizationView> {
    const { logoKey, ...rest } = org;
    let logoUrl: string | null = null;
    if (logoKey) {
      // Storage being down must not take the settings page with it.
      logoUrl = await this.files.getSignedUrl(logoKey).catch(() => null);
    }
    return { ...rest, logoUrl };
  }

  /** Deletes a replaced logo; a failure only leaves an orphan behind. */
  private async forget(key: string | null): Promise<void> {
    if (!key) return;
    await this.files
      .delete(key)
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not delete old logo ${key}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
}
