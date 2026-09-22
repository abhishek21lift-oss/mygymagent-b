import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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

  /** Frontend (Vercel) and backend (Render) are different registrable
   * domains, so the refresh cookie is sent on a cross-site fetch, not a
   * top-level navigation. `SameSite=Lax` cookies are withheld from
   * cross-site fetch/XHR entirely -- only `SameSite=None` (which browsers
   * require pairing with `Secure`) is sent there. Locally, frontend and
   * backend share the "localhost" site (port is not part of site
   * identity), so `Lax` over plain http works and is used since `None`
   * requires `Secure`, which plain http can't set reliably outside
   * Chrome's special-cased localhost exception. */
  private cookieOptions(expiresAt?: Date) {
    const isProduction = this.config.get('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? ('none' as const) : ('lax' as const),
      path: '/auth',
      ...(expiresAt ? { expires: expiresAt } : {}),
    };
  }

  private setRefreshCookie(
    res: Response,
    token: string,
    expiresAt: Date,
  ): void {
    res.cookie(REFRESH_COOKIE, token, this.cookieOptions(expiresAt));
  }

  /** Allowed browser origins for the cookie-authenticated endpoints below
   * (refresh/logout). The refresh cookie is `SameSite=None` in production
   * so cross-site pages can trigger these endpoints with the victim's
   * cookie attached (logout CSRF / forced rotation) -- CORS alone does not
   * stop that, since the state change happens whether or not the attacker
   * can read the response. Requests without Origin/Referer (curl, tests,
   * native apps) are allowed; browser requests must exactly match an
   * origin the API already trusts for credentialed CORS. */
  private allowedOrigins(): Set<string> {
    const corsOrigins = (this.config.get<string>('CORS_ORIGIN') ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const frontendUrl = (this.config.get<string>('FRONTEND_URL') ?? '')
      .trim()
      .replace(/\/$/, '');
    return new Set([...corsOrigins, ...(frontendUrl ? [frontendUrl] : [])]);
  }

  private assertSafeOrigin(req: Request): void {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (!origin && !referer) return; // non-browser client
    const allowed = this.allowedOrigins();
    const normalize = (value: string) => value.trim().replace(/\/$/, '');
    if (origin && allowed.has(normalize(origin))) return;
    if (referer) {
      try {
        const url = new URL(referer);
        if (allowed.has(`${url.protocol}//${url.host}`)) return;
      } catch {
        // fall through to Forbidden below
      }
    }
    throw new ForbiddenException('Cross-origin request not allowed');
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
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertSafeOrigin(req);
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
    this.assertSafeOrigin(req);
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertSafeOrigin(req);
    await this.authService.logoutAll(user.id);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
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
