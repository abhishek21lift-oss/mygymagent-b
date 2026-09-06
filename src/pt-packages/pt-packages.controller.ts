import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PtPackagesService } from './pt-packages.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

@Controller('pt-packages')
export class PtPackagesController {
  constructor(private readonly service: PtPackagesService) {}

  @Get()
  @RequirePermissions('pt-packages.read')
  list(@CurrentUser() user: AuthenticatedUser, @Query('memberId') memberId?: string) {
    return this.service.list(user.organizationId ?? '', memberId ?? undefined);
  }

  @Get(':id')
  @RequirePermissions('pt-packages.read')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getOne(user.organizationId ?? '', id);
  }

  @Post()
  @RequirePermissions('pt-packages.create')
  create(@Body() dto: CreatePtPackageDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(user.organizationId ?? '', dto, user.id);
  }
}
