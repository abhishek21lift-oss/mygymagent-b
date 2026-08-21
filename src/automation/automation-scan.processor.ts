import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import type { InventoryLowEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { AutomationRunService } from './automation-run.service';
import { LeadFollowupScanner } from './scanners/lead-followup.scanner';
import { MemberInactiveScanner } from './scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from './scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from './scanners/payment-overdue.scanner';

const LOW_STOCK_COOLDOWN_DAYS = 1;

/**
 * One processor for the whole `automation` queue, same pattern as
 * WelcomeEmailProcessor on `notifications` -- switches on `job.name`
 * rather than one processor per job type, since `@nestjs/bullmq`'s
 * `@Processor` decorator binds to a queue, not a job name.
 */
@Processor(QUEUE_NAMES.AUTOMATION)
export class AutomationScanProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationScanProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
    private readonly membershipRenewalScanner: MembershipRenewalScanner,
    private readonly paymentOverdueScanner: PaymentOverdueScanner,
    private readonly memberInactiveScanner: MemberInactiveScanner,
    private readonly leadFollowupScanner: LeadFollowupScanner,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_NAMES.SCAN_MEMBERSHIP_RENEWALS:
        return this.membershipRenewalScanner.scan();
      case JOB_NAMES.SCAN_PAYMENT_OVERDUE:
        return this.paymentOverdueScanner.scan();
      case JOB_NAMES.SCAN_MEMBER_INACTIVE:
        return this.memberInactiveScanner.scan();
      case JOB_NAMES.SCAN_LEAD_FOLLOWUPS_DUE:
        return this.leadFollowupScanner.scan();
      case JOB_NAMES.SEND_LOW_STOCK_ALERT:
        return this.sendLowStockAlert(job.data as InventoryLowEvent);
      default:
        this.logger.warn(
          `Unrecognized job name on automation queue: ${job.name}`,
        );
        return undefined;
    }
  }

  /**
   * Recipients are every user in the org holding `inventory.manage`
   * through a role grant, org-wide or at any branch -- Product isn't
   * branch-scoped in this schema (see Product model comment), so there's
   * no branch to scope the search to. Known simplification: doesn't
   * account for a per-user DENY override on `inventory.manage`
   * (UserPermissionOverride) the way PermissionsService.hasPermission()
   * does for a live request -- acceptable here since worst case is one
   * extra recipient on an internal stock alert, not a security decision.
   */
  private async sendLowStockAlert(event: InventoryLowEvent): Promise<void> {
    const recipients = await this.prisma.user.findMany({
      where: {
        organizationId: event.organizationId,
        deletedAt: null,
        userRoles: {
          some: {
            role: {
              rolePermissions: {
                some: { permission: { key: 'inventory.manage' } },
              },
            },
          },
        },
      },
      select: { email: true },
    });

    for (const recipient of recipients) {
      await this.runs.attempt(
        event.organizationId,
        'LOW_STOCK_ALERT',
        `${event.productId}:${recipient.email}`,
        LOW_STOCK_COOLDOWN_DAYS,
        () =>
          this.communications.sendLowStockAlert(
            event.organizationId,
            recipient.email,
            {
              productName: event.name,
              sku: event.sku,
              quantityOnHand: String(event.quantityOnHand),
              reorderLevel: String(event.reorderLevel),
            },
          ),
        { productId: event.productId, quantityOnHand: event.quantityOnHand },
      );
    }
  }
}
