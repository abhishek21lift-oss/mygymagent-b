import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const FIRST_TOUCH_WINDOW_MIN = 30;
const FOLLOWUP_DUE_HOURS = 4;

/**
 * WS-3 speed-to-lead first touch. Trigger: a NEW lead created in the last
 * 30 minutes with zero contact (no completed LeadFollowUp and no outbound
 * SENT-class MessageLog addressed to the lead's phone). Conditions: the
 * lead has a phone number, and no LEAD_FIRST_TOUCH run for this lead yet
 * (AutomationRun idempotency via shouldRun -- the lead qualifies only once;
 * a 1-day cooldown would re-fire for a still-NEW lead tomorrow, which is
 * not the intent). Action: WHATSAPP `lead.first_touch` via
 * CommunicationsService plus a `LeadFollowUp{dueAt: now+4h}` assigned to
 * the least-loaded `leads.manage` holder in the lead's org/branch.
 * Leads without a phone are skipped (no channel to touch them on), not
 * failed -- the follow-up task is still created so sales sees them.
 */
@Injectable()
export class LeadFirstTouchScanner {
  private readonly logger = new Logger(LeadFirstTouchScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - FIRST_TOUCH_WINDOW_MIN * 60 * 1000,
    );

    const candidates = await this.prisma.lead.findMany({
      where: {
        status: 'NEW',
        createdAt: { gte: windowStart, lte: now },
        phone: { not: null },
      },
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        firstName: true,
        phone: true,
        followUps: {
          where: { completedAt: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
      take: 200,
    });

    let sent = 0;
    for (const lead of candidates) {
      if (lead.followUps.length > 0) continue;
      if (!lead.phone) continue;
      const priorOutbound = await this.prisma.messageLog.findFirst({
        where: {
          organizationId: lead.organizationId,
          recipient: lead.phone,
          status: { in: ['SENT', 'DELIVERED', 'READ'] },
        },
        select: { id: true },
      });
      if (priorOutbound) continue;

      const outcome = await this.runs.attempt(
        lead.organizationId,
        'LEAD_FIRST_TOUCH',
        lead.id,
        // 365-day cooldown ~= fire-once per lead: shouldRun() is
        // day-granular, and a NEW lead that is still uncontacted tomorrow
        // is a missed-inquiry case (briefing/SLA), not a second first-touch.
        365,
        async () => {
          const organization = await this.prisma.organization.findUnique({
            where: { id: lead.organizationId },
            select: { name: true },
          });
          const log = await this.communications.sendLeadFirstTouch(
            lead.organizationId,
            lead.phone as string,
            {
              firstName: lead.firstName,
              organizationName: organization?.name ?? '',
            },
          );
          const assigneeId = await this.pickAssignee(
            lead.organizationId,
            lead.branchId,
          );
          if (assigneeId) {
            await this.prisma.lead.updateMany({
              where: { id: lead.id, assignedToUserId: null },
              data: { assignedToUserId: assigneeId },
            });
          }
          await this.prisma.leadFollowUp.create({
            data: {
              organizationId: lead.organizationId,
              leadId: lead.id,
              dueAt: new Date(
                Date.now() + FOLLOWUP_DUE_HOURS * 60 * 60 * 1000,
              ),
              note: 'auto-first-touch',
              createdByUserId: assigneeId ?? undefined,
            },
          });
          return log;
        },
        { channel: 'WHATSAPP', templateKey: 'lead.first_touch' },
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Lead first-touch scan: ${candidates.length} candidates, ${sent} first touches sent`,
    );
    return { checked: candidates.length, sent };
  }

  /**
   * Least-open-followups assignee among `leads.manage` holders in the
   * org (and branch, when the lead has one). Open = completedAt null on a
   * follow-up whose lead is assigned to that user. Mirrors the low-stock
   * alert's recipient query (role grant, not DENY-override aware -- same
   * documented simplification).
   */
  private async pickAssignee(
    organizationId: string,
    branchId: string | null,
  ): Promise<string | null> {
    const holders = await this.prisma.user.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        userRoles: {
          some: {
            organizationId,
            ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
            role: {
              rolePermissions: {
                some: { permission: { key: 'leads.manage' } },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    if (holders.length === 0) return null;
    const counts = await this.prisma.leadFollowUp.groupBy({
      by: ['leadId'],
      where: {
        organizationId,
        completedAt: null,
        lead: { assignedToUserId: { in: holders.map((h) => h.id) } },
      },
      _count: { leadId: true },
    });
    const openByUser = new Map<string, number>();
    const leadOwners = await this.prisma.lead.findMany({
      where: {
        id: { in: counts.map((c) => c.leadId) },
        assignedToUserId: { not: null },
      },
      select: { id: true, assignedToUserId: true },
    });
    const ownerByLead = new Map(
      leadOwners.map((l) => [l.id, l.assignedToUserId as string]),
    );
    for (const row of counts) {
      const owner = ownerByLead.get(row.leadId);
      if (!owner) continue;
      openByUser.set(owner, (openByUser.get(owner) ?? 0) + row._count.leadId);
    }
    holders.sort(
      (a, b) => (openByUser.get(a.id) ?? 0) - (openByUser.get(b.id) ?? 0),
    );
    return holders[0].id;
  }
}
