import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AuthService, type RequestMeta } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

const REFRESH_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private requestMeta(req: Request): RequestMeta {
    return {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      deviceName: req.headers['x-device-name'] as string | undefined,
    };
  }

  private setRefreshCookie(
    res: Response,
    token: string,
    expiresAt: Date,
  ): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/auth',
      expires: expiresAt,
    });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto, this.requestMeta(req));
    this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    return {
      user: result.user,
      organization: result.organization,
      accessToken: result.accessToken,
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, this.requestMeta(req));
    this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    return { user: result.user, accessToken: result.accessToken };
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new BadRequestException('Missing refresh token');
    const result = await this.authService.refresh(token, this.requestMeta(req));
    this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    return { user: result.user, accessToken: result.accessToken };
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.id);
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user.id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
  }
}
