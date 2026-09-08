import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SegmentsService } from './segments.service';
import type { CreateSegmentDto, UpdateSegmentDto } from './segments.service';
import { SEGMENT_FIELDS } from './segment-rules';

@Controller('members/segments')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Get('fields')
  @RequirePermissions('reports.view')
  getSegmentFields() {
    return SEGMENT_FIELDS;
  }

  @Get()
  @RequirePermissions('reports.view')
  async listSegments(@CurrentUser() user: AuthenticatedUser) {
    return this.segments.listSegments(user.organizationId!);
  }

  @Get(':segmentId')
  @RequirePermissions('reports.view')
  async getSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ) {
    const segment = await this.segments.getSegment(
      user.organizationId!,
      segmentId,
    );
    if (!segment) {
      return null;
    }
    const memberCount = await this.segments.countSegmentMembers(
      user.organizationId!,
      segmentId,
    );
    return { segment, memberCount };
  }

  @Get(':segmentId/members')
  @RequirePermissions('reports.view')
  async getSegmentMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const members = await this.segments.getSegmentMembers(
      user.organizationId!,
      segmentId,
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
    );
    const totalCount = await this.segments.countSegmentMembers(
      user.organizationId!,
      segmentId,
    );
    return { members, totalCount };
  }

  @Post()
  @RequirePermissions('members.edit')
  async createSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSegmentDto,
  ) {
    return this.segments.createSegment(user.organizationId!, user.id, dto);
  }

  @Patch(':segmentId')
  @RequirePermissions('members.edit')
  async updateSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segments.updateSegment(user.organizationId!, segmentId, dto);
  }

  @Delete(':segmentId')
  @RequirePermissions('members.edit')
  async deleteSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ) {
    await this.segments.deleteSegment(user.organizationId!, segmentId);
    return { success: true };
  }
}
