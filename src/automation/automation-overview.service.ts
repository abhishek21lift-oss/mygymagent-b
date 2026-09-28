import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { AutomationKey } from '@prisma/client';
import type { Queue } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  JOB_NAMES,
  JOB_SCHEDULER_IDS,
  QUEUE_NAMES,
} from '../queue/queue.constants';

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

type Channel = 'email' | 'sms' | 'none';

interface ScannerDefinition {
  /** BullMQ job name, or null for the one that fires on an event. */
  job: string | null;
  schedulerId: string | null;
  /** The AutomationRun key its per-subject outcomes are recorded under.
   * Null for housekeeping jobs that act on no one. */
  key: AutomationKey | null;
  title: string;
  description: string;
  cadence: string;
  channel: Channel;
}

/**
 * Every job the automation queue runs, in the gym's words.
 *
 * Nine of these ran in production with no screen anywhere showing that
 * they existed, when they would run, or that the one chasing overdue
 * payments had failed every time it tried.
 */
export const SCANNERS: ScannerDefinition[] = [
  {
    job: JOB_NAMES.SCAN_PAYMENT_OVERDUE,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_PAYMENT_OVERDUE,
    key: 'PAYMENT_OVERDUE_REMINDER',
    title: 'Overdue payment reminders',
    description: 'Chases members whose membership is short-paid.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_MEMBERSHIP_RENEWALS,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_MEMBERSHIP_RENEWALS,
    key: 'MEMBERSHIP_RENEWAL_REMINDER',
    title: 'Renewal reminders',
    description: 'Tells members their membership is about to end.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_INVOICE_DUNNING,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_INVOICE_DUNNING,
    key: 'INVOICE_DUE_REMINDER',
    title: 'Unpaid invoice reminders',
    description: 'Follows up invoices that are due or past due.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_PT_EXPIRY,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_PT_EXPIRY,
    key: 'PT_EXPIRY_REMINDER',
    title: 'PT package expiry',
    description: 'Warns members before a PT package runs out.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_MEMBER_INACTIVE,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_MEMBER_INACTIVE,
    key: 'MEMBER_INACTIVE_RECOVERY',
    title: 'Win back inactive members',
    description:
      'Reaches out to members who have stopped coming in. Only those who gave marketing consent.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_LEAD_FIRST_TOUCH,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_LEAD_FIRST_TOUCH,
    key: 'LEAD_FIRST_TOUCH',
    title: 'First touch for new enquiries',
    description: 'Makes first contact with a new lead within minutes.',
    cadence: 'Every 5 minutes',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_LEAD_FOLLOWUPS_DUE,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_LEAD_FOLLOWUPS_DUE,
    key: 'LEAD_FOLLOWUP_REMINDER',
    title: 'Lead follow-up reminders',
    description: 'Reminds the assigned staff member when a follow-up is due.',
    cadence: 'Daily',
    channel: 'email',
  },
  {
    job: null,
    schedulerId: null,
    key: 'LOW_STOCK_ALERT',
    title: 'Low stock alerts',
    description:
      'Tells inventory managers the moment stock crosses its reorder level.',
    cadence: 'When stock runs low',
    channel: 'email',
  },
  {
    job: JOB_NAMES.SCAN_RISK_PROFILES,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_RISK_PROFILES,
    key: null,
    title: 'Churn risk scoring',
    description:
      'Rescores every active member so Member Intelligence is current.',
    cadence: 'Nightly',
    channel: 'none',
  },
  {
    job: JOB_NAMES.ROTATE_QR_TOKENS,
    schedulerId: JOB_SCHEDULER_IDS.ROTATE_QR_TOKENS,
    key: null,
    title: 'Check-in code rotation',
    description:
      'Replaces member check-in QR codes so an old screenshot stops working.',
    cadence: 'Weekly',
    channel: 'none',
  },
  {
    job: JOB_NAMES.SCAN_DATA_RETENTION,
    schedulerId: JOB_SCHEDULER_IDS.SCAN_DATA_RETENTION,
    key: null,
    title: 'Data retention',
    description:
      'Clears spent login tokens and audit entries older than a year.',
    cadence: 'Daily',
    channel: 'none',
  },
];

