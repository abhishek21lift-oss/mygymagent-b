import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The tenant-ownership check for the foreign keys a member row can carry.
 *
 * `Member.primaryBranchId` and `Member.assignedTrainerId` are bare UUID
 * foreign keys with no same-organization constraint, so the database will
 * happily accept a `Branch.id` or `User.id` belonging to a different gym.
 * Nothing enforces that for us; it has to be asked, every time, on every
 * write path.
 *
 * This was already being asked — `MembersService.validateReferences` did
 * it correctly for the interactive create and update paths — but it lived
 * as a `private` method on that one service, so `DataService.importMembers`
 * could not reach it. The CSV import therefore wrote whatever
 * `primaryBranchId` / `assignedTrainerId` the uploaded file contained,
 * and a member created by tenant A could point at tenant B's branch. The
 * read paths then join `primaryBranch` and `assignedTrainer` to render
 * member profiles, so A got B's branch name and B's staff full name back.
 *
 * Extracted so there is exactly one implementation, rather than a second
 * copy that can drift.
 *
 * It returns problems rather than throwing, because the two callers want
 * opposite things: the interactive path wants a 400 for the whole request,
 * while a bulk import wants to reject one row into its `errors` array and
 * carry on with the other 1,999.
 */
@Injectable()
export class TenantReferenceValidator {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @returns a list of human-readable problems; empty means the
   * references are owned by `organizationId` and usable.
   */
  async checkMemberReferences(
    organizationId: string,
    refs: { primaryBranchId?: string; assignedTrainerId?: string | null },
  ): Promise<string[]> {
    const problems: string[] = [];
    const { primaryBranchId, assignedTrainerId } = refs;

    if (primaryBranchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: primaryBranchId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) {
        problems.push('Branch does not belong to this organization');
      }
    }

    if (assignedTrainerId) {
      const trainer = await this.prisma.user.findFirst({
        where: {
          id: assignedTrainerId,
          organizationId,
          deletedAt: null,
          status: 'ACTIVE',
          AND: [
            {
              OR: [
                { staffProfile: { is: { isTrainer: true } } },
                { userRoles: { some: { role: { key: 'TRAINER' } } } },
              ],
            },
            ...(primaryBranchId
              ? [
                  {
                    OR: [
                      { primaryBranchId },
                      { staffProfile: { is: { branchId: primaryBranchId } } },
                      {
                        userRoles: {
                          some: {
                            branchId: primaryBranchId,
                            role: { key: 'TRAINER' },
                          },
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: { id: true },
      });
      if (!trainer) {
        problems.push(
          'Assigned trainer must be active, a trainer, and compatible with the member branch',
        );
      }
    }

    return problems;
  }
}
