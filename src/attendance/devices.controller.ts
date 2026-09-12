import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { AttendanceService } from './attendance.service';
import { DeviceCheckInDto } from './dto/device-check-in.dto';

/**
 * Biometric turnstile ingest. No JWT -- the branch `deviceKey` body field
 * IS the credential (timing-safe compared server-side). Always answers
 * 200 with a gate decision (devices retry on non-200); only an invalid
 * deviceKey itself is a 401.
 */
@Controller('devices')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class DevicesController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('check-in')
  @Public()
  @HttpCode(200)
  deviceCheckIn(@Body() dto: DeviceCheckInDto) {
    return this.attendance.deviceCheckIn(dto);
  }
}
