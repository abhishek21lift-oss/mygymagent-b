import { Module } from '@nestjs/common';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBillingService } from './platform-billing.service';

@Module({
  controllers: [PlatformBillingController],
  providers: [PlatformBillingService],
  exports: [PlatformBillingService],
})
export class PlatformBillingModule {}
