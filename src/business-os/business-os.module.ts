import { Module } from '@nestjs/common';
import { BusinessOsController } from './business-os.controller';
import { BusinessOsService } from './business-os.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { CommunicationsModule } from '../communications/communications.module';
import { AuditModule } from '../audit/audit.module';
@Module({
  imports:[AttendanceModule,CommunicationsModule,AuditModule],
  controllers:[BusinessOsController],
  providers:[BusinessOsService],
})
export class BusinessOsModule {}
