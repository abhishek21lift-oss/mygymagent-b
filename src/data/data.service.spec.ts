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
    // 1,999. The rows carry DIFFERENT branches, so the phase-2 reference
    // check runs once per distinct pair -- which is what keeps a
    // per-pair failure from poisoning every row that shares the pair.
    const { service, prisma, references } = build([]);
    references.checkMemberReferences
      .mockResolvedValueOnce(['Branch does not belong to this organization'])
      .mockResolvedValue([]);

    const result = await service.importMembers('org-a', [
      row({ lastName: 'Bad', primaryBranchId: 'branch-of-org-b' }),
      row({ lastName: 'Good' }),
    ] as never);

    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([
      { row: 1, message: 'Branch does not belong to this organization' },
    ]);
  });
});

/**
 * The scaling half of the importer: the per-row loop used to issue the
 * reference check (two queries) and the create for every row,
 * sequentially, so a full 2,000-row import ran ~6,000 queries inside
 * one HTTP request. These cases pin the batching, not just the outcome.
 */
describe('DataService.importMembers — batching', () => {
  function build() {
    const prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 'branch-a' }) },
      member: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
    };
    const references = {
      checkMemberReferences: jest.fn().mockResolvedValue([]),
    };
    const service = new DataService(
      prisma as never,
      {} as never,
      references as unknown as TenantReferenceValidator,
    );
    return { service, prisma, references };
  }

  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      firstName: 'Asha',
      lastName: `Rao${i}`,
      // Distinct per row: email and phone are unique keys for dedupe.
      email: `asha${i}@example.com`,
      phone: `+9100000000${i}`,
    }));

  it('checks tenant references once per distinct branch/trainer pair, not per row', async () => {
    const { service, references } = build();

    const result = await service.importMembers('org-a', rows(50) as never);

    expect(references.checkMemberReferences).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(50);
    expect(result.errors).toEqual([]);
  });

  it('creates every row when a full-size import shares one pair', async () => {
    const { service, prisma } = build();

    const result = await service.importMembers('org-a', rows(2000) as never);

    expect(prisma.member.create).toHaveBeenCalledTimes(2000);
    expect(result.created).toBe(2000);
  });

  it('dedupes in-file duplicates by email and phone, skips them', async () => {
    const { service, prisma } = build();

    const result = await service.importMembers('org-a', [
      { firstName: 'Asha', lastName: 'Rao', email: 'dupe@example.com' },
      { firstName: 'Asha', lastName: 'Rao', email: 'dupe@example.com' },
      { firstName: 'Asha', lastName: 'Rao', phone: '+910000000000' },
      { firstName: 'Asha', lastName: 'Rao', phone: '+910000000000' },
    ] as never);

    expect(prisma.member.create).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(2);
  });

  it('reports database failures per row and keeps the rest of the import', async () => {
    const { service, prisma } = build();
    prisma.member.create
      .mockResolvedValueOnce({ id: 'member-1' })
      .mockRejectedValueOnce(new Error('unique constraint'))
      .mockResolvedValue({ id: 'member-3' });

    const result = await service.importMembers('org-a', rows(3) as never);

    expect(result.created).toBe(2);
    expect(result.errors).toEqual([{ row: 2, message: 'unique constraint' }]);
  });
});

/**
 * The export streams: the old implementation loaded the entire member
 * table and built one string in memory. These pin the paging contract
 * (stable cursor, no repeated or skipped rows across pages).
 */
describe('DataService.exportMemberChunks', () => {
  const memberRow = (n: number) => ({
    id: `member-${n}`,
    firstName: `First${n}`,
    lastName: `Last${n}`,
    email: null,
    phone: null,
    dateOfBirth: null,
    gender: null,
    status: 'ACTIVE',
    primaryBranchId: 'branch-a',
    assignedTrainerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  function build(pages: ReturnType<typeof memberRow>[][]) {
    const prisma = {
      member: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(pages[0] ?? [])
          .mockResolvedValueOnce(pages[1] ?? []),
      },
    };
    const service = new DataService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  const drain = async (gen: AsyncGenerator<string>) => {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks.join('');
  };

  it('yields the header row and stops when the first page is empty', async () => {
    const { service, prisma } = build([[]]);

    const csv = await drain(service.exportMemberChunks('org-a'));

    expect(csv).toBe(
      'id,firstName,lastName,email,phone,dateOfBirth,gender,status,primaryBranchId,assignedTrainerId,createdAt\n',
    );
    expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
  });

  it('pages with an id cursor while pages stay full', async () => {
    // A short page is the last page, so the cursor path only runs when
    // a page comes back full -- mirror the real shape.
    const full = Array.from({ length: 500 }, (_, i) => memberRow(i + 1));
    const { service, prisma } = build([full, [memberRow(501)]]);

    const csv = await drain(service.exportMemberChunks('org-a'));
    const lines = csv.trimEnd().split('\n');

    expect(lines).toHaveLength(502); // header + 500 + 1
    expect(prisma.member.findMany).toHaveBeenCalledTimes(2);
    // Second call skips past the last row of the first page.
    expect(prisma.member.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { id: 'member-500' },
        skip: 1,
        take: 500,
      }),
    );
    expect(csv).toContain('"First501","Last501"');
  });
});
