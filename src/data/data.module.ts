import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { DataController } from './data.controller';
import { DataService } from './data.service';
import { CustomerEnquiryImportService } from './customer-enquiry-import.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';

@Module({
  imports: [PlatformBillingModule],
  controllers: [DataController],
  providers: [
    DataService,
    CustomerEnquiryImportService,
    TenantReferenceValidator,
  ],
  exports: [DataService, CustomerEnquiryImportService],
})
export class DataModule {}
