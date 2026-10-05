import 'reflect-metadata';
import { SalesIntelligenceService } from './sales-intelligence.service';

const DAY = 24 * 60 * 60 * 1000;

function lead(
  id: string,
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'TRIAL' | 'WON' | 'LOST',
  createdOffsetDays: number,
  followUps: { dueAt: Date; completedAt: null }[] = [],
) {
  return {
    id,
    firstName: 'A',
    lastName: 'B',
    source: 'Walk-in',
    status,
    createdAt: new Date(Date.now() - createdOffsetDays * DAY),
    followUps,
  };
}

describe('SalesIntelligenceService.getSalesPriority', () => {
  it('ranks overdue first with evidence, then warm, then watch', async () => {
    const now = Date.now();
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      lead: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            lead('watch-old', 'CONTACTED', 40),
            lead('warm-fresh', 'NEW', 1),
            lead('warm-qualified', 'QUALIFIED', 20),
            lead('hot-overdue', 'CONTACTED', 10, [
              { dueAt: new Date(now - 2 * DAY), completedAt: null },
            ]),
            lead('hot-today', 'NEW', 5, [
              { dueAt: new Date(now - 60 * 60 * 1000), completedAt: null },
            ]),
          ]),
      },
    };
    const service = new SalesIntelligenceService(prisma as never);
    const result = await service.getSalesPriority('org-1', null);
    // Closed business never enters the queue — enforced in the query.
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL'] },
        }),
      }),
    );
    expect(
      result.items
        .slice(0, 2)
        .map((i) => i.leadId)
        .sort(),
    ).toEqual(['hot-overdue', 'hot-today'].sort());
    expect(result.items.find((i) => i.leadId === 'hot-overdue')).toMatchObject({
      severity: 'hot',
      overdueFollowUps: 1,
    });
    expect(
      result.items.find((i) => i.leadId === 'hot-overdue')?.reasons[0],
    ).toMatch(/overdue by \d+ days?/);
    expect(result.items.find((i) => i.leadId === 'warm-fresh')?.severity).toBe(
      'warm',
    );
    expect(
      result.items.find((i) => i.leadId === 'warm-qualified')?.reasons,
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/no follow-up scheduled/)]),
    );
    expect(result.items.find((i) => i.leadId === 'watch-old')?.severity).toBe(
      'watch',
    );
    expect(result.counts).toEqual({ hot: 2, warm: 2, watch: 1 });
  });
});
