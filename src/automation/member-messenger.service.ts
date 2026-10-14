import { Injectable } from '@nestjs/common';
import type { AutomationKey, MessageCategory, Prisma } from '@prisma/client';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationRunService } from './automation-run.service';
import {
  DEFAULT_RUN_AT,
  isDueAt,
  resolveAutomationTimezone,
} from './automation-schedule.helper';

type Outcome = 'SENT' | 'SKIPPED' | 'FAILED' | 'COOLDOWN' | 'NO_CHANNEL';

export interface Delivery {
  outcome: Outcome;
  /** The channel the final attempt used, or null when there was none. */
  channel: 'WHATSAPP' | 'EMAIL' | null;
}

export interface MemberAutomationMessage {
  organizationId: string;
  key: AutomationKey;
  /** The membership / package / invoice this message is about. */
  subjectId: string;
  cooldownDays: number;
  member: { id: string; email: string | null; phone: string | null };
  whatsapp?: {
    templateKey: string;
    variables: Record<string, string>;
    category?: MessageCategory;
    /** Separates messages about the same subject that must each go once,
     * e.g. the 7-, 3- and 1-day renewal reminders. */
    stage?: string;
    /** Cooldown for this stage, when it differs from the email's. */
    cooldownDays?: number;
  };
  /** The existing email send, used when WhatsApp is not an option. */
  email?: () => Promise<{ status: string }>;
  detail?: Record<string, unknown>;
}

/**
 * How an automation reaches a member: on WhatsApp when the gym has linked
 * its own number and turned sending on, otherwise -- or if the WhatsApp
 * attempt fails -- by email, as before.
 *
 * One channel, not both: a member should get one renewal reminder, not
 * the same one twice. The two channels keep separate cooldowns (the
 * WhatsApp run is recorded under `<subjectId>:whatsapp[:stage]`), so a
 * failed WhatsApp send never uses up the email's turn, and vice versa.
 *
 * Only the gym's own linked number counts as "WhatsApp is available"
 * here. The Meta Cloud API only delivers business-initiated messages as
 * pre-approved templates, and these automations send text; routing them
 * there would fail every time outside a 24-hour customer window.
 */
@Injectable()
export class MemberMessenger {
  private readonly readiness = new Map<
    string,
    { ready: boolean; at: number }
  >();
  /** Control Center toggles, per gym+key. No row means enabled. */
  private readonly toggles = new Map<
    string,
    { enabled: boolean; runAt: string | null; at: number }
  >();
  /** Resolved timezones, per gym. Profile wins over the org row. */
  private readonly timezones = new Map<
    string,
    { timezone: string; at: number }
  >();

  constructor(
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
    private readonly prisma: PrismaService,
  ) {}

  /** Whether this gym's automations should go on WhatsApp right now.
   * Cached for a minute: a scan asks once per member. */
  async whatsappReady(organizationId: string): Promise<boolean> {
    const cached = this.readiness.get(organizationId);
    if (cached && Date.now() - cached.at < 60_000) return cached.ready;
    const ready =
      await this.communications.ownWhatsappNumberReady(organizationId);
    this.readiness.set(organizationId, { ready, at: Date.now() });
    return ready;
  }

  /** The Control Center toggle for one gym+key. Cached for a minute like
   * the WhatsApp check above: a scan asks once per member. */
  async automationEnabled(
    organizationId: string,
    key: AutomationKey,
  ): Promise<boolean> {
    return (await this.settingFor(organizationId, key)).enabled;
  }

