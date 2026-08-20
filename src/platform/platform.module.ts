import { Module } from '@nestjs/common';
import { PlatformOrganizationsController } from './platform-organizations.controller';
import { PlatformOrganizationsService } from './platform-organizations.service';

@Module({
  controllers: [PlatformOrganizationsController],
  providers: [PlatformOrganizationsService],
})
export class PlatformModule {}
