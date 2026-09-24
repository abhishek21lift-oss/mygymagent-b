import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  imports: [CommunicationsModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
