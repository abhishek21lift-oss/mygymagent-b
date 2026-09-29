import { TenantReferenceValidator } from './tenant-reference.validator';

/**
 * The tenant-ownership rule for `Member.primaryBranchId` and
 * `Member.assignedTrainerId`.
 *
 * Both are bare UUID foreign keys with no same-organization constraint,
 * so nothing but this check stops a member row pointing at another gym's
 * branch or staff member. It existed only as a `private` method on
 * `MembersService`, which is why the CSV import could bypass it.
 */
describe('TenantReferenceValidator.checkMemberReferences', () => {
  const org = 'org-a';
  const otherOrgBranch = { id: 'branch-b' };

  function build(opts: { branch?: unknown; trainer?: unknown }) {
    const prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue(opts.branch ?? null) },
      user: { findFirst: jest.fn().mockResolvedValue(opts.trainer ?? null) },
    };
    return { validator: new TenantReferenceValidator(prisma as never), prisma };
  }

  it('accepts a branch the organization owns', async () => {
    const { validator } = build({ branch: { id: 'branch-a' } });
    await expect(
      validator.checkMemberReferences(org, { primaryBranchId: 'branch-a' }),
    ).resolves.toEqual([]);
  });

  it('rejects a branch belonging to another organization', async () => {
    const { validator, prisma } = build({ branch: null });
    const problems = await validator.checkMemberReferences(org, {
      primaryBranchId: otherOrgBranch.id,
    });
    expect(problems).toEqual(['Branch does not belong to this organization']);
    // The organization must be part of the lookup, not just the id --
    // otherwise this returns the foreign branch and passes.
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: org }),
      }),
    );
  });

  it('rejects a trainer belonging to another organization', async () => {
    const { validator } = build({ trainer: null });
    const problems = await validator.checkMemberReferences(org, {
      assignedTrainerId: 'user-b',
    });
    expect(problems).toEqual([
      'Assigned trainer must be active, a trainer, and compatible with the member branch',
    ]);
  });

  it('accepts a trainer the organization owns', async () => {
    const { validator } = build({ trainer: { id: 'user-a' } });
    await expect(
      validator.checkMemberReferences(org, { assignedTrainerId: 'user-a' }),
    ).resolves.toEqual([]);
  });

  it('reports both problems at once rather than stopping at the first', async () => {
    const { validator } = build({ branch: null, trainer: null });
    const problems = await validator.checkMemberReferences(org, {
      primaryBranchId: 'branch-b',
      assignedTrainerId: 'user-b',
    });
    expect(problems).toHaveLength(2);
  });

  it('does not query at all when no references were supplied', async () => {
    const { validator, prisma } = build({});
    await expect(validator.checkMemberReferences(org, {})).resolves.toEqual([]);
    expect(prisma.branch.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('treats a null trainer as absent rather than as a failed lookup', async () => {
    const { validator, prisma } = build({ trainer: null });
    await expect(
      validator.checkMemberReferences(org, { assignedTrainerId: null }),
    ).resolves.toEqual([]);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
