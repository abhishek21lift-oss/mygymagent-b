import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { AccessTokenPayload } from '../tokens.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
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
    if (payload.type !== 'access') throw new UnauthorizedException();

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
      },
    });

    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    return {
      id: user.id,
      organizationId: user.organizationId,
      platformRole: user.platformRole,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      primaryBranchId: user.primaryBranchId,
    };
  }
}
