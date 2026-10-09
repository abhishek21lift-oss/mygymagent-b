import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Strategy } from 'passport-jwt';
import {
  ACCESS_TOKEN_AUDIENCE,
  JWT_ISSUER,
  MFA_CHALLENGE_AUDIENCE,
  TokensService,
} from '../tokens.service';
import { JwtStrategy } from './jwt.strategy';

const SECRET = 'unit-test-access-secret-0123456789';

function activeUser(tokenVersion: number) {
  return {
    id: 'user-1',
    organizationId: 'org-1',
    platformRole: null,
    email: 'a@example.com',
    firstName: 'A',
    lastName: 'B',
    primaryBranchId: null,
    status: 'ACTIVE',
    deletedAt: null,
    tokenVersion,
    organization: {
      mfaPolicy: 'OPTIONAL',
      mfaGraceUntil: null,
      status: 'ACTIVE',
      deletedAt: null,
    },
  };
}

function strategy(tokenVersion = 0) {
  const config = new ConfigService({ JWT_ACCESS_SECRET: SECRET });
  const prisma = {
    user: { findUnique: jest.fn(async () => activeUser(tokenVersion)) },
  };
  const mfaPolicy = {
    evaluate: jest.fn(async () => ({ state: 'NOT_REQUIRED' })),
  };
  const s = new JwtStrategy(config, prisma as never, mfaPolicy as never);
  return { s, prisma };
}

/** Runs a token through the same verifier passport-jwt uses, with the
 * options this strategy registered -- the alg/iss/aud checks live there,
 * before validate() ever sees a payload. */
function verify(s: JwtStrategy, token: string): Promise<unknown> {
  const internals = s as unknown as {
    _verifOpts: object;
  };
  const verifier = (
    Strategy as unknown as {
      JwtVerifier: (
        token: string,
        key: string,
        opts: object,
        cb: (err: Error | null, payload?: unknown) => void,
      ) => void;
    }
  ).JwtVerifier;
  return new Promise((resolve, reject) =>
    verifier(token, SECRET, internals._verifOpts, (err, payload) =>
      err ? reject(err) : resolve(payload),
    ),
  );
}

describe('JwtStrategy', () => {
  const jwt = new JwtService({});
  const tokens = new TokensService(
    jwt,
    new ConfigService({ JWT_ACCESS_SECRET: SECRET }),
    {} as never,
  );

  it('accepts an access token from TokensService', async () => {
    const { s } = strategy();
    await expect(
      verify(s, tokens.signAccessToken('user-1')),
    ).resolves.toMatchObject({ sub: 'user-1', type: 'access', ver: 0 });
  });

  it('rejects a non-HS256 token', async () => {
    const { s } = strategy();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      {
        secret: SECRET,
        algorithm: 'HS384',
        issuer: JWT_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      },
    );
    await expect(verify(s, token)).rejects.toThrow(/invalid algorithm/);
  });

  it('rejects a token with the wrong issuer', async () => {
    const { s } = strategy();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      { secret: SECRET, issuer: 'other', audience: ACCESS_TOKEN_AUDIENCE },
    );
    await expect(verify(s, token)).rejects.toThrow(/jwt issuer invalid/);
  });

  it('rejects a token without an audience', async () => {
    const { s } = strategy();
    const token = jwt.sign(
      { sub: 'user-1', type: 'access', ver: 0 },
      { secret: SECRET, issuer: JWT_ISSUER },
    );
    await expect(verify(s, token)).rejects.toThrow(/jwt audience invalid/);
  });

  it('rejects an MFA challenge token', async () => {
    const { s } = strategy();
    const token = jwt.sign(
      { sub: 'user-1', type: 'mfa' },
      { secret: SECRET, issuer: JWT_ISSUER, audience: MFA_CHALLENGE_AUDIENCE },
    );
    await expect(verify(s, token)).rejects.toThrow(/jwt audience invalid/);
  });

  it('accepts a payload whose version matches the account', async () => {
    const { s } = strategy(2);
    await expect(
      s.validate({ sub: 'user-1', type: 'access', ver: 2 }),
    ).resolves.toMatchObject({ id: 'user-1' });
  });

  it('rejects a payload minted before the version was bumped', async () => {
    const { s } = strategy(3);
    await expect(
      s.validate({ sub: 'user-1', type: 'access', ver: 2 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a payload with no version at all', async () => {
    const { s, prisma } = strategy(0);
    await expect(
      s.validate({ sub: 'user-1', type: 'access' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('selects tokenVersion when re-reading the user', async () => {
    const { s, prisma } = strategy(0);
    await s.validate({ sub: 'user-1', type: 'access', ver: 0 });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ tokenVersion: true }),
      }),
    );
  });
});
