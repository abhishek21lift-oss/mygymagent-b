import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [PlatformBillingModule],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
