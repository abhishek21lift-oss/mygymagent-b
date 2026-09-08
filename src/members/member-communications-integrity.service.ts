import { Injectable } from '@nestjs/common';
import { MemberCommunicationsService } from './member-communications.service';
import { MembersService } from './members.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Member } from '@prisma/client';

@Injectable()
export class MemberCommunicationsIntegrityService extends MemberCommunicationsService {
  constructor(
    private readonly integrityPrisma: PrismaService,
    members: MembersService,
    communications: CommunicationsService,
  ) {
    super(members, communications, integrityPrisma);
  }

  override async list(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisibleForIntegrity(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.integrityPrisma.messageLog.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async assertMemberVisibleForIntegrity(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<Member> {
    return this.integrityPrisma.member.findFirstOrThrow({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
    });
  }
}
