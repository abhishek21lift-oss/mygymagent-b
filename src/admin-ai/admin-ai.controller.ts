import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePlatformRole } from '../common/decorators/require-platform-role.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AdminAiService, type AuditCtx } from './admin-ai.service';
import {
  AnalyticsRangeDto,
  CreateBackupDto,
  CreateClientProfileDto,
  CreateKeyDto,
  LogsQueryDto,
  PatchClientProfileDto,
  PatchKeyDto,
  PatchModelDto,
  UpdateFallbackDto,
  UpdateRoutingDto,
  UpdateSettingsDto,
  requireConfirm,
} from './dto';

/** Secure operational control plane for FreeLLMAPI. Platform staff only.
 * Every route is an explicit allowlisted operation -- there is no generic
 * passthrough. V1 omits: raw key reveal/export/preview, unified-key
 * regeneration, URL-token minting, backup download/restore,
 * premium/license, logs clear, conversation transcripts. */
@Controller('admin/ai')
@RequirePlatformRole()
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class AdminAiController {
  constructor(private readonly service: AdminAiService) {}

  private ctx(user: AuthenticatedUser, req: Request): AuditCtx {
    return {
      actorUserId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
    };
  }

  // -- Gateway / providers / keys --------------------------------------
  @Get('gateway')
  gateway() {
    return this.service.gateway();
  }

  @Get('providers')
  providers() {
    return this.service.providers();
  }

  @Get('health')
  health() {
    return this.service.health();
  }

  @Get('keys')
  keys() {
    return this.service.keys();
  }

  @Post('keys')
  @Audited({ resource: 'ai_gateway', action: 'keys.create' })
  createKey(
    @Body() dto: CreateKeyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.createKey(dto, this.ctx(user, req));
  }

  @Patch('keys/:id')
  @Audited({ resource: 'ai_gateway', action: 'keys.patch' })
  patchKey(
    @Param('id') id: string,
    @Body() dto: PatchKeyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.patchKey(
      id,
      dto as Record<string, unknown>,
      this.ctx(user, req),
    );
  }

  @Delete('keys/:id')
  @Audited({ resource: 'ai_gateway', action: 'keys.delete' })
  deleteKey(
    @Param('id') id: string,
    @Query('confirm') confirm: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    try {
      requireConfirm(confirm);
    } catch {
      throw new BadRequestException(
        'Destructive action requires ?confirm=true',
      );
    }
    return this.service.deleteKey(id, this.ctx(user, req));
  }

  @Post('keys/:id/check')
  @Audited({ resource: 'ai_gateway', action: 'keys.check' })
  checkKey(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    void user;
    void req;
    return this.service.checkKey(id);
  }

  @Post('keys/check-all')
  @Audited({ resource: 'ai_gateway', action: 'keys.check-all' })
  checkAll(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.service.checkAll(this.ctx(user, req));
  }

  @Delete('keys/:id/cooldowns')
  @Audited({ resource: 'ai_gateway', action: 'keys.clear-cooldowns' })
  clearCooldowns(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.clearCooldowns(id, this.ctx(user, req));
  }

  // -- Models -------------------------------------------------------------
  @Get('models')
  models() {
    return this.service.models();
  }

  @Patch('models/:id')
  @Audited({ resource: 'ai_gateway', action: 'models.patch' })
  patchModel(
    @Param('id') id: string,
    @Body() dto: PatchModelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.patchModel(
      id,
      dto as Record<string, unknown>,
      this.ctx(user, req),
    );
  }

  // -- Fallback / routing ---------------------------------------------------
  @Get('fallback')
  fallback() {
    return this.service.fallback();
  }

  @Put('fallback')
  @Audited({ resource: 'ai_gateway', action: 'fallback.update' })
  updateFallback(
    @Body() dto: UpdateFallbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.updateFallback(dto.rows, this.ctx(user, req));
  }

  @Get('routing')
  routing() {
    return this.service.routing();
  }

  @Put('routing')
  @Audited({ resource: 'ai_gateway', action: 'routing.update' })
  updateRouting(
    @Body() dto: UpdateRoutingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.updateRouting(
      dto as unknown as Record<string, unknown>,
      this.ctx(user, req),
    );
  }

  // -- Quota -------------------------------------------------------------------
  @Get('quota')
  quota() {
    return this.service.quota();
  }

  // -- Analytics ------------------------------------------------------------------
  @Get('analytics/summary')
  analyticsSummary(@Query() q: AnalyticsRangeDto) {
    return this.service.analyticsSummary({ range: q.range });
  }

  @Get('analytics/by-model')
  analyticsByModel(@Query() q: AnalyticsRangeDto) {
    return this.service.analyticsByModel({ range: q.range });
  }

  @Get('analytics/by-platform')
  analyticsByPlatform(@Query() q: AnalyticsRangeDto) {
    return this.service.analyticsByPlatform({ range: q.range });
  }

  @Get('analytics/timeline')
  analyticsTimeline(@Query() q: AnalyticsRangeDto) {
    return this.service.analyticsTimeline({
      range: q.range,
      interval: q.interval,
    });
  }

  @Get('analytics/requests')
  analyticsRequests(@Query() q: AnalyticsRangeDto) {
    return this.service.analyticsRequests({
      range: q.range,
      limit: q.limit,
      offset: q.offset,
      status: q.status,
    });
  }

  // -- Logs -------------------------------------------------------------------------
  @Get('logs')
  logs(@Query() q: LogsQueryDto) {
    return this.service.logs({
      levels: q.levels,
      sinceId: q.sinceId,
      limit: q.limit,
      q: q.q,
      provider: q.provider,
    });
  }

  // -- Settings -----------------------------------------------------------------------
  @Get('settings')
  settings() {
    return this.service.settings();
  }

  @Put('settings/:section')
  @Audited({ resource: 'ai_gateway', action: 'settings.update' })
  updateSettings(
    @Param('section') section: string,
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.updateSettings(section, dto.value, this.ctx(user, req));
  }

  // -- Backups --------------------------------------------------------------------------
  @Get('backups')
  backups(@Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    return this.service.backups({ page, pageSize });
  }

  @Post('backups')
  @Audited({ resource: 'ai_gateway', action: 'backups.create' })
  createBackup(
    @Body() dto: CreateBackupDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.createBackup(dto, this.ctx(user, req));
  }

  // -- Client profiles ---------------------------------------------------------------------
  @Get('client-profiles')
  clientProfiles() {
    return this.service.clientProfiles();
  }

  @Post('client-profiles')
  @Audited({ resource: 'ai_gateway', action: 'client-profiles.create' })
  createClientProfile(
    @Body() dto: CreateClientProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.createClientProfile(dto, this.ctx(user, req));
  }

  @Patch('client-profiles/:id')
  @Audited({ resource: 'ai_gateway', action: 'client-profiles.patch' })
  patchClientProfile(
    @Param('id') id: string,
    @Body() dto: PatchClientProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.patchClientProfile(
      id,
      dto as Record<string, unknown>,
      this.ctx(user, req),
    );
  }

  @Post('client-profiles/:id/rotate')
  @Audited({ resource: 'ai_gateway', action: 'client-profiles.rotate' })
  rotateClientProfile(
    @Param('id') id: string,
    @Query('confirm') confirm: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    try {
      requireConfirm(confirm);
    } catch {
      throw new BadRequestException('Key rotation requires ?confirm=true');
    }
    return this.service.rotateClientProfile(id, this.ctx(user, req));
  }

  @Delete('client-profiles/:id')
  @Audited({ resource: 'ai_gateway', action: 'client-profiles.delete' })
  deleteClientProfile(
    @Param('id') id: string,
    @Query('confirm') confirm: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    try {
      requireConfirm(confirm);
    } catch {
      throw new BadRequestException(
        'Destructive action requires ?confirm=true',
      );
    }
    return this.service.deleteClientProfile(id, this.ctx(user, req));
  }

  // -- Embeddings / media ---------------------------------------------------------------------
  @Get('embeddings')
  embeddings() {
    return this.service.embeddings();
  }

  @Get('media')
  media(@Query('modality') modality?: string) {
    return this.service.media(modality);
  }
}
