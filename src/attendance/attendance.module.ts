import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { DevicesController } from './devices.controller';
import { KioskController } from './kiosk.controller';

@Module({
  // DevicesController was previously declared in no module at all, so
  // `/devices/check-in` did not exist at runtime even though the branches
  // UI hands admins a device key to point a scanner at (B-P0-5).
  controllers: [AttendanceController, DevicesController, KioskController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
