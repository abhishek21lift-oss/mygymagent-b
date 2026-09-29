import { DataService } from './data.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';

/**
 * The CSV member import and tenant ownership.
 *
 * `Member.primaryBranchId` is a bare UUID foreign key with no
 * same-organization constraint, and the uploaded file names its own
 * branch and trainer by id. The import used to write whatever the file
 * said, so a row could point at another gym's branch; the member profile
 * then joined `primaryBranch` and rendered that branch's name back to the
 * importing organization.
 *
 * `TenantReferenceValidator` already existed for the interactive create
 * path, but as a `private` method on `MembersService`, so the import
 * could not reach it. These cases pin the wiring, not just the rule: a
 * validator that exists but is not called here is the original bug.
 */
describe('DataService.importMembers — tenant ownership of supplied references', () => {
  function build(referenceProblems: string[]) {
    const prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 'branch-a' }) },
      member: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
    };
    const references = {
      checkMemberReferences: jest.fn().mockResolvedValue(referenceProblems),
    };
    const billing = {};
    const service = new DataService(
      prisma as never,
      billing as never,
      references as unknown as TenantReferenceValidator,
    );
    return { service, prisma, references };
  }

  const row = (over: Record<string, string> = {}) => ({
    firstName: 'Asha',
    lastName: 'Rao',
    ...over,
  });

  it('refuses a row naming another organization’s branch', async () => {
    const { service, prisma } = build([
      'Branch does not belong to this organization',
    ]);

    const result = await service.importMembers('org-a', [
      row({ primaryBranchId: 'branch-of-org-b' }),
    ] as never);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.errors).toEqual([
      {
        row: 1,
        message: 'Branch does not belong to this organization',
      },
    ]);
  });

  it('refuses a row naming another organization’s trainer', async () => {
    const { service, prisma } = build([
      'Assigned trainer must be active, a trainer, and compatible with the member branch',
    ]);

    const result = await service.importMembers('org-a', [
      row({ assignedTrainerId: 'user-of-org-b' }),
    ] as never);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(1);
  });

  it('checks the references against the caller’s organization', async () => {
    const { service, references } = build([]);

    await service.importMembers('org-a', [
      row({ primaryBranchId: 'branch-a', assignedTrainerId: 'user-a' }),
    ] as never);

    expect(references.checkMemberReferences).toHaveBeenCalledWith('org-a', {
      primaryBranchId: 'branch-a',
      assignedTrainerId: 'user-a',
    });
  });

  it('still validates the defaulted branch, not just a supplied one', async () => {
    // With no primaryBranchId in the file the row falls back to the org's
    // own default branch. That fallback is trusted, so the check has to
    // run against the resolved value rather than the raw cell.
    const { service, references } = build([]);

    await service.importMembers('org-a', [row()] as never);

    expect(references.checkMemberReferences).toHaveBeenCalledWith('org-a', {
      primaryBranchId: 'branch-a',
      assignedTrainerId: null,
    });
  });

  it('creates the member when the references are owned by the organization', async () => {
    const { service, prisma } = build([]);

    const result = await service.importMembers('org-a', [row()] as never);

    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('rejects only the offending row and imports the rest of the file', async () => {
    // The established contract for this importer is per-row errors, not
    // an all-or-nothing request: one bad line must not abandon the other
    // 1,999.
    const { service, prisma, references } = build([]);
    references.checkMemberReferences
      .mockResolvedValueOnce(['Branch does not belong to this organization'])
      .mockResolvedValue([]);

    const result = await service.importMembers('org-a', [
      row({ lastName: 'Bad' }),
      row({ lastName: 'Good' }),
    ] as never);

    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([
      { row: 1, message: 'Branch does not belong to this organization' },
    ]);
  });
});
