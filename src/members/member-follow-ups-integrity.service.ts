import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import { MemberFollowUpsService } from './member-follow-ups.service';
import type {
  CreateMemberFollowUpDto,
  UpdateMemberFollowUpDto,
} from './dto/member-follow-up.dto';

@Injectable()
export class MemberFollowUpsIntegrityService extends MemberFollowUpsService {
  constructor(
    private readonly integrityPrisma: PrismaService,
    members: MembersService,
  ) {
    super(integrityPrisma, members);
  }

  private async assertAssignedUser(
    organizationId: string,
    assignedToUserId: string | undefined,
    branchScope: string | null,
  ) {
    if (!assignedToUserId) return;

    const user = await this.integrityPrisma.user.findFirst({
      where: {
        id: assignedToUserId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException(
        'Assigned user does not belong to the permitted organization or branch',
      );
    }
  }

  override async create(
    organizationId: string,
    memberId: string,
    dto: CreateMemberFollowUpDto,
    createdByUserId: string | null,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertAssignedUser(
      organizationId,
      dto.assignedToUserId,
      branchScope,
    );
    return super.create(
      organizationId,
      memberId,
      dto,
      createdByUserId,
      branchScope,
      assignmentScope,
    );
  }

  override async update(
    organizationId: string,
    memberId: string,
    followUpId: string,
    dto: UpdateMemberFollowUpDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertAssignedUser(
      organizationId,
      dto.assignedToUserId,
      branchScope,
    );
    return super.update(
      organizationId,
      memberId,
      followUpId,
      dto,
      branchScope,
      assignmentScope,
    );
  }
}
