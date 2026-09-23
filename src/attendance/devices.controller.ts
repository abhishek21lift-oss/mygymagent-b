import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AttendanceService } from './attendance.service';
import { DeviceCheckInDto } from './dto/device-check-in.dto';
import { ListDevicesQueryDto, RegisterDeviceDto } from './dto/kiosk.dto';

/**
 * The device registry, and the biometric turnstile's ingest route.
 *
 * B-P0-13 moved the turnstile off `Branch.deviceKey` -- one plaintext
 * secret per branch, shared by every scanner, which nothing in the API
 * could ever set -- onto the same hashed, per-device registry the kiosk
 * already used. Registration, listing and revocation live here rather
 * than under `/kiosk`, because a turnstile is not a kiosk and there is
 * now one registry for both.
 */
@Controller('devices')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class DevicesController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @RequirePermissions('kiosk.manage')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDevicesQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.attendance.listDevices(
      user.organizationId!,
      query,
      branchScope,
    );
  }

  @Post()
  @RequirePermissions('kiosk.manage')
  @Audited({ resource: 'kiosk_device', action: 'created' })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.attendance.registerDevice(user.organizationId!, dto);
  }

  /**
   * Revoke, not delete: the check-ins this device recorded stay
   * attributable to it. `POST .../revoke` rather than `DELETE` for
   * exactly that reason -- the row survives.
   */
  @Post(':id/revoke')
  @RequirePermissions('kiosk.manage')
  @HttpCode(200)
  @Audited({ resource: 'kiosk_device', action: 'revoked' })
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.attendance.revokeDevice(user.organizationId!, id);
  }

  /**
   * Biometric turnstile ingest. No JWT -- the device's own key is the
   * credential, matched by sha256 digest against a device registered with
   * kind BIOMETRIC. Always answers 200 with a gate decision (devices
   * retry on non-200); only an invalid key is a 401.
   */
  @Post('check-in')
  @Public()
  @HttpCode(200)
  deviceCheckIn(@Body() dto: DeviceCheckInDto) {
    return this.attendance.deviceCheckIn(dto);
  }
}
