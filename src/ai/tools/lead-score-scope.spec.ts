import 'reflect-metadata';
import { ToolExecutorService } from './tool-executor.service';

const context = { organizationId: 'org-1', userId: 'mgr-1' };

function executor(deps: Record<string, unknown>) {
  const none = {};
  return new ToolExecutorService(
    none as never,
    none as never,
    none as never,
    none as never,
    (deps.leadsService ?? none) as never,
    none as never,
    { record: jest.fn() } as never,
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
    none as never,
  );
}

describe('get_lead_score branch scoping', () => {
  it('pins a branch-scoped caller to the requested branch', async () => {
    // Scoped check passes, org-wide fails: leads.read is held for br-1 only.
    const hasPermission = jest.fn(
      async (_user: string, _org: string, _key: string, scope?: string) =>
        scope === 'br-1',
    );
    const getScore = jest.fn().mockResolvedValue({ leadId: 'lead-1' });
    await executor({
      permissions: { hasPermission },
      leadsService: { getScore },
    }).execute(
      'get_lead_score',
      { leadId: 'lead-1' },
      { ...context, requestedBranchId: 'br-1' },
    );
    expect(getScore).toHaveBeenCalledWith('org-1', 'lead-1', 'br-1');
  });

  it('leaves an org-wide caller unrestricted', async () => {
    const getScore = jest.fn().mockResolvedValue({ leadId: 'lead-1' });
    await executor({
      permissions: { hasPermission: jest.fn().mockResolvedValue(true) },
      leadsService: { getScore },
    }).execute(
      'get_lead_score',
      { leadId: 'lead-1' },
      { ...context, requestedBranchId: 'br-1' },
    );
    expect(getScore).toHaveBeenCalledWith('org-1', 'lead-1', null);
  });
});
