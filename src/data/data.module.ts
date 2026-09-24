import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { DataController } from './data.controller';
import { DataService } from './data.service';
import { CustomerEnquiryImportService } from './customer-enquiry-import.service';

@Module({
  imports: [PlatformBillingModule],
  controllers: [DataController],
  providers: [DataService, CustomerEnquiryImportService],
  exports: [DataService, CustomerEnquiryImportService],
})
export class DataModule {}
