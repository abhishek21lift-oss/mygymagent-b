import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { WhatsappService } from './whatsapp.service';

const APP_SECRET = 'test-meta-app-secret';

function serviceWith(secret: string | undefined, nodeEnv = 'test') {
  const config = {
    get: (key: string, defaultValue?: string) => {
      if (key === 'META_APP_SECRET') return secret ?? defaultValue ?? '';
      if (key === 'NODE_ENV') return nodeEnv;
      return defaultValue ?? '';
    },
  };
  return new WhatsappService(
    {} as never,
    config as never,
    {} as never,
    {} as never,
  );
}

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('WhatsappService.verifyInboundSignature', () => {
  const body = Buffer.from(
    JSON.stringify({ object: 'whatsapp_business_account' }),
  );

  it('accepts a valid Meta signature', () => {
    const service = serviceWith(APP_SECRET);
    expect(() =>
      service.verifyInboundSignature(body, sign(body, APP_SECRET)),
    ).not.toThrow();
  });

  it('rejects a forged signature', () => {
    const service = serviceWith(APP_SECRET);
    expect(() =>
      service.verifyInboundSignature(body, sign(body, 'wrong-secret')),
    ).toThrow(ForbiddenException);
  });

  it('rejects a missing or malformed signature', () => {
    const service = serviceWith(APP_SECRET);
    expect(() => service.verifyInboundSignature(body, undefined)).toThrow(
      ForbiddenException,
    );
    expect(() => service.verifyInboundSignature(body, 'not-hex')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a valid signature over tampered bytes', () => {
    const service = serviceWith(APP_SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ object: 'whatsapp_business_account', injected: true }),
    );
    expect(() =>
      service.verifyInboundSignature(tampered, sign(body, APP_SECRET)),
    ).toThrow(ForbiddenException);
  });

  it('fails closed in production when the secret is unset', () => {
    const service = serviceWith(undefined, 'production');
    expect(() => service.verifyInboundSignature(body, undefined)).toThrow();
  });
});