  private async settingFor(
    organizationId: string,
    key: AutomationKey,
  ): Promise<{ enabled: boolean; runAt: string | null }> {
    const cacheKey = `${organizationId}:${key}`;
    const cached = this.toggles.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000)
      return { enabled: cached.enabled, runAt: cached.runAt };
    const row = await this.prisma.automationSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { enabled: true, runAt: true },
    });
    const setting = {
      enabled: row?.enabled ?? true,
      runAt: row?.runAt ?? null,
    };
    this.toggles.set(cacheKey, { ...setting, at: Date.now() });
    return setting;
  }

  private async timezoneFor(
    organizationId: string,
    organizationTimezone?: string | null,
  ): Promise<string> {
    const cached = this.timezones.get(organizationId);
    if (cached && Date.now() - cached.at < 60_000) return cached.timezone;
    let profileTimezone: string | null = null;
    let orgTimezone: string | null = organizationTimezone ?? null;
    try {
      const [profile, organization] = await Promise.all([
        this.prisma.whatsappAutomationProfile.findUnique({
          where: { organizationId },
          select: { timezone: true },
        }),
        orgTimezone
          ? null
          : this.prisma.organization.findUnique({
              where: { id: organizationId },
              select: { timezone: true },
            }),
      ]);
      profileTimezone = profile?.timezone ?? null;
      orgTimezone = orgTimezone ?? organization?.timezone ?? null;
    } catch {
      // A preferences lookup must never stop a reminder.
    }
    const timezone = resolveAutomationTimezone(profileTimezone, orgTimezone);
    this.timezones.set(organizationId, { timezone, at: Date.now() });
    return timezone;
  }

  /**
   * Whether the hourly tick should process this gym+key now: the saved
   * (or default) execution time matches the gym-local hour. Scanners
   * check this per organization before touching that org's rows; the
   * per-member toggle check in deliver() still applies at send time.
   */
  async sendWindowOpen(
    organizationId: string,
    key: AutomationKey,
    organizationTimezone?: string | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const setting = await this.settingFor(organizationId, key);
    if (!setting.enabled) return false;
    const runAt = setting.runAt ?? DEFAULT_RUN_AT[key] ?? null;
    if (!runAt) return true;
    const timezone = await this.timezoneFor(
      organizationId,
      organizationTimezone,
    );
    return isDueAt(timezone, runAt, now);
  }

  async deliver(message: MemberAutomationMessage): Promise<Delivery> {
    const { organizationId, key, subjectId, member, whatsapp } = message;

    // The Control Center's master switch, checked before any WhatsApp or
    // email attempt: a disabled key sends nothing and records why.
    // channelOverride / quietHours / cooldownDays are stored, not
    // enforced yet -- the quiet-hours task reads them, not this path.
    if (!(await this.automationEnabled(organizationId, key))) {
      await this.prisma.automationRun.create({
        data: {
          organizationId,
          key,
          subjectId,
          status: 'SKIPPED',
          detail: {
            ...message.detail,
            disabled: true,
          } as Prisma.InputJsonValue,
        },
      });
      return { outcome: 'SKIPPED', channel: null };
    }

    if (
      whatsapp &&
      member.phone &&
      (await this.whatsappReady(organizationId))
    ) {
      const outcome = await this.runs.attempt(
        organizationId,
        key,
        [subjectId, 'whatsapp', whatsapp.stage].filter(Boolean).join(':'),
        whatsapp.cooldownDays ?? message.cooldownDays,
        () =>
          this.communications.send({
            organizationId,
            channel: 'WHATSAPP',
            category: whatsapp.category ?? 'TRANSACTIONAL',
            templateKey: whatsapp.templateKey,
            recipient: member.phone as string,
            memberId: member.id,
            variables: whatsapp.variables,
          }),
        { ...message.detail, channel: 'WHATSAPP', stage: whatsapp.stage },
      );
      // Anything but a failure is settled: sent, queued, or already done
      // recently. A failure falls through to email.
      if (outcome !== 'FAILED') return { outcome, channel: 'WHATSAPP' };
    }

    if (message.email && member.email) {
      const outcome = await this.runs.attempt(
        organizationId,
        key,
        subjectId,
        message.cooldownDays,
        message.email,
        message.detail,
      );
      return { outcome, channel: 'EMAIL' };
    }
    return { outcome: 'NO_CHANNEL', channel: null };
  }
}
