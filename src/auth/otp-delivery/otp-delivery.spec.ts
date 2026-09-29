import { ConfigService } from '@nestjs/config';
import { MockOtpDelivery, DEFAULT_MOCK_OTP } from './mock-otp-delivery';
import { Msg91OtpDelivery } from './msg91-otp-delivery';
import type { Msg91SmsProvider } from '../../communications/providers/msg91-sms.provider';

/**
 * The mock OTP provider's own defences, tested directly rather than
 * through the app.
 *
 * `env.validation.spec.ts` covers the layer that actually holds — the
 * process refusing to boot. These cover the two below it, which exist
 * because a guard that only exists on the path you remember to take is
 * not a guard: a test or a script can construct the class without going
 * through `ConfigModule.forRoot` at all.
 */
describe('MockOtpDelivery', () => {
  const configFor = (env: Record<string, string | undefined>) =>
    ({
      get: (key: string, fallback?: unknown) => env[key] ?? fallback,
    }) as unknown as ConfigService;

  const dev = configFor({ NODE_ENV: 'development' });

  it('hands out a six-digit code, defaulting to the documented value', () => {
    const delivery = new MockOtpDelivery(dev);
    expect(delivery.issueCode()).toBe(DEFAULT_MOCK_OTP);
    expect(delivery.issueCode()).toMatch(/^[0-9]{6}$/);
  });

  it('honours MOCK_OTP when one is configured', () => {
    const delivery = new MockOtpDelivery(
      configFor({ NODE_ENV: 'test', MOCK_OTP: '654321' }),
    );
    expect(delivery.issueCode()).toBe('654321');
  });

  it('is the same code every time, which is the point and the risk', () => {
    const delivery = new MockOtpDelivery(dev);
    expect(delivery.issueCode()).toBe(delivery.issueCode());
  });

  it('is configured outside production without needing a carrier', () => {
    expect(new MockOtpDelivery(dev).isConfigured()).toBe(true);
    expect(
      new MockOtpDelivery(configFor({ NODE_ENV: 'test' })).isConfigured(),
    ).toBe(true);
  });

  it('refuses to be constructed in production at all', () => {
    expect(
      () => new MockOtpDelivery(configFor({ NODE_ENV: 'production' })),
    ).toThrow(/development\/test only/);
  });

  it('reports itself unconfigured in production even if construction was forced', () => {
    // Reaches past the constructor guard on purpose: the binding is a
    // factory, and a future edit could hand this out under a different
    // condition. isConfigured() false makes MemberOtpService refuse the
    // flow before issuing anything, which is the behaviour that has to
    // hold even if the throw above were removed.
    const delivery = Object.create(
      MockOtpDelivery.prototype,
    ) as MockOtpDelivery;
    Object.defineProperty(delivery, 'config', {
      value: configFor({ NODE_ENV: 'production' }),
    });
    expect(delivery.isConfigured()).toBe(false);
    expect(() => delivery.issueCode()).toThrow(/production/);
    return expect(
      delivery.send({
        to: '+919876543210',
        code: '123456',
        organizationId: 'o',
      }),
    ).rejects.toThrow(/production/);
  });
});

describe('Msg91OtpDelivery', () => {
  const sms = {
    isConfigured: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue('msg91-request-id'),
  } as unknown as Msg91SmsProvider;

  const delivery = new Msg91OtpDelivery(sms);

  it('issues a CSPRNG code, not the mock one', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) codes.add(delivery.issueCode());

    // Not the fixed code: a real provider must not be capable of issuing
    // the value a mock issues, or the two become indistinguishable.
    expect(codes.has(DEFAULT_MOCK_OTP)).toBe(false);
    // Six digits, zero-padded, and not all the same (which would mean the
    // RNG collapsed to a constant).
    for (const code of codes) expect(code).toMatch(/^[0-9]{6}$/);
    expect(codes.size).toBeGreaterThan(1);
  });

  it('delegates configuredness straight to Msg91', () => {
    expect(delivery.isConfigured()).toBe(true);
    (sms.isConfigured as jest.Mock).mockReturnValue(false);
    expect(delivery.isConfigured()).toBe(false);
  });

  it('passes the code as the message text, as the DLT template expects', async () => {
    await delivery.send({
      to: '+919876543210',
      code: '424242',
      organizationId: 'org-1',
    });
    expect(sms.send).toHaveBeenCalledWith({
      to: '+919876543210',
      text: '424242',
      organizationId: 'org-1',
    });
  });

  it('propagates a delivery failure rather than swallowing it', async () => {
    (sms.send as jest.Mock).mockRejectedValueOnce(new Error('carrier down'));
    await expect(
      delivery.send({ to: '+919876543210', code: '1', organizationId: 'o' }),
    ).rejects.toThrow('carrier down');
  });
});
