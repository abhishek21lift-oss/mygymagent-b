import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import {
  ACCESS_TOKEN_AUDIENCE,
  JWT_ALGORITHM,
  JWT_ISSUER,
  type AccessTokenPayload,
} from '../tokens.service';
import { MfaPolicyService } from '../mfa/mfa-policy.service';
import { assertOrganizationOpen } from '../organization-access';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly mfaPolicy: MfaPolicyService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // Pinned, never read from the token header; and only tokens minted
      // as access tokens by this issuer pass (an MFA challenge token is
      // signed with the same secret but for a different audience).
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  /**
   * Re-reads the user from the database on every request rather than
   * trusting the JWT payload for anything beyond the user id. This keeps
   * suspension/role changes effective immediately instead of waiting for
   * a 15-minute access token to expire, at the cost of one indexed lookup
   * per request (candidate for a short-TTL cache once load requires it).
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access' || typeof payload.ver !== 'number') {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        organizationId: true,
        platformRole: true,
        email: true,
        firstName: true,
        lastName: true,
        primaryBranchId: true,
        status: true,
        deletedAt: true,
        tokenVersion: true,
        // Joined rather than fetched separately: the policy is read on
        // every authenticated request, and an organization that never
        // switched enforcement on must not pay for a second round trip.
        organization: {
          select: {
            mfaPolicy: true,
            mfaGraceUntil: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }
    // A password reset, MFA disable or deactivation bumps the version, so
    // every access token minted before it stops working here rather than
    // living out its 15 minutes.
    if (payload.ver !== user.tokenVersion) {
      throw new UnauthorizedException('Session has ended; sign in again');
    }
    // Takes effect on the next request after a suspension, not when the
    // access token runs out.
    assertOrganizationOpen(user.organization);

    // Only organizations that opted in get past `isEngaged`, so this is a
    // field comparison for everyone else.
    const requirement = await this.mfaPolicy.evaluate(
      user.id,
      user.organization,
    );

    return {
      id: user.id,
      organizationId: user.organizationId,
      platformRole: user.platformRole,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      primaryBranchId: user.primaryBranchId,
      mfaEnrolmentRequired: requirement.state === 'ENFORCED',
    };
  }
}
