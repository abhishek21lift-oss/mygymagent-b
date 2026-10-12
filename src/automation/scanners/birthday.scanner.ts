import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runningOrganization } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';
import { resolveAutomationTimezone } from '../automation-schedule.helper';
import { WhatsappProfileService } from '../whatsapp-profile.service';

/** Birthday greetings go once per member per year. */
const COOLDOWN_DAYS = 365;

/**
 * Trigger: an ACTIVE member's `dateOfBirth` falls on today's month/day
 * in the gym's timezone. Conditions: the gym's BIRTHDAY_WISH switch is
 * on and the hourly tick lands in the gym's 04:00 window; the member
 * has a phone and the gym's WhatsApp number is linked. Birthday
 * greetings are WhatsApp-only (no email fallback -- a birthday email
 * from the gym is a change the gym should ask for, not find).
 * Idempotency: subject `<memberId>:<year>` with a 365-day cooldown.
 */
@Injectable()
export class BirthdayScanner {
  private readonly logger = new Logger(BirthdayScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messenger: MemberMessenger,
    private readonly profiles: WhatsappProfileService,
  ) {}

  async scan(
    now: Date = new Date(),
  ): Promise<{ checked: number; sent: number }> {
    const members = await this.prisma.member.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        dateOfBirth: { not: null },
        phone: { not: null },
        organization: runningOrganization,
      },
      select: {
        id: true,
        organizationId: true,
        firstName: true,
        phone: true,
        dateOfBirth: true,
        organization: { select: { name: true, timezone: true } },
      },
    });

    const windows = new Map<string, boolean>();
    const timezones = new Map<string, string>();
    const timezoneFor = async (
      organizationId: string,
      organizationTimezone: string,
    ): Promise<string> => {
      let timezone = timezones.get(organizationId);
      if (!timezone) {
        const profile = await this.profiles.get(organizationId);
        timezone = resolveAutomationTimezone(
          profile.timezone,
          organizationTimezone,
        );
        timezones.set(organizationId, timezone);
      }
      return timezone;
    };
    const isDue = async (
      organizationId: string,
      organizationTimezone: string,
    ): Promise<boolean> => {
      let due = windows.get(organizationId);
      if (due === undefined) {
        due = await this.messenger.sendWindowOpen(
          organizationId,
          'BIRTHDAY_WISH',
          await timezoneFor(organizationId, organizationTimezone),
          now,
        );
        windows.set(organizationId, due);
      }
      return due;
    };

    const monthDay = (d: Date, timezone: string) => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: '2-digit',
        timeZone: timezone,
      }).formatToParts(d);
      return {
        month: Number(parts.find((p) => p.type === 'month')?.value),
        day: Number(parts.find((p) => p.type === 'day')?.value),
      };
    };

    let checked = 0;
    let sent = 0;
    for (const member of members) {
      if (!member.dateOfBirth) continue;
      const timezone = await timezoneFor(
        member.organizationId,
        member.organization.timezone,
      );
      // Birthdays recur yearly: the gym-local month/day of the stored
      // date must match the gym-local month/day of today.
      let isToday = false;
      try {
        const dob = monthDay(member.dateOfBirth, timezone);
        const today = monthDay(now, timezone);
        isToday = dob.month === today.month && dob.day === today.day;
      } catch {
        continue;
      }
      if (!isToday) continue;
      if (!(await isDue(member.organizationId, member.organization.timezone)))
        continue;
      checked++;
      const year = now.getUTCFullYear();
      const { outcome } = await this.messenger.deliver({
        organizationId: member.organizationId,
        key: 'BIRTHDAY_WISH',
        subjectId: `${member.id}:${year}`,
        cooldownDays: COOLDOWN_DAYS,
        member: { id: member.id, email: null, phone: member.phone },
        whatsapp: {
          templateKey: 'birthday',
          variables: {
            '1': member.firstName,
            '2': member.organization.name,
          },
        },
        detail: { year },
      });
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Birthday scan: ${checked} birthdays today, ${sent} greetings sent`,
    );
    return { checked, sent };
  }
}
