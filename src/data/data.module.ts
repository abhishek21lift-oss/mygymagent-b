import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { DataController } from './data.controller';
import { DataService } from './data.service';

@Module({
  controllers: [DataController],
  providers: [DataService],
  exports: [DataService],
})
export class DataModule {}
