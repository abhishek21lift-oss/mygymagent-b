import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_TOKEN_AUDIENCE,
  endAllSessions,
  JWT_ISSUER,
  MFA_CHALLENGE_AUDIENCE,
  TokensService,
} from './tokens.service';

const SECRET = 'unit-test-access-secret-0123456789';

function tokens() {
  const config = new ConfigService({ JWT_ACCESS_SECRET: SECRET });
  const jwt = new JwtService({});
  const svc = new TokensService(jwt, config, {} as PrismaService);
  return { svc, jwt };
}

const base64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TokensService access tokens', () => {
  it('signs HS256 with issuer, audience and the token version', () => {
    const { svc, jwt } = tokens();
    const token = svc.signAccessToken('user-1', 3);
    const decoded = jwt.decode<Record<string, unknown>>(token, {
      complete: true,
    }) as unknown as {
      header: { alg: string };
      payload: Record<string, unknown>;
    };
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload).toMatchObject({
      sub: 'user-1',
      type: 'access',
      ver: 3,
      iss: JWT_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
    });
    expect(svc.verifyAccessToken(token)).toMatchObject({ sub: 'user-1' });
  });

  it('defaults the version to 0', () => {
    const { svc } = tokens();
    expect(svc.verifyAccessToken(svc.signAccessToken('user-1')).ver).toBe(0);
  });

  it('rejects a token signed with another HMAC algorithm', () => {
    const { svc, jwt } = tokens();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      {
        secret: SECRET,
        algorithm: 'HS512',
        issuer: JWT_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      },
    );
    expect(() => svc.verifyAccessToken(token)).toThrow(/invalid algorithm/);
  });

  it('rejects an unsigned (alg none) token', () => {
    const { svc } = tokens();
    const now = Math.floor(Date.now() / 1000);
    const token = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      sub: 'user-1',
      type: 'access',
      ver: 0,
      iss: JWT_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      iat: now,
      exp: now + 60,
    })}.`;
    expect(() => svc.verifyAccessToken(token)).toThrow();
  });

  it('rejects a token without the issuer', () => {
    const { svc, jwt } = tokens();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      { secret: SECRET, audience: ACCESS_TOKEN_AUDIENCE },
    );
    expect(() => svc.verifyAccessToken(token)).toThrow(/jwt issuer invalid/);
  });

  it('rejects a token with a foreign issuer', () => {
    const { svc, jwt } = tokens();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      {
        secret: SECRET,
        issuer: 'someone-else',
        audience: ACCESS_TOKEN_AUDIENCE,
      },
    );
    expect(() => svc.verifyAccessToken(token)).toThrow(/jwt issuer invalid/);
  });

  it('rejects an MFA challenge token (same secret, other audience)', () => {
    const { svc, jwt } = tokens();
    const token = jwt.sign(
      { sub: 'user-1', type: 'mfa' },
      { secret: SECRET, issuer: JWT_ISSUER, audience: MFA_CHALLENGE_AUDIENCE },
    );
    expect(() => svc.verifyAccessToken(token)).toThrow(/jwt audience invalid/);
  });
});

describe('endAllSessions', () => {
  it('bumps the token version and revokes every live refresh token', async () => {
    const db = {
      user: { update: jest.fn() },
      refreshToken: { updateMany: jest.fn() },
    };
    await endAllSessions(db as never, 'user-1');
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
