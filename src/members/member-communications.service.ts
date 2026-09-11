import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SendMemberMessageDto } from './dto/send-member-message.dto';

/**
 * Message history and staff-composed sends for one member. History reads
 * straight from MessageLog (the same audit record every send path
 * writes); sends go through CommunicationsService.sendAdHoc so consent
 * gating and provider dispatch behave exactly like every other send.
 * EMAIL delivers for real today; WHATSAPP/SMS/PUSH record a FAILED log
 * row with the provider's clear "not configured" error instead of
 * pretending to deliver.
 */
@Injectable()
export class MemberCommunicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
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
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.messageLog.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async send(
    organizationId: string,
    memberId: string,
    dto: SendMemberMessageDto,
    branchScope: string | null = null,
  ) {
    const member = await this.requireMember(
      organizationId,
      memberId,
      branchScope,
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
