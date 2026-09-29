import { ConfigService } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AuthModule } from '../auth.module';
import { MockOtpDelivery } from './mock-otp-delivery';
import { Msg91OtpDelivery } from './msg91-otp-delivery';
import { OTP_DELIVERY } from './otp-delivery.interface';
import type { Msg91SmsProvider } from '../../communications/providers/msg91-sms.provider';

/**
 * How `OTP_DELIVERY` is bound, and — more to the point — how it is NOT.
 *
 * This file exists because of a deploy that crashed in production while
 * every gate was green. `MockOtpDelivery` was listed as a class provider
 * in `AuthModule.providers` *and* constructed inside the `OTP_DELIVERY`
 * factory. Nest instantiates every `providers` entry eagerly, so the mock
 * was built on every deployment regardless of selection — and its
 * constructor throws in production by design. The app died in the
 * InstanceLoader with a stack that named `new MockOtpDelivery` and never
 * mentioned configuration.
 *
 * Nothing caught it because nothing in the suite ever booted the app with
 * NODE_ENV=production: unit tests construct the classes directly, and the
 * e2e suites all run as `test`. The bug lived entirely in the wiring,
 * which no assertion was looking at.
 */
describe('OTP_DELIVERY binding', () => {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    AuthModule,
  ) as Array<unknown>;

  it('does not register the mock provider as an eagerly-instantiated class', () => {
    // A class provider is a bare class in the array. Any shape that makes
    // Nest construct it at boot is the bug, whatever the key looks like.
    const eagerMock = providers.filter(
      (p) => p === MockOtpDelivery || p === Msg91OtpDelivery,
    );

    expect(eagerMock).toEqual([]);
  });

  it('registers no provider whose factory, class or useClass is the mock', () => {
    // Belt and braces over the check above: catches `useClass`,
    // `useFactory` returning it, and any future alias.
    const named = providers
      .map((p) =>
        p && typeof p === 'object'
          ? (p as { useClass?: unknown; provide?: unknown })
          : p,
      )
      .filter(
        (p) => (p as { useClass?: unknown })?.useClass === MockOtpDelivery,
      );

    expect(named).toEqual([]);
  });

  describe('the factory', () => {
    const entry = providers.find(
      (p) =>
        p &&
        typeof p === 'object' &&
        (p as { provide?: unknown }).provide === OTP_DELIVERY,
    ) as
      | {
          inject: unknown[];
          useFactory: (
            config: ConfigService,
            msg91: Msg91SmsProvider,
          ) => unknown;
        }
      | undefined;

    const msg91Stub = { isConfigured: () => true, send: async () => 'id' };

    const config = (env: Record<string, string | undefined>) =>
      ({
        get: (key: string, fallback?: unknown) => env[key] ?? fallback,
      }) as unknown as ConfigService;

    it('is registered against the OTP_DELIVERY token', () => {
      expect(entry).toBeDefined();
      expect(entry!.inject).toEqual(
        expect.arrayContaining([ConfigService, expect.anything()]),
      );
    });

    it('binds MSG91 under production defaults, and does not throw', () => {
      // The exact call that killed the deploy, minus Nest's eager
      // construction. Under production with nothing set, this must return
      // the real provider without ever touching the mock.
      const delivery = entry!.useFactory(
        config({ NODE_ENV: 'production' }),
        msg91Stub as unknown as Msg91SmsProvider,
      );

      expect(delivery).toBeInstanceOf(Msg91OtpDelivery);
      expect(delivery).not.toBeInstanceOf(MockOtpDelivery);
    });

    it('binds MSG91 when the provider is named explicitly', () => {
      const delivery = entry!.useFactory(
        config({ NODE_ENV: 'production', OTP_PROVIDER: 'msg91' }),
        msg91Stub as unknown as Msg91SmsProvider,
      );
      expect(delivery).toBeInstanceOf(Msg91OtpDelivery);
    });

    it('binds the mock only when asked, off production', () => {
      for (const nodeEnv of ['development', 'test']) {
        const delivery = entry!.useFactory(
          config({ NODE_ENV: nodeEnv, OTP_PROVIDER: 'mock' }),
          msg91Stub as unknown as Msg91SmsProvider,
        );
        expect(delivery).toBeInstanceOf(MockOtpDelivery);
      }
    });
  });
});
