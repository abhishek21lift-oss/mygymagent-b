import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AllowPendingMfaEnrolment } from '../../common/decorators/allow-pending-mfa-enrolment.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ConfirmMfaDto, DisableMfaDto } from './dto/mfa.dto';
import { UpdateMfaPolicyDto } from './dto/mfa-policy.dto';
import { MfaPolicyService } from './mfa-policy.service';
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
  constructor(
    private readonly mfa: MfaService,
    private readonly policy: MfaPolicyService,
  ) {}

  /** Policy administration is organization-scoped; platform staff have
   * no organization of their own to configure. */
  private orgId(user: AuthenticatedUser): string {
    if (!user.organizationId) {
      throw new BadRequestException('No organization in scope');
    }
    return user.organizationId;
  }

  @Get()
  @AllowPendingMfaEnrolment()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.status(user.id);
  }

  /** Returns the secret and `otpauth://` URI once, for the user to scan.
   * MFA is not active until /enable confirms a code from that secret. */
  @Post('setup')
  @AllowPendingMfaEnrolment()
  @Audited({ resource: 'user_mfa', action: 'enrolment_started' })
  setup(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.startEnrolment(user.id);
  }

  @Post('enable')
  @AllowPendingMfaEnrolment()
  @Audited({ resource: 'user_mfa', action: 'enabled' })
  enable(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConfirmMfaDto) {
    return this.mfa.confirmEnrolment(user.id, dto.code);
  }

  @Post('disable')
  @Audited({ resource: 'user_mfa', action: 'disabled' })
  disable(@CurrentUser() user: AuthenticatedUser, @Body() dto: DisableMfaDto) {
    return this.mfa.disable(user.id, dto.password, dto.code);
  }

  /**
   * The enrolment report. Deliberately behind `organizations.update`
   * rather than `users.read`: it is a list of exactly which privileged
   * accounts are unprotected, which is reconnaissance in the wrong hands,
   * and its only legitimate use is deciding this organization's policy.
   */
  @Get('policy/report')
  @RequirePermissions('organizations.update')
  report(@CurrentUser() user: AuthenticatedUser) {
    return this.policy.report(this.orgId(user));
  }

  @Get('policy')
  @RequirePermissions('organizations.update')
  getPolicy(@CurrentUser() user: AuthenticatedUser) {
    return this.policy.getPolicy(this.orgId(user));
  }

  @Patch('policy')
  @RequirePermissions('organizations.update')
  @Audited({ resource: 'organization_mfa_policy', action: 'updated' })
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMfaPolicyDto,
  ) {
    return this.policy.updatePolicy(this.orgId(user), {
      policy: dto.policy,
      graceUntil: dto.graceUntil,
    });
  }
}
