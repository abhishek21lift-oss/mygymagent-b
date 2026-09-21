import { Module } from '@nestjs/common';
import { HrPayrollController } from './hr-payroll.controller';
import { HrPayrollService } from './hr-payroll.service';

@Module({
  controllers: [HrPayrollController],
  providers: [HrPayrollService],
  exports: [HrPayrollService],
})
export class HrPayrollModule {}
