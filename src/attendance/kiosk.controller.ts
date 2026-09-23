import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AttendanceService } from './attendance.service';
import { KioskCheckInDto, RegisterKioskDto } from './dto/kiosk.dto';

/**
 * Self-service kiosk check-in.
 *
 * Lives in the attendance module rather than Business OS (B-P0-5): a kiosk
 * check-in is an attendance record, and while these endpoints sat
 * elsewhere they wrote to a parallel `kiosk_events` table that nothing
 * read, so kiosk entries never reached the live view, the reports or the
 * AttendanceRecorded event. The routes keep their original paths so
 * deployed kiosks and the `/kiosk` frontend page do not have to change.
 */
@Controller('kiosk')
export class KioskController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('devices')
  @RequirePermissions('kiosk.manage')
  @Audited({ resource: 'kiosk_device', action: 'created' })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterKioskDto,
  ) {
    return this.attendance.registerKioskDevice(user.organizationId!, dto);
  }

  /**
   * No JWT: the kiosk's device key IS the credential, the same way
   * `/devices/check-in` treats a branch key. Always answers 200 with a
   * gate decision so an unattended screen can render it; only an invalid
   * key is a 401.
   */
  @Post('check-in')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  checkIn(@Body() dto: KioskCheckInDto, @Req() req: Request) {
    const forwarded = req.headers['x-forwarded-for'];
    const clientKey =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]) ||
      req.ip ||
      'unknown';
    return this.attendance.kioskCheckIn({
      deviceKey: dto.deviceKey,
      memberId: dto.memberId,
      clientKey,
    });
  }
}
