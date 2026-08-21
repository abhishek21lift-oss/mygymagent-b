import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberAssessmentDto } from './dto/member-assessment.dto';
import type { CreateMemberFitnessTestDto } from './dto/member-fitness-test.dto';
import type { CreateMemberMeasurementDto } from './dto/member-measurement.dto';
import type { CreateMemberScreeningDto } from './dto/member-screening.dto';
import { MembersService } from './members.service';

/**
 * Assessments, measurements, fitness-test results, and PAR-Q-style
 * screenings -- see the schema.prisma section comment above
 * MemberAssessment for why these are gated the same way the rest of
 * Member 360 is (members.read/members.read_assigned/members.update),
 * not their own permission keys.
 */
@Injectable()
export class MemberAssessmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  private async assertMemberVisible(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<void> {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  // -- Assessments --------------------------------------------------------------

  async listAssessments(
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
    return this.prisma.memberAssessment.findMany({
      where: { organizationId, memberId },
      orderBy: { conductedAt: 'desc' },
      include: {
        conductedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        measurements: true,
        fitnessResults: true,
        screening: true,
      },
    });
  }

  async createAssessment(
    organizationId: string,
    memberId: string,
    conductedByUserId: string,
    dto: CreateMemberAssessmentDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.memberAssessment.create({
      data: {
        organizationId,
        memberId,
        type: dto.type,
        notes: dto.notes,
        conductedByUserId,
        conductedAt: dto.conductedAt ? new Date(dto.conductedAt) : undefined,
      },
    });
  }

  // -- Measurements ---------------------------------------------------------------

  async listMeasurements(
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
    return this.prisma.memberMeasurement.findMany({
      where: { organizationId, memberId },
      orderBy: { recordedAt: 'desc' },
    });
  }

  async createMeasurement(
    organizationId: string,
    memberId: string,
    recordedByUserId: string,
    dto: CreateMemberMeasurementDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    if (dto.assessmentId) {
      await this.assertAssessmentBelongsToMember(
        organizationId,
        memberId,
        dto.assessmentId,
      );
    }
    return this.prisma.memberMeasurement.create({
      data: {
        ...dto,
        organizationId,
        memberId,
        recordedByUserId,
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
      },
    });
  }

  // -- Fitness test results --------------------------------------------------------

  async listFitnessResults(
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
    return this.prisma.memberFitnessTestResult.findMany({
      where: { organizationId, memberId },
      orderBy: { recordedAt: 'desc' },
    });
  }

  async createFitnessResult(
    organizationId: string,
    memberId: string,
    recordedByUserId: string,
    dto: CreateMemberFitnessTestDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    if (dto.assessmentId) {
      await this.assertAssessmentBelongsToMember(
        organizationId,
        memberId,
        dto.assessmentId,
      );
    }
    return this.prisma.memberFitnessTestResult.create({
      data: {
        ...dto,
        organizationId,
        memberId,
        recordedByUserId,
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
      },
    });
  }

  // -- Screenings (PAR-Q) -----------------------------------------------------------

  async listScreenings(
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
    return this.prisma.memberScreening.findMany({
      where: { organizationId, memberId },
      orderBy: { completedAt: 'desc' },
    });
  }

  async createScreening(
    organizationId: string,
    memberId: string,
    recordedByUserId: string,
    dto: CreateMemberScreeningDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    if (dto.assessmentId) {
      await this.assertAssessmentBelongsToMember(
        organizationId,
        memberId,
        dto.assessmentId,
      );
    }
    return this.prisma.memberScreening.create({
      data: { ...dto, organizationId, memberId, recordedByUserId },
    });
  }

  private async assertAssessmentBelongsToMember(
    organizationId: string,
    memberId: string,
    assessmentId: string,
  ): Promise<void> {
    const assessment = await this.prisma.memberAssessment.findFirst({
      where: { id: assessmentId, organizationId, memberId },
      select: { id: true },
    });
    if (!assessment) throw new NotFoundException('Assessment not found');
  }
}
