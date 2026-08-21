import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CommunicationsModule } from '../communications/communications.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    RbacModule,
    CommunicationsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokensService, JwtStrategy],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
