import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecuteMergeDto } from './dto/member-merge.dto';

/// Scalar member fields a merge is allowed to pick a winner for.
/// Identity/state fields (id, memberCode, status, primaryBranchId,
/// joinedAt, userId) are deliberately NOT resolvable -- status and
/// branch have their own history-tracked flows, and portal login
/// follows the surviving target record (see warnings).
const RESOLVABLE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'dateOfBirth',
  'gender',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'emergencyContactName',
  'emergencyContactPhone',
  'memberType',
  'leadSource',
  'profilePhotoUrl',
  'notes',
  'assignedTrainerId',
] as const;

type ResolvableField = (typeof RESOLVABLE_FIELDS)[number];

/**
 * Duplicate detection and supervised merge. Detection is heuristic
 * (exact email/phone/name matches with documented scores, thresholded)
 * -- it proposes CANDIDATES, never conclusions; the duplicates tab shows
 * matchReasons so staff see why two rows look alike. Merging is always
 * human-approved with per-field resolution, moves every child row to
 * the surviving target, and soft-deletes the source (deletedAt) so the
 * merge is reversible from history, never a data-destroying rewrite.
 */
@Injectable()
export class MemberDuplicatesService {
  constructor(private readonly prisma: PrismaService) {}

  private async requirePair(
    organizationId: string,
    sourceId: string,
    targetId: string,
  ) {
    if (sourceId === targetId)
      throw new BadRequestException('Cannot merge a member with itself');
    const [source, target] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: sourceId, organizationId, deletedAt: null },
      }),
      this.prisma.member.findFirst({
        where: { id: targetId, organizationId, deletedAt: null },
      }),
    ]);
    if (!source) throw new NotFoundException('Source member not found');
    if (!target) throw new NotFoundException('Target member not found');
    return { source, target };
  }

  async findDuplicates(
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

    const candidates = await this.prisma.member.findMany({
      where: {
        organizationId,
        id: { not: memberId },
        deletedAt: null,
        OR: [
          ...(member.email ? [{ email: member.email }] : []),
          ...(member.phone ? [{ phone: member.phone }] : []),
          {
            firstName: { equals: member.firstName, mode: 'insensitive' },
            lastName: { equals: member.lastName, mode: 'insensitive' },
          },
        ],
      },
      take: 20,
    });

    const scored = candidates
      .map((candidate) => {
        let matchScore = 0;
        const matchReasons: string[] = [];
        if (
          member.email &&
          candidate.email &&
          member.email.toLowerCase() === candidate.email.toLowerCase()
        ) {
          matchScore += 50;
          matchReasons.push('Same email address');
        }
        if (
          member.phone &&
          candidate.phone &&
          member.phone.replace(/\D/g, '') === candidate.phone.replace(/\D/g, '')
        ) {
          matchScore += 40;
          matchReasons.push('Same phone number');
        }
        if (
          member.firstName.toLowerCase() ===
            candidate.firstName.toLowerCase() &&
          member.lastName.toLowerCase() === candidate.lastName.toLowerCase()
        ) {
          matchScore += 25;
          matchReasons.push('Same name');
        }
        return {
          memberId: candidate.id,
          memberCode: candidate.memberCode,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          phone: candidate.phone,
          status: candidate.status,
          matchScore,
          matchReasons,
        };
      })
      .filter((c) => c.matchScore >= 25)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 10);

    return {
      memberId: member.id,
      memberCode: member.memberCode,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone,
      status: member.status,
      potentialDuplicates: scored,
    };
  }

  async previewMerge(
    organizationId: string,
    sourceId: string,
    targetId: string,
  ) {
    const { source, target } = await this.requirePair(
      organizationId,
      sourceId,
      targetId,
    );

    const fields = RESOLVABLE_FIELDS.map((field) => {
      const sourceValue = toPreviewValue(source[field as ResolvableField]);
      const targetValue = toPreviewValue(target[field as ResolvableField]);
      return {
        field,
        sourceValue,
        targetValue,
        differs: sourceValue !== targetValue,
      };
    });

    const [sourceActive, targetActive, sourceUser, targetUser] =
      await Promise.all([
        this.prisma.membership.count({
          where: { organizationId, memberId: source.id, status: 'ACTIVE' },
        }),
        this.prisma.membership.count({
          where: { organizationId, memberId: target.id, status: 'ACTIVE' },
        }),
        this.prisma.user.findFirst({
          where: { id: source.userId ?? undefined },
          select: { id: true, email: true },
        }),
        this.prisma.user.findFirst({
          where: { id: target.userId ?? undefined },
          select: { id: true, email: true },
        }),
      ]);

    const warnings: string[] = [];
    if (sourceActive > 0 && targetActive > 0)
      warnings.push(
        'Both members hold active memberships -- all of them move to the surviving record; review for overlapping plans after merging.',
      );
    if (sourceUser && targetUser)
      warnings.push(
        'Both members have portal logins -- the surviving record keeps the target login; the source login stays untouched.',
      );
    if (source.primaryBranchId !== target.primaryBranchId)
      warnings.push(
        'Members belong to different branches -- history rows keep their original branch, only the surviving profile branch applies going forward.',
      );

    return {
      sourceMember: {
        id: source.id,
        memberCode: source.memberCode,
        firstName: source.firstName,
        lastName: source.lastName,
      },
      targetMember: {
        id: target.id,
        memberCode: target.memberCode,
        firstName: target.firstName,
        lastName: target.lastName,
      },
      fields,
      warnings,
    };
  }

  async executeMerge(
    organizationId: string,
    dto: ExecuteMergeDto,
    changedByUserId: string,
  ) {
    const { source, target } = await this.requirePair(
      organizationId,
      dto.sourceMemberId,
      dto.targetMemberId,
    );

    for (const [field, winner] of Object.entries(dto.resolution)) {
      if (!(RESOLVABLE_FIELDS as readonly string[]).includes(field))
        throw new BadRequestException(`Field "${field}" cannot be merged`);
      if (winner !== 'source' && winner !== 'target')
        throw new BadRequestException(
          `Resolution for "${field}" must be "source" or "target"`,
        );
    }
    if (source.userId && target.userId && source.userId !== target.userId) {
      // Portal login follows the target; the source User row itself is
      // left alone (it may own staff-adjacent records outside members).
    }

    const scalarData: Record<string, unknown> = {};
    for (const field of RESOLVABLE_FIELDS) {
      const winner = dto.resolution[field];
      if (winner === 'source') scalarData[field] = source[field];
    }
    // Move portal login only when the target has none to conflict with.
    if (source.userId && !target.userId) scalarData['userId'] = source.userId;

    await this.prisma.$transaction(async (tx) => {
      const move = (model: string, field = 'memberId') =>
        (
          tx[model as keyof typeof tx] as unknown as {
            updateMany: (args: unknown) => Promise<unknown>;
          }
        ).updateMany({
          where: { organizationId, [field]: source.id },
          data: { [field]: target.id },
        });

      await Promise.all([
        move('membership'),
        move('attendance'),
        move('payment'),
        move('workoutAssignment'),
        move('workoutSession'),
        move('dietAssignment'),
        move('ptSession'),
        move('appointment'),
        move('memberAddress'),
        move('memberEmergencyContact'),
        move('memberNote'),
        move('memberConsent'),
        move('memberStatusHistory'),
        move('memberBranchHistory'),
        move('memberTrainerHistory'),
        move('memberAssessment'),
        move('memberMeasurement'),
        move('memberFitnessTestResult'),
        move('memberScreening'),
        move('memberGoal'),
        move('memberDocument'),
        move('memberTagAssignment'),
        move('memberFollowUp'),
        move('messageLog'),
      ]);

      // Lead conversion links are unique per member -- move only when the
      // target has no converted lead of its own.
      const sourceLead = await tx.lead.findUnique({
        where: { convertedMemberId: source.id },
      });
      if (sourceLead) {
        const targetLead = await tx.lead.findUnique({
          where: { convertedMemberId: target.id },
        });
        if (!targetLead) {
          await tx.lead.update({
            where: { id: sourceLead.id },
            data: { convertedMemberId: target.id },
          });
        }
      }

      await tx.member.update({
        where: { id: target.id },
        data: scalarData,
      });
      await tx.memberStatusHistory.create({
        data: {
          organizationId,
          memberId: target.id,
          fromStatus: target.status,
          toStatus: target.status,
          changedByUserId,
          reason: `Merged duplicate ${source.memberCode} into ${target.memberCode}`,
        },
      });
      await tx.member.update({
        where: { id: source.id },
        data: {
          deletedAt: new Date(),
          notes: `${source.notes ? `${source.notes}\n` : ''}Merged into ${target.memberCode} on ${new Date().toISOString()}`,
        },
      });
    });

    return { success: true, mergedMemberId: target.id };
  }
}

function toPreviewValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
