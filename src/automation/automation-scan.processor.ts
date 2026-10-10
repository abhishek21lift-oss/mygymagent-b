import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import type { InventoryLowEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { AutomationRunService } from './automation-run.service';
import { LeadFirstTouchScanner } from './scanners/lead-first-touch.scanner';
import { LeadFollowupScanner } from './scanners/lead-followup.scanner';
import { QrRotationScanner } from './scanners/qr-rotation.scanner';
import { MemberInactiveScanner } from './scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from './scanners/membership-renewal.scanner';
import { MembershipStatusScanner } from './scanners/membership-status.scanner';
import { PaymentOverdueScanner } from './scanners/payment-overdue.scanner';
import { InvoiceDunningScanner } from './scanners/invoice-dunning.scanner';
import { PtExpiryScanner } from './scanners/pt-expiry.scanner';
import { DataRetentionScanner } from './scanners/data-retention.scanner';
import { RiskEngineService } from '../member-intelligence/risk-engine.service';
import { ActionCenterService } from '../action-center/action-center.service';
import { CallAnalysisService } from '../action-center/call-analysis.service';
import { TaskGeneratorService } from '../action-center/task-generator.service';

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
    private readonly leadFirstTouchScanner: LeadFirstTouchScanner,
    private readonly qrRotationScanner: QrRotationScanner,
    private readonly invoiceDunningScanner: InvoiceDunningScanner,
    private readonly ptExpiryScanner: PtExpiryScanner,
    private readonly dataRetentionScanner: DataRetentionScanner,
    private readonly riskEngine: RiskEngineService,
    private readonly membershipStatusScanner: MembershipStatusScanner,
    private readonly taskGenerator: TaskGeneratorService,
    private readonly actionCenter: ActionCenterService,
    private readonly callAnalysis: CallAnalysisService,
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
      case JOB_NAMES.SCAN_LEAD_FIRST_TOUCH:
        return this.leadFirstTouchScanner.scan();
      case JOB_NAMES.ROTATE_QR_TOKENS:
        return this.qrRotationScanner.scan();
      case JOB_NAMES.SCAN_INVOICE_DUNNING:
        return this.invoiceDunningScanner.scan();
      case JOB_NAMES.SCAN_PT_EXPIRY:
        return this.ptExpiryScanner.scan(job.data.organizationId);
      // Scheduled daily from the start and never dispatched: with no case
      // here it fell through to `default`, logged "Unrecognized job name"
      // and did nothing, every day.
      case JOB_NAMES.SCAN_DATA_RETENTION:
        return this.dataRetentionScanner.scan();
      case JOB_NAMES.SCAN_MEMBERSHIP_STATUS:
        return this.membershipStatusScanner.scan();
      case JOB_NAMES.GENERATE_ACTION_TASKS:
        return this.taskGenerator.runAll();
      case JOB_NAMES.TASK_REMINDERS:
        return this.actionCenter.sweepReminders();
      case JOB_NAMES.ANALYZE_CALL_NOTE: {
        const data = job.data as { organizationId: string; callLogId: string };
        const attempts = job.opts.attempts ?? 1;
        return this.callAnalysis.run(
          data.organizationId,
          data.callLogId,
          job.attemptsMade + 1 >= attempts,
        );
      }
      case JOB_NAMES.SCAN_RISK_PROFILES:
        return this.scanRiskProfiles();
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
   * Rescores every live organization's active members.
   *
   * One organization failing must not cost the others their scores, so
   * each is caught on its own; the per-member errors inside a batch are
   * already absorbed by batchComputeRiskProfiles. Suspended and cancelled
   * gyms are skipped -- nobody is reading their dashboards.
   */
  private async scanRiskProfiles(): Promise<{
    organizations: number;
    processed: number;
    errors: number;
  }> {
    const organizations = await this.prisma.organization.findMany({
      where: { deletedAt: null, status: { in: ['TRIAL', 'ACTIVE'] } },
      select: { id: true },
    });
    let processed = 0;
    let errors = 0;
    for (const organization of organizations) {
      try {
        const result = await this.riskEngine.batchComputeRiskProfiles(
          organization.id,
        );
        processed += result.processed;
        errors += result.errors;
      } catch (error) {
        errors++;
        this.logger.warn(
          `Risk scoring failed for organization ${organization.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `Risk scoring: ${processed} members across ${organizations.length} organizations, ${errors} errors`,
    );
    return { organizations: organizations.length, processed, errors };
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

    // `User.email` is nullable since SMS login, and an alert has nowhere
    // to go without one. These are staff, who all have an address, so
    // this narrows the type without changing who gets told -- and an
    // empty string here would be a send that silently fails at the SMTP
    // layer instead.
    for (const recipient of recipients.filter((r): r is { email: string } =>
      Boolean(r.email),
    )) {
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
