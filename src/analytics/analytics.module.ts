import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { FinanceService } from './finance.service';

/**
 * First real capability: the Revenue & Finance intelligence layer (P1) --
 * see README.md for what's built vs. deliberately not (member/sales/
 * trainer/inventory intelligence are P2 scope; still empty here).
 */
@Module({
  controllers: [AnalyticsController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class AnalyticsModule {}