interface JobTiming {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunState: 'completed' | 'failed' | null;
}

@Injectable()
export class AutomationOverviewService {
  private readonly logger = new Logger(AutomationOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    @InjectQueue(QUEUE_NAMES.AUTOMATION) private readonly queue: Queue,
  ) {}

  async overview(organizationId: string) {
    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
    const channels = this.communications.channelReadiness();

    const [timings, grouped, failed, recent] = await Promise.all([
      this.jobTimings(),
      this.prisma.automationRun.groupBy({
        by: ['key', 'status'],
        where: { organizationId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.automationRun.findMany({
        where: { organizationId, status: 'FAILED', createdAt: { gte: since } },
        select: { key: true, detail: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.automationRun.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const outcomes = new Map<
      string,
      { SENT: number; SKIPPED: number; FAILED: number }
    >();
    for (const row of grouped) {
      const tally = outcomes.get(row.key) ?? { SENT: 0, SKIPPED: 0, FAILED: 0 };
      tally[row.status] = row._count._all;
      outcomes.set(row.key, tally);
    }

    const scanners = SCANNERS.map((scanner) => {
      const timing = scanner.job ? timings.get(scanner.job) : undefined;
      const tally = scanner.key ? outcomes.get(scanner.key) : undefined;
      // A reminder job can run on time and still reach nobody: it is only
      // as live as the channel under it.
      const channelReady =
        scanner.channel === 'none' ? true : channels[scanner.channel];
      return {
        job: scanner.job,
        key: scanner.key,
        title: scanner.title,
        description: scanner.description,
        cadence: scanner.cadence,
        channel: scanner.channel,
        channelReady,
        nextRunAt: timing?.nextRunAt ?? null,
        lastRunAt: timing?.lastRunAt ?? null,
        lastRunState: timing?.lastRunState ?? null,
        outcomes: tally ?? { SENT: 0, SKIPPED: 0, FAILED: 0 },
      };
    });

    return {
      windowDays: WINDOW_DAYS,
      channels,
      scanners,
      blockers: this.groupBlockers(failed),
      recent: await this.labelRecent(recent),
    };
  }

  /**
   * Why sends failed, grouped, so four identical "email is not configured"
   * rows read as one problem to fix rather than four to investigate.
   */
  private groupBlockers(
    failed: Array<{ key: AutomationKey; detail: unknown }>,
  ) {
    const byReason = new Map<
      string,
      { reason: string; count: number; keys: Set<string> }
    >();
    for (const row of failed) {
      const detail = (row.detail ?? {}) as { error?: unknown };
      const reason =
        typeof detail.error === 'string' && detail.error.trim()
          ? detail.error.trim()
          : 'Failed without a recorded reason';
      const entry = byReason.get(reason) ?? {
        reason,
        count: 0,
        keys: new Set(),
      };
      entry.count++;
      entry.keys.add(row.key);
      byReason.set(reason, entry);
    }
    return [...byReason.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({
        reason: entry.reason,
        count: entry.count,
        keys: [...entry.keys],
      }));
  }

  /**
   * Schedule and last outcome of each job, from BullMQ.
   *
   * Only timing and a completed/failed flag cross the tenant boundary:
   * each job scans every organization at once, so its return value and
   * failure message describe other gyms too and are not shown here.
   * Redis being unreachable degrades this to "unknown" rather than
   * failing the whole page.
   */
  private async jobTimings(): Promise<Map<string, JobTiming>> {
    const timings = new Map<string, JobTiming>();
    try {
      const [schedulers, completed, failedJobs] = await Promise.all([
        this.queue.getJobSchedulers(0, 100),
        this.queue.getJobs(['completed'], 0, 500),
        this.queue.getJobs(['failed'], 0, 500),
      ]);

      const schedulerNext = new Map<string, number>();
      for (const scheduler of schedulers) {
        if (scheduler.key && scheduler.next) {
          schedulerNext.set(scheduler.key, scheduler.next);
        }
      }

      const latest = new Map<
        string,
        { at: number; state: 'completed' | 'failed' }
      >();
      const consider = (
        job: { name: string; finishedOn?: number },
        state: 'completed' | 'failed',
      ) => {
        if (!job.finishedOn) return;
        const current = latest.get(job.name);
        if (!current || job.finishedOn > current.at) {
          latest.set(job.name, { at: job.finishedOn, state });
        }
      };
      for (const job of completed) if (job) consider(job, 'completed');
      for (const job of failedJobs) if (job) consider(job, 'failed');

      for (const scanner of SCANNERS) {
        if (!scanner.job) continue;
        const next = scanner.schedulerId
          ? schedulerNext.get(scanner.schedulerId)
          : undefined;
        const last = latest.get(scanner.job);
        timings.set(scanner.job, {
          nextRunAt: next ? new Date(next).toISOString() : null,
          lastRunAt: last ? new Date(last.at).toISOString() : null,
          lastRunState: last?.state ?? null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Could not read the automation queue: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return timings;
  }

  /** Attaches who each run was about, resolved in one query per kind. */
  private async labelRecent(
    rows: Array<{
      id: string;
      key: AutomationKey;
      subjectId: string;
      status: string;
      detail: unknown;
      createdAt: Date;
      organizationId: string;
    }>,
  ) {
    const ids = (keys: AutomationKey[]) => [
      ...new Set(
        rows.filter((r) => keys.includes(r.key)).map((r) => r.subjectId),
      ),
    ];
    const organizationId = rows[0]?.organizationId;
    if (!organizationId) return [];

    const name = (
      m: { firstName: string; lastName: string } | null | undefined,
    ) => (m ? `${m.firstName} ${m.lastName}`.trim() : null);

    const [
      memberships,
      members,
      leads,
      followUps,
      packages,
      invoices,
      products,
    ] = await Promise.all([
      this.prisma.membership.findMany({
        where: {
          organizationId,
          id: {
            in: ids([
              'MEMBERSHIP_RENEWAL_REMINDER',
              'PAYMENT_OVERDUE_REMINDER',
            ]),
          },
        },
        select: {
          id: true,
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.member.findMany({
        where: {
          organizationId,
          id: { in: ids(['MEMBER_INACTIVE_RECOVERY']) },
        },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.lead.findMany({
        where: { organizationId, id: { in: ids(['LEAD_FIRST_TOUCH']) } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.leadFollowUp.findMany({
        where: { organizationId, id: { in: ids(['LEAD_FOLLOWUP_REMINDER']) } },
        select: {
          id: true,
          lead: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.ptPackage.findMany({
        where: { organizationId, id: { in: ids(['PT_EXPIRY_REMINDER']) } },
        select: {
          id: true,
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, id: { in: ids(['INVOICE_DUE_REMINDER']) } },
        select: {
          id: true,
          number: true,
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.product.findMany({
        where: { organizationId, id: { in: ids(['LOW_STOCK_ALERT']) } },
        select: { id: true, name: true },
      }),
    ]);

    const labels = new Map<
      string,
      { label: string | null; memberId: string | null }
    >();
    for (const m of memberships)
      labels.set(m.id, {
        label: name(m.member),
        memberId: m.member?.id ?? null,
      });
    for (const m of members)
      labels.set(m.id, { label: name(m), memberId: m.id });
    for (const l of leads) labels.set(l.id, { label: name(l), memberId: null });
    for (const f of followUps)
      labels.set(f.id, { label: name(f.lead), memberId: null });
    for (const p of packages)
      labels.set(p.id, {
        label: name(p.member),
        memberId: p.member?.id ?? null,
      });
    for (const i of invoices)
      labels.set(i.id, {
        label: [i.number, name(i.member)].filter(Boolean).join(' · ') || null,
        memberId: i.member?.id ?? null,
      });
    for (const p of products)
      labels.set(p.id, { label: p.name, memberId: null });

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      status: row.status,
      detail: row.detail,
      createdAt: row.createdAt,
      subjectId: row.subjectId,
      subjectLabel: labels.get(row.subjectId)?.label ?? null,
      memberId: labels.get(row.subjectId)?.memberId ?? null,
    }));
  }
}
