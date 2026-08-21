import { Injectable, Logger } from '@nestjs/common';
import type { AutomationKey, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface SendResult {
  status: string;
}

/**
 * The Audit half of Trigger -> Conditions -> Action -> Audit, and the
 * idempotency guard that keeps a daily scan from re-notifying about the
 * same still-true condition every single day. See
 * src/automation/README.md for the full shape this implements.
 */
@Injectable()
export class AutomationRunService {
  private readonly logger = new Logger(AutomationRunService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** True if `key`+`subjectId` hasn't produced an AutomationRun within
   * `cooldownDays` -- called before attempting a send so a membership
   * that's "expiring in 7 days" doesn't get re-reminded on days 6, 5, 4... */
  private async shouldRun(
    organizationId: string,
    key: AutomationKey,
    subjectId: string,
    cooldownDays: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.automationRun.findFirst({
      where: { organizationId, key, subjectId, createdAt: { gte: since } },
      select: { id: true },
    });
    return !recent;
  }

  /**
   * Runs `action` (a `CommunicationsService.send*` call) for one subject
   * entity if it isn't in cooldown, records the outcome as an
   * AutomationRun row, and never lets a single subject's failure (a bad
   * email address, a template bug) abort the rest of the scan -- the
   * caller's loop keeps going regardless of what this returns.
   */
  async attempt(
    organizationId: string,
    key: AutomationKey,
    subjectId: string,
    cooldownDays: number,
    action: () => Promise<SendResult>,
    detail?: Record<string, unknown>,
  ): Promise<'SENT' | 'SKIPPED' | 'FAILED' | 'COOLDOWN'> {
    if (!(await this.shouldRun(organizationId, key, subjectId, cooldownDays))) {
      return 'COOLDOWN';
    }
    try {
      const result = await action();
      const status =
        result.status === 'SKIPPED_NO_CONSENT' ? 'SKIPPED' : 'SENT';
      await this.prisma.automationRun.create({
        data: {
          organizationId,
          key,
          subjectId,
          status,
          detail: detail as Prisma.InputJsonValue | undefined,
        },
      });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${key} failed for ${subjectId}: ${message}`);
      await this.prisma.automationRun.create({
        data: {
          organizationId,
          key,
          subjectId,
          status: 'FAILED',
          detail: { ...detail, error: message },
        },
      });
      return 'FAILED';
    }
  }
}
