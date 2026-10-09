import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { TokensService } from '../tokens.service';
import { MfaService } from './mfa.service';

const SECRET = 'unit-test-access-secret-0123456789';

function service() {
  const tx = {
    userMfa: { delete: jest.fn() },
    user: { update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    userMfa: { findUnique: jest.fn(), update: jest.fn() },
    mfaRecoveryCode: { updateMany: jest.fn() },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const config = new ConfigService({ JWT_ACCESS_SECRET: SECRET });
  const jwt = new JwtService({});
  const svc = new MfaService(prisma as never, config, jwt);
  return { svc, prisma, tx, jwt, config };
}

describe('MfaService challenge token', () => {
  it('round-trips through its own audience', async () => {
    const { svc, prisma } = service();
    const { mfaToken } = svc.issueChallengeToken('user-1');
    // Gets past the token check and fails later, on the missing enrolment.
    prisma.userMfa.findUnique.mockResolvedValue(null);
    await expect(svc.completeChallenge(mfaToken, '123456')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.userMfa.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  it('refuses an access token presented as a challenge token', async () => {
    const { svc, prisma, jwt, config } = service();
    const access = new TokensService(jwt, config, {} as never).signAccessToken(
      'user-1',
    );
    await expect(svc.completeChallenge(access, '123456')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.userMfa.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a challenge token signed with another algorithm', async () => {
    const { svc, prisma, jwt } = service();
    const forged = jwt.sign(
      { sub: 'user-1', type: 'mfa' },
      {
        secret: SECRET,
        algorithm: 'HS512',
        issuer: 'mygymagent',
        audience: 'mygymagent:mfa-challenge',
      },
    );
    await expect(svc.completeChallenge(forged, '123456')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.userMfa.findUnique).not.toHaveBeenCalled();
  });
});

describe('MfaService.disable', () => {
  it('ends every session along with the second factor', async () => {
    const { svc, prisma, tx } = service();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      passwordHash: await argon2.hash('correct horse battery'),
    });
    prisma.userMfa.findUnique.mockResolvedValue({
      id: 'mfa-1',
      enabledAt: new Date(),
      secretEnc: 'unused',
      lastUsedStep: null,
    });
    prisma.mfaRecoveryCode.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      svc.disable('user-1', 'correct horse battery', 'abcd1234-ef567890'),
    ).resolves.toEqual({ enabled: false });

    expect(tx.userMfa.delete).toHaveBeenCalledWith({ where: { id: 'mfa-1' } });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
