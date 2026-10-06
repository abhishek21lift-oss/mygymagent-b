import 'reflect-metadata';
import { ToolExecutorService } from './tool-executor.service';

const context = { organizationId: 'org-1', userId: 'staff-1' };

function executor(deps: Record<string, unknown>) {
  const none = {};
  return new ToolExecutorService(
    none as never,
    none as never,
    none as never,
    none as never,
    (deps.leadsService ?? none) as never,
    none as never,
    (deps.audit ?? { record: jest.fn() }) as never,
    (deps.permissions ?? none) as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    (deps.memberFollowUpsService ?? none) as never,
  );
}

const perms = { hasPermission: jest.fn().mockResolvedValue(true) };
const audit = { record: jest.fn() };

describe('follow-up replay guard', () => {
  it('returns the existing lead follow-up instead of duplicating it', async () => {
    const existing = {
      id: 'fu-1',
      leadId: 'lead-1',
      note: 'Call back',
      dueAt: new Date('2026-10-07T00:00:00Z'),
      completedAt: null,
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    };
    const addFollowUp = jest.fn();
    const service = executor({
      permissions: perms,
      audit,
      leadsService: {
        listFollowUps: jest.fn().mockResolvedValue({ items: [existing] }),
        addFollowUp,
      },
    });
    const result = (await service.execute(
      'create_followup',
      { leadId: 'lead-1', note: 'Call back', dueAt: '2026-10-07' },
      context,
    )) as { id: string };
    expect(result.id).toBe('fu-1');
    expect(addFollowUp).not.toHaveBeenCalled();
  });

  it('creates when the identical item is old enough to be a new intent', async () => {
    const stale = {
      id: 'fu-old',
      leadId: 'lead-1',
      note: 'Call back',
      dueAt: new Date('2026-10-07T00:00:00Z'),
      completedAt: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    const addFollowUp = jest
      .fn()
      .mockResolvedValue({ id: 'fu-new', dueAt: stale.dueAt });
    const service = executor({
      permissions: perms,
      audit,
      leadsService: {
        listFollowUps: jest.fn().mockResolvedValue({ items: [stale] }),
        addFollowUp,
      },
    });
    const result = (await service.execute(
      'create_followup',
      { leadId: 'lead-1', note: 'Call back', dueAt: '2026-10-07' },
      context,
    )) as { id: string };
    expect(result.id).toBe('fu-new');
    expect(addFollowUp).toHaveBeenCalledTimes(1);
  });

  it('dedupes member follow-ups the same way', async () => {
    const existing = {
      id: 'mfu-1',
      title: 'Check in',
      description: undefined,
      dueAt: null,
      completedAt: null,
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    };
    const create = jest.fn();
    const service = executor({
      permissions: perms,
      audit,
      memberFollowUpsService: {
        list: jest.fn().mockResolvedValue([existing]),
        create,
      },
    });
    const result = (await service.execute(
      'create_member_followup',
      { memberId: 'mem-1', title: 'Check in' },
      context,
    )) as { id: string };
    expect(result.id).toBe('mfu-1');
    expect(create).not.toHaveBeenCalled();
  });
});
