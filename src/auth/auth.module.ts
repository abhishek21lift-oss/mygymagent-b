import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CommunicationsModule } from '../communications/communications.module';
import { Msg91SmsProvider } from '../communications/providers/msg91-sms.provider';
import { RbacModule } from '../rbac/rbac.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MemberOtpService } from './member-otp.service';
import { Msg91OtpDelivery } from './otp-delivery/msg91-otp-delivery';
import { MockOtpDelivery } from './otp-delivery/mock-otp-delivery';
import { OTP_DELIVERY } from './otp-delivery/otp-delivery.interface';
import { MfaController } from './mfa/mfa.controller';
import { MfaPolicyService } from './mfa/mfa-policy.service';
import { MfaService } from './mfa/mfa.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    RbacModule,
    CommunicationsModule,
    // ConfigModule is global, but a `useFactory` reading it is resolved
    // in this module's own context, so declaring the dependency is what
    // makes the OTP provider selection actually injectable rather than
    // something that happens to work because another module loaded it.
    ConfigModule,
  ],
  controllers: [AuthController, MfaController],
  providers: [
    /**
     * Which member OTP provider this deployment runs.
     *
     * Both implementations are constructed *inside the factory*, not
     * listed as class providers beside it. That detail is load-bearing:
     * Nest instantiates every entry in `providers` eagerly at boot, so
     * listing `MockOtpDelivery` there built it on every deployment —
     * including production, where its constructor throws by design — and
     * the app died in the InstanceLoader with a stack pointing at
     * `new MockOtpDelivery` and no mention of configuration. The factory
     * only reaches `MockOtpDelivery` when `OTP_PROVIDER=mock`, which
     * `env.validation.ts` already refuses to boot on in production
     * (ConfigModule validates before any provider is constructed), so
     * the constructor guard is now a backstop rather than the thing
     * standing between a bad config and a live process.
     *
     * `msg91` remains the default, so a deployment that sets nothing new
     * behaves exactly as it did before this option existed.
     */
    {
      provide: OTP_DELIVERY,
      inject: [ConfigService, Msg91SmsProvider],
      useFactory: (config: ConfigService, msg91: Msg91SmsProvider) =>
        config.get<string>('OTP_PROVIDER') === 'mock'
          ? new MockOtpDelivery(config)
          : new Msg91OtpDelivery(msg91),
    },
    MemberOtpService,
    AuthService,
    TokensService,
    JwtStrategy,
    MfaService,
    MfaPolicyService,
  ],
  exports: [AuthService, TokensService, MfaService, MfaPolicyService],
})
export class AuthModule {}
