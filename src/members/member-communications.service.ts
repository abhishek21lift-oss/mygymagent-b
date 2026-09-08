import { BadRequestException, Injectable } from '@nestjs/common';
import { CommunicationChannel, Member } from '@prisma/client';
import { CommunicationsService } from '../communications/communications.service';
import { MembersService } from './members.service';
import { PrismaService } from '../prisma/prisma.service';

export interface SendMemberMessageDto {
  channel: CommunicationChannel;
  templateKey?: string;
  customBody?: string;
  customSubject?: string;
  variables?: Record<string, string>;
}

@Injectable()
export class MemberCommunicationsService {
  constructor(
    private readonly members: MembersService,
    private readonly communications: CommunicationsService,
    private readonly prisma: PrismaService,
  ) {}

  private async assertMemberVisible(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<Member> {
    return this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  async list(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.messageLog.findMany({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async send(
    organizationId: string,
    memberId: string,
    dto: SendMemberMessageDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const member = await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    if (dto.channel === 'EMAIL' && !member.email) {
      throw new BadRequestException('Member has no email address');
    }
    if (dto.channel === 'WHATSAPP' && !member.phone) {
      throw new BadRequestException('Member has no phone number');
    }

    const recipient = dto.channel === 'EMAIL' ? member.email! : member.phone!;
    const category = 'TRANSACTIONAL';

    if (dto.templateKey) {
      return this.communications.send({
        organizationId,
        channel: dto.channel,
        category,
        templateKey: dto.templateKey,
        recipient,
        memberId,
        variables: dto.variables,
      });
    }

    if (!dto.customBody) {
      throw new BadRequestException(
        'Either templateKey or customBody is required',
      );
    }

    return this.communications.send({
      organizationId,
      channel: dto.channel,
      category,
      templateKey: 'custom',
      recipient,
      memberId,
      customBody: dto.customBody,
      customSubject: dto.customSubject,
    });
  }
}
