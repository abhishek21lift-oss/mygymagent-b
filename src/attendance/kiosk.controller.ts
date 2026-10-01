import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AttendanceService } from './attendance.service';
import { KioskCheckInDto, KioskSessionDto } from './dto/kiosk.dto';

/**
 * Self-service kiosk check-in.
 *
 * Lives in the attendance module rather than Business OS (B-P0-5): a kiosk
 * check-in is an attendance record, and while these endpoints sat
 * elsewhere they wrote to a parallel `kiosk_events` table that nothing
 * read, so kiosk entries never reached the live view, the reports or the
 * AttendanceRecorded event. The route keeps its original path so deployed
 * kiosks and the `/kiosk` frontend page do not have to change.
 *
 * Registration moved to `POST /devices` in B-P0-13: kiosks and biometric
 * turnstiles are one registry now, and issuing a turnstile key from a
 * route called `/kiosk/devices` would have been the last place the two
 * were still pretending to be different things.
 */
@Controller('kiosk')
export class KioskController {
  constructor(private readonly attendance: AttendanceService) {}

  /**
   * No JWT: the kiosk's device key IS the credential, the same way
   * `/devices/check-in` treats a turnstile key. Always answers 200 with a
   * gate decision so an unattended screen can render it; only an invalid
   * key is a 401.
   */
  @Post('check-in')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  checkIn(@Body() dto: KioskCheckInDto, @Req() req: Request) {
    // `req.ip`, which Express resolves through the one trusted proxy hop
    // (main.ts). The first X-Forwarded-For entry is whatever the caller
    // wrote there, so keying the limit on it let anyone reset their own
    // budget with every request.
    const clientKey = req.ip || 'unknown';
    return this.attendance.kioskCheckIn({
      deviceKey: dto.deviceKey,
      memberId: dto.memberId,
      memberCode: dto.memberCode,
      qrToken: dto.qrToken,
      clientKey,
    });
  }

  /**
   * The kiosk's identity -- device, branch and gym names -- for the
   * self-service screen. Same credential and same client key as
   * check-in, on its own rate-limit scope so a screen re-checking that it
   * is still connected never spends a member's check-in budget. A POST
   * because the key is a secret and belongs in a body, not a URL that
   * proxies log.
   */
  @Post('session')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  session(@Body() dto: KioskSessionDto, @Req() req: Request) {
    return this.attendance.kioskSession({
      deviceKey: dto.deviceKey,
      clientKey: req.ip || 'unknown',
    });
  }
}
