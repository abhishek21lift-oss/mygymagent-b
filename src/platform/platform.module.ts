import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { PlatformOrganizationsController } from './platform-organizations.controller';
import { PlatformOrganizationsService } from './platform-organizations.service';

@Module({
  imports: [PlatformBillingModule],
  controllers: [PlatformOrganizationsController],
  providers: [PlatformOrganizationsService],
})
export class PlatformModule {}
