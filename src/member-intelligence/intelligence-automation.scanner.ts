import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RiskEngineService } from './risk-engine.service';

@Injectable()
export class IntelligenceAutomationScanner {
  private readonly logger = new Logger(IntelligenceAutomationScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly riskEngine: RiskEngineService,
  ) {}

  async runDailyRiskComputation(): Promise<{
    processed: number;
    errors: number;
    duration: number;
  }> {
    const startTime = Date.now();
    const organizations = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let totalProcessed = 0;
    let totalErrors = 0;

    for (const org of organizations) {
      const result = await this.riskEngine.batchComputeRiskProfiles(org.id);
      totalProcessed += result.processed;
      totalErrors += result.errors;
    }

    const duration = Date.now() - startTime;

    this.logger.log(
      `Daily risk computation: ${totalProcessed} profiles processed, ${totalErrors} errors in ${duration}ms across ${organizations.length} organizations`,
    );

    return { processed: totalProcessed, errors: totalErrors, duration };
  }

  async recomputeMemberRisk(
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    await this.riskEngine.computeRiskProfile(organizationId, memberId);
  }
}
