import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ConfirmMfaDto, DisableMfaDto } from './dto/mfa.dto';
import { MfaService } from './mfa.service';

/**
 * Enrolment management for the authenticated user's own second factor.
 *
 * The matching *login* step (`POST /auth/mfa/verify`) deliberately lives on
 * AuthController instead: it is part of the login flow, is `@Public()`, and
 * has to set the same refresh cookie login does.
 */
@Controller('auth/mfa')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.status(user.id);
  }

  /** Returns the secret and `otpauth://` URI once, for the user to scan.
   * MFA is not active until /enable confirms a code from that secret. */
  @Post('setup')
  @Audited({ resource: 'user_mfa', action: 'enrolment_started' })
  setup(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.startEnrolment(user.id);
  }

  @Post('enable')
  @Audited({ resource: 'user_mfa', action: 'enabled' })
  enable(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConfirmMfaDto) {
    return this.mfa.confirmEnrolment(user.id, dto.code);
  }

  @Post('disable')
  @Audited({ resource: 'user_mfa', action: 'disabled' })
  disable(@CurrentUser() user: AuthenticatedUser, @Body() dto: DisableMfaDto) {
    return this.mfa.disable(user.id, dto.password, dto.code);
  }
}
