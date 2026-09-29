import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FcmPushProvider } from '../../communications/providers/fcm-push.provider';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';
import { PushDevicesService } from './push-devices.service';

/**
 * The caller's own push devices -- staff app, member portal and the
 * Capacitor shell alike. No permission is declared: like notification
 * preferences, this is a personal setting of whoever is signed in, and
 * every query is keyed on that user from the JWT.
 */
@Controller('notifications/devices')
export class PushDevicesController {
  constructor(
    private readonly devices: PushDevicesService,
    private readonly fcm: FcmPushProvider,
  ) {}

  /** Whether this deployment can deliver a push at all, so a client can
   * skip asking for OS notification permission it could never use. */
  @Get('status')
  status() {
    return { configured: this.fcm.isConfigured() };
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(this.orgOf(user), user.id);
  }

  @Post()
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushDeviceDto,
  ) {
    return this.devices.register(this.orgOf(user), user.id, dto.token);
  }

  /** For sign-out, when the client holds its token but not the row id. */
  @Post('unregister')
  @HttpCode(200)
  unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushDeviceDto,
  ) {
    return this.devices.removeByToken(this.orgOf(user), user.id, dto.token);
  }

  /**
   * Sends one push to each of the caller's own devices, synchronously, and
   * says what happened per device -- the "did it work?" button for setting
   * push up. Only ever the caller's own devices, so it cannot be used to
   * message anyone else.
   */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() user: AuthenticatedUser) {
    if (!this.fcm.isConfigured()) {
      throw new ServiceUnavailableException(
        'Push is not configured on this deployment',
      );
    }
    return this.devices.sendTest(this.orgOf(user), user.id, this.fcm);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.devices.remove(this.orgOf(user), user.id, id);
  }

  /** A platform admin has no organization, so no tenant to hold a device
   * under; refuse clearly rather than fail on a null foreign key. */
  private orgOf(user: AuthenticatedUser): string {
    if (!user.organizationId) {
      throw new ForbiddenException(
        'Push devices belong to an organization account',
      );
    }
    return user.organizationId;
  }
}
