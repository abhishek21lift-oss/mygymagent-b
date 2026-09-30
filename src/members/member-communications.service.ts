import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommunicationsService } from '../communications/communications.service';
import { MemberDirectPushService } from '../notifications/push/member-direct-push.service';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { SendMemberMessageDto } from './dto/send-member-message.dto';

/**
 * Message history and staff-composed sends for one member. History reads
 * straight from MessageLog (the same audit record every send path
 * writes); sends go through CommunicationsService.sendAdHoc so consent
 * gating and provider dispatch behave exactly like every other send.
 * PUSH is the exception: it goes to the member's own app devices through
 * MemberDirectPushService, not to an address -- see that class.
 */
@Injectable()
export class MemberCommunicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly directPush: MemberDirectPushService,
  ) {}

  private async requireMember(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async history(
    organizationId: string,
    memberId: string,
    query: { page: number; pageSize: number },
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const where = { organizationId, memberId };
    const [items, total] = await Promise.all([
      this.prisma.messageLog.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.messageLog.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async send(
    organizationId: string,
    memberId: string,
    dto: SendMemberMessageDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const body = dto.customBody?.trim() ?? '';
    if (!dto.templateKey && !body)
      throw new BadRequestException(
        'Either templateKey or customBody is required',
      );
    if (dto.templateKey && body)
      throw new BadRequestException(
        'Provide either templateKey or customBody, not both',
      );

    if (dto.channel === 'PUSH') {
      // No push templates exist; a template key here would resolve to
      // nothing and fail somewhere less clear.
      if (dto.templateKey)
        throw new BadRequestException(
          'Push messages are written directly; templates are for email, WhatsApp and SMS',
        );
      const rendered = await this.communications.renderForOrganization(
        organizationId,
        body,
        dto.variables,
      );
      const title = dto.customSubject?.trim()
        ? await this.communications.renderForOrganization(
            organizationId,
            dto.customSubject.trim(),
            dto.variables,
          )
        : await this.communications.renderForOrganization(
            organizationId,
            '{{organizationName}}',
          );
      return this.directPush.send(organizationId, member, {
        title: title || 'THE CULT CLIENT',
        body: rendered,
      });
    }

    const recipient =
      dto.channel === 'EMAIL' ? (member.email ?? '') : (member.phone ?? '');
    if (!recipient)
      throw new BadRequestException(
        dto.channel === 'EMAIL'
          ? 'This member has no email address on file'
          : 'This member has no phone number on file',
      );

    if (dto.templateKey) {
      return this.communications.send({
        organizationId,
        channel: dto.channel,
        category: 'TRANSACTIONAL',
        templateKey: dto.templateKey,
        recipient,
        memberId,
        variables: dto.variables,
      });
    }
    return this.communications.sendAdHoc({
      organizationId,
      channel: dto.channel,
      category: 'TRANSACTIONAL',
      recipient,
      memberId,
      subject: dto.customSubject,
      body,
      variables: dto.variables,
    });
  }
}
