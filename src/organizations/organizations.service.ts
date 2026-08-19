import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(organizationId: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async updateCurrent(organizationId: string, dto: UpdateOrganizationDto) {
    // organizationId always comes from the authenticated user's JWT-derived
    // context (see OrganizationsController) -- there is no route param an
    // attacker could substitute to target a different tenant.
    await this.getCurrent(organizationId);
    return this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...dto,
        settings: dto.settings as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
