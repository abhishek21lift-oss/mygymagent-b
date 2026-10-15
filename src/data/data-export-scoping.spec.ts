import { Test } from '@nestjs/testing';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import { PrismaService } from '../prisma/prisma.service';
import { DataService } from './data.service';

/**
 * D-SEC01 (F-SEC01): the member CSV export honors the enforced
 * branch/assignment scopes; org-wide holders keep the full-org export.
 * In-memory filtering mock (no database): proves the scope reaches the
 * query and narrows the streamed rows. Cross-organization and tampered
 * branch-header cases are covered by test/data-export-scoping.e2e-spec.ts
 * (requires .env.test DB).
 */
describe('DataService.exportMemberChunks scoping (D-SEC01)', () => {
  let service: DataService;
  let findMany: jest.Mock;

  const rows = [
    {
      id: 'a1',
      firstName: 'A',
      lastName: 'One',
      email: null,
      phone: null,
      dateOfBirth: null,
      gender: null,
      status: 'ACTIVE',
      primaryBranchId: 'b1',
      assignedTrainerId: 't1',
      createdAt: new Date('2026-01-01'),
      organizationId: 'org-1',
      deletedAt: null,
    },
    {
      id: 'a2',
      firstName: 'B',
      lastName: 'Two',
      email: null,
      phone: null,
      dateOfBirth: null,
      gender: null,
      status: 'ACTIVE',
      primaryBranchId: 'b2',
      assignedTrainerId: 't1',
      createdAt: new Date('2026-01-02'),
      organizationId: 'org-1',
      deletedAt: null,
    },
    {
      id: 'a3',
      firstName: 'C',
      lastName: 'Three',
      email: null,
      phone: null,
      dateOfBirth: null,
      gender: null,
      status: 'ACTIVE',
      primaryBranchId: 'b1',
      assignedTrainerId: 't9',
      createdAt: new Date('2026-01-03'),
      organizationId: 'org-1',
      deletedAt: null,
    },
  ];

  async function drain(
    gen: AsyncGenerator<string>,
  ): Promise<{ csv: string; calls: any[] }> {
    let csv = '';
    for await (const chunk of gen) csv += chunk;
    return { csv, calls: findMany.mock.calls.map(([args]: any) => args.where) };
  }

  beforeEach(async () => {
    findMany = jest.fn().mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      return rows.filter(
        (r) =>
          r.organizationId === w.organizationId &&
          (w.deletedAt === null ? r.deletedAt === null : true) &&
          (w.primaryBranchId === undefined ||
            r.primaryBranchId === w.primaryBranchId) &&
          (w.assignedTrainerId === undefined ||
            r.assignedTrainerId === w.assignedTrainerId),
      );
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataService,
        { provide: PrismaService, useValue: { member: { findMany } } },
        {
          provide: PlatformBillingService,
          useValue: { assertUnder: jest.fn() },
        },
        {
          provide: TenantReferenceValidator,
          useValue: {},
        },
      ],
    }).compile();
    service = moduleRef.get(DataService);
  });

  it('exports the whole organization when no scopes are enforced', async () => {
    const { csv, calls } = await drain(
      service.exportMemberChunks('org-1', {
        branchScope: null,
        assignmentScope: null,
      }),
    );
    expect(calls[0]).toEqual({ organizationId: 'org-1', deletedAt: null });
    expect(csv).toContain('A","One');
    expect(csv).toContain('B","Two');
    expect(csv).toContain('C","Three');
  });

  it('narrows to the enforced branch', async () => {
    const { csv, calls } = await drain(
      service.exportMemberChunks('org-1', { branchScope: 'b2' }),
    );
    expect(calls[0].primaryBranchId).toBe('b2');
    expect(csv).not.toContain('A","One');
    expect(csv).toContain('B","Two');
    expect(csv).not.toContain('C","Three');
  });

  it('narrows to the enforced trainer assignment', async () => {
    const { csv, calls } = await drain(
      service.exportMemberChunks('org-1', { assignmentScope: 't9' }),
    );
    expect(calls[0].assignedTrainerId).toBe('t9');
    expect(csv).not.toContain('A","One');
    expect(csv).not.toContain('B","Two');
    expect(csv).toContain('C","Three');
  });

  it('intersects branch and assignment scopes', async () => {
    const { csv } = await drain(
      service.exportMemberChunks('org-1', {
        branchScope: 'b1',
        assignmentScope: 't1',
      }),
    );
    expect(csv).toContain('A","One');
    expect(csv).not.toContain('B","Two');
    expect(csv).not.toContain('C","Three');
  });
});
