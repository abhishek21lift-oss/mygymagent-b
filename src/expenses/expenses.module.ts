import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/**
 * Gym-side spend tracking (rent, salaries, utilities, marketing,
 * equipment...). Lifecycle PENDING -> APPROVED -> PAID (REJECTED
 * terminal); PAID rows are immutable like Payment rows. Completes the
 * profit picture FinanceService's revenue side starts -- see
 * ExpensesService for the per-currency honesty rules.
 */
@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
