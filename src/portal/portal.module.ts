import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { CommunicationsModule } from '../communications/communications.module';
import { ClassesModule } from '../classes/classes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  imports: [
    AttendanceModule,
    CommunicationsModule,
    ClassesModule,
    NotificationsModule,
  ],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
