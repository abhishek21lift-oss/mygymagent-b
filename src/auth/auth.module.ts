import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CommunicationsModule } from '../communications/communications.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaController } from './mfa/mfa.controller';
import { MfaService } from './mfa/mfa.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    RbacModule,
    CommunicationsModule,
  ],
  controllers: [AuthController, MfaController],
  providers: [AuthService, TokensService, JwtStrategy, MfaService],
  exports: [AuthService, TokensService, MfaService],
})
export class AuthModule {}
