import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

export interface DuplicateCandidate {
  memberId: string;
  memberCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  matchScore: number;
  matchReasons: string[];
}

export interface DuplicateDetectionResult {
  memberId: string;
  memberCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  potentialDuplicates: DuplicateCandidate[];
}

export interface MergePreview {
  sourceMember: {
    id: string;
    memberCode: string;
    firstName: string;
    lastName: string;
  };
  targetMember: {
    id: string;
    memberCode: string;
    firstName: string;
    lastName: string;
  };
  conflicts: MergeConflict[];
  mergeableRecords: {
    type: string;
    count: number;
    ids: string[];
  }[];
}

export interface MergeConflict {
  field: string;
  sourceValue: unknown;
  targetValue: unknown;
  resolution: 'source' | 'target' | 'requires_manual';
}

@Injectable()
export class MemberDuplicateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  async findDuplicates(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<DuplicateDetectionResult | null> {
    const member = await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const candidates = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        id: { not: memberId },
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
      },
    });

    const scoredCandidates: DuplicateCandidate[] = [];

    for (const candidate of candidates) {
      const { score, reasons } = this.calculateMatchScore(member, candidate);
      if (score >= 50) {
        scoredCandidates.push({
          memberId: candidate.id,
          memberCode: candidate.memberCode,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          phone: candidate.phone,
          status: candidate.status,
          matchScore: score,
          matchReasons: reasons,
        });
      }
    }

    scoredCandidates.sort((a, b) => b.matchScore - a.matchScore);

    return {
      memberId: member.id,
      memberCode: member.memberCode,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone,
      status: member.status,
      potentialDuplicates: scoredCandidates,
    };
  }

  async findAllDuplicates(
    organizationId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<DuplicateDetectionResult[]> {
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
      },
    });

    const results: DuplicateDetectionResult[] = [];
    const processedIds = new Set<string>();

    for (const member of members) {
      if (processedIds.has(member.id)) continue;

      const duplicates = await this.findDuplicates(
        organizationId,
        member.id,
        branchScope,
        assignmentScope,
      );

      if (duplicates && duplicates.potentialDuplicates.length > 0) {
        results.push(duplicates);
        duplicates.potentialDuplicates.forEach((d) =>
          processedIds.add(d.memberId),
        );
      }
      processedIds.add(member.id);
    }

    return results;
  }

  async previewMerge(
    organizationId: string,
    sourceMemberId: string,
    targetMemberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<MergePreview> {
    if (sourceMemberId === targetMemberId) {
      throw new BadRequestException('Cannot merge a member with itself');
    }

    await this.members.getOne(
      organizationId,
      sourceMemberId,
      branchScope,
      assignmentScope,
    );
    await this.members.getOne(
      organizationId,
      targetMemberId,
      branchScope,
      assignmentScope,
    );

    const [sourceMember, targetMember] = await Promise.all([
      this.prisma.member.findUnique({
        where: { id: sourceMemberId },
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          dateOfBirth: true,
          gender: true,
        },
      }),
      this.prisma.member.findUnique({
        where: { id: targetMemberId },
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          dateOfBirth: true,
          gender: true,
        },
      }),
    ]);

    if (!sourceMember || !targetMember) {
      throw new BadRequestException('One or both members not found');
    }

    const conflicts: MergeConflict[] = [];

    if (
      sourceMember.firstName !== targetMember.firstName ||
      sourceMember.lastName !== targetMember.lastName
    ) {
      conflicts.push({
        field: 'name',
        sourceValue: `${sourceMember.firstName} ${sourceMember.lastName}`,
        targetValue: `${targetMember.firstName} ${targetMember.lastName}`,
        resolution: 'requires_manual',
      });
    }

    if (
      sourceMember.email &&
      targetMember.email &&
      sourceMember.email.toLowerCase() !== targetMember.email.toLowerCase()
    ) {
      conflicts.push({
        field: 'email',
        sourceValue: sourceMember.email,
        targetValue: targetMember.email,
        resolution: 'requires_manual',
      });
    }

    if (
      sourceMember.phone &&
      targetMember.phone &&
      sourceMember.phone !== targetMember.phone
    ) {
      conflicts.push({
        field: 'phone',
        sourceValue: sourceMember.phone,
        targetValue: targetMember.phone,
        resolution: 'requires_manual',
      });
    }

    if (
      sourceMember.dateOfBirth &&
      targetMember.dateOfBirth &&
      sourceMember.dateOfBirth.getTime() !== targetMember.dateOfBirth.getTime()
    ) {
      conflicts.push({
        field: 'dateOfBirth',
        sourceValue: sourceMember.dateOfBirth.toISOString(),
        targetValue: targetMember.dateOfBirth.toISOString(),
        resolution: 'requires_manual',
      });
    }

    if (
      sourceMember.gender &&
      targetMember.gender &&
      sourceMember.gender !== targetMember.gender
    ) {
      conflicts.push({
        field: 'gender',
        sourceValue: sourceMember.gender,
        targetValue: targetMember.gender,
        resolution: 'requires_manual',
      });
    }

    const [
      sourceAttendances,
      sourcePayments,
      sourceMemberships,
      sourcePtSessions,
      sourceGoals,
      sourceDocuments,
      sourceNotes,
      sourceAddresses,
      sourceEmergencyContacts,
    ] = await Promise.all([
      this.prisma.attendance.count({ where: { memberId: sourceMemberId } }),
      this.prisma.payment.count({ where: { memberId: sourceMemberId } }),
      this.prisma.membership.count({ where: { memberId: sourceMemberId } }),
      this.prisma.ptSession.count({ where: { memberId: sourceMemberId } }),
      this.prisma.memberGoal.count({ where: { memberId: sourceMemberId } }),
      this.prisma.memberDocument.count({ where: { memberId: sourceMemberId } }),
      this.prisma.memberNote.count({ where: { memberId: sourceMemberId } }),
      this.prisma.memberAddress.count({ where: { memberId: sourceMemberId } }),
      this.prisma.memberEmergencyContact.count({
        where: { memberId: sourceMemberId },
      }),
    ]);

    const mergeableRecords = [
      {
        type: 'attendance',
        count: sourceAttendances,
        ids: [],
      },
      {
        type: 'payment',
        count: sourcePayments,
        ids: [],
      },
      {
        type: 'membership',
        count: sourceMemberships,
        ids: [],
      },
      {
        type: 'pt_session',
        count: sourcePtSessions,
        ids: [],
      },
      {
        type: 'goal',
        count: sourceGoals,
        ids: [],
      },
      {
        type: 'document',
        count: sourceDocuments,
        ids: [],
      },
      {
        type: 'note',
        count: sourceNotes,
        ids: [],
      },
      {
        type: 'address',
        count: sourceAddresses,
        ids: [],
      },
      {
        type: 'emergency_contact',
        count: sourceEmergencyContacts,
        ids: [],
      },
    ].filter((r) => r.count > 0);

    return {
      sourceMember: {
        id: sourceMember.id,
        memberCode: sourceMember.memberCode,
        firstName: sourceMember.firstName,
        lastName: sourceMember.lastName,
      },
      targetMember: {
        id: targetMember.id,
        memberCode: targetMember.memberCode,
        firstName: targetMember.firstName,
        lastName: targetMember.lastName,
      },
      conflicts,
      mergeableRecords,
    };
  }

  async executeMerge(
    organizationId: string,
    sourceMemberId: string,
    targetMemberId: string,
    performedByUserId: string,
    resolution: Record<string, 'source' | 'target'>,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<{ success: boolean; mergedMemberId: string }> {
    if (sourceMemberId === targetMemberId) {
      throw new BadRequestException('Cannot merge a member with itself');
    }

    await this.members.getOne(
      organizationId,
      sourceMemberId,
      branchScope,
      assignmentScope,
    );
    await this.members.getOne(
      organizationId,
      targetMemberId,
      branchScope,
      assignmentScope,
    );

    const preview = await this.previewMerge(
      organizationId,
      sourceMemberId,
      targetMemberId,
      branchScope,
      assignmentScope,
    );

    if (preview.conflicts.some((c) => c.resolution === 'requires_manual')) {
      const unresolvedConflicts = preview.conflicts.filter(
        (c) => c.resolution === 'requires_manual' && !resolution[c.field],
      );
      if (unresolvedConflicts.length > 0) {
        throw new BadRequestException(
          `Unresolved conflicts: ${unresolvedConflicts.map((c) => c.field).join(', ')}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          organizationId,
          actorUserId: performedByUserId,
          action: 'MEMBER_MERGE_INITIATED',
          resource: 'member',
          resourceId: sourceMemberId,
          beforeState: JSON.stringify({ id: sourceMemberId }),
          afterState: JSON.stringify({ id: targetMemberId }),
        },
      });

      // Apply the caller's per-conflict field resolution: when a conflict
      // says "source", the source member's value is copied onto the target
      // before the source is retired. "target" (or unset) keeps the target's
      // existing value.
      const sourceMember = await tx.member.findUnique({
        where: { id: sourceMemberId },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      });
      const targetMember = await tx.member.findUnique({
        where: { id: targetMemberId },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      });
      if (sourceMember && targetMember) {
        const resolvedFields: Record<string, unknown> = {};
        for (const conflict of preview.conflicts) {
          if (resolution[conflict.field] !== 'source') continue;
          const sourceValue = (sourceMember as Record<string, unknown>)[
            conflict.field === 'name' ? 'firstName' : conflict.field
          ];
          if (conflict.field === 'name') {
            resolvedFields.firstName = sourceMember.firstName;
            resolvedFields.lastName = sourceMember.lastName;
          } else {
            resolvedFields[conflict.field] = sourceValue;
          }
        }
        if (Object.keys(resolvedFields).length > 0) {
          await tx.member.update({
            where: { id: targetMemberId },
            data: resolvedFields,
          });
        }
      }

      await tx.attendance.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.payment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.membership.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.ptSession.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberGoal.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberDocument.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberNote.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberAddress.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberEmergencyContact.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberConsent.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberAssessment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberMeasurement.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberFitnessTestResult.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberScreening.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberBranchHistory.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberTrainerHistory.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.memberStatusHistory.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.messageLog.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      // The remaining member-owned tables (same memberId-move pattern).
      // Without these, cascade delete silently destroyed the source's
      // follow-ups, tags, segment assignments, recommended actions, and
      // workout/diet history when the source row was retired.
      await tx.memberFollowUp.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      // @@unique([memberId, segmentId]): the target may already sit in one
      // of the source's segments -- drop the target's colliding rows first
      // so the move can't violate the constraint.
      const sourceSegmentIds = await tx.memberSegmentAssignment.findMany({
        where: { memberId: sourceMemberId },
        select: { segmentId: true },
      });
      if (sourceSegmentIds.length > 0) {
        await tx.memberSegmentAssignment.deleteMany({
          where: {
            memberId: targetMemberId,
            segmentId: { in: sourceSegmentIds.map((s) => s.segmentId) },
          },
        });
      }
      await tx.memberSegmentAssignment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.recommendedAction.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.workoutAssignment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.workoutSession.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      await tx.dietAssignment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      // Tags: same collision story as segments (@@unique([memberId, tagId])
      // via the member_tag_assignments unique index) -- keep the target's
      // assignment where both members had the same tag.
      const sourceTagIds = await tx.memberTagAssignment.findMany({
        where: { memberId: sourceMemberId },
        select: { tagId: true },
      });
      if (sourceTagIds.length > 0) {
        await tx.memberTagAssignment.deleteMany({
          where: {
            memberId: targetMemberId,
            tagId: { in: sourceTagIds.map((t) => t.tagId) },
          },
        });
      }
      await tx.memberTagAssignment.updateMany({
        where: { memberId: sourceMemberId },
        data: { memberId: targetMemberId },
      });

      // convertedFromLead: Lead.convertedMemberId is @unique, so an
      // updateMany would throw if the target already has a lead link. Clear
      // the source's link instead of moving it -- the target keeps its own.
      await tx.lead.updateMany({
        where: { convertedMemberId: sourceMemberId },
        data: { convertedMemberId: null },
      });

      await tx.member.update({
        where: { id: sourceMemberId },
        data: {
          deletedAt: new Date(),
          status: 'INACTIVE',
          notes: `MERGED INTO: ${targetMemberId} at ${new Date().toISOString()}`,
        },
      });

      await tx.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          organizationId,
          actorUserId: performedByUserId,
          action: 'MEMBER_MERGED',
          resource: 'member',
          resourceId: targetMemberId,
          beforeState: JSON.stringify({ mergedFrom: sourceMemberId }),
          afterState: JSON.stringify({ mergedInto: targetMemberId }),
        },
      });

      return { success: true, mergedMemberId: targetMemberId };
    });
  }

  private calculateMatchScore(
    member: {
      firstName: string;
      lastName: string;
      email: string | null;
      phone: string | null;
    },
    candidate: {
      firstName: string;
      lastName: string;
      email: string | null;
      phone: string | null;
    },
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    const firstNameSimilar = this.calculateStringSimilarity(
      member.firstName.toLowerCase(),
      candidate.firstName.toLowerCase(),
    );
    if (firstNameSimilar > 0.8) {
      score += 30;
      reasons.push('First name matches');
    } else if (firstNameSimilar > 0.6) {
      score += 15;
      reasons.push('First name similar');
    }

    const lastNameSimilar = this.calculateStringSimilarity(
      member.lastName.toLowerCase(),
      candidate.lastName.toLowerCase(),
    );
    if (lastNameSimilar > 0.8) {
      score += 30;
      reasons.push('Last name matches');
    } else if (lastNameSimilar > 0.6) {
      score += 15;
      reasons.push('Last name similar');
    }

    if (
      member.email &&
      candidate.email &&
      member.email.toLowerCase() === candidate.email.toLowerCase()
    ) {
      score += 40;
      reasons.push('Email matches');
    }

    if (
      member.phone &&
      candidate.phone &&
      this.normalizePhone(member.phone) === this.normalizePhone(candidate.phone)
    ) {
      score += 40;
      reasons.push('Phone matches');
    }

    return { score: Math.min(100, score), reasons };
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1;
    if (str1.length < 2 || str2.length < 2) return 0;

    const longer = str1.length >= str2.length ? str1 : str2;
    const shorter = str1.length >= str2.length ? str2 : str1;

    if (longer.includes(shorter)) return shorter.length / longer.length;

    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) {
        matches++;
      }
    }

    return matches / longer.length;
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }
}
