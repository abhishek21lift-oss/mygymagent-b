import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { CurrentUser as CurrentUserType } from '../common/types/authenticated-user';
import { PtPackagesService } from './pt-packages.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

@ApiTags('pt-packages')
@Controller('pt-packages')
export class PtPackagesController {
  constructor(private readonly service: PtPackagesService) {}

  @Get()
  @RequirePermissions('pt-packages.read')
  list(
    @CurrentUser() user: CurrentUserType,
    @Query('memberId') memberId?: string,
  ) {
    return this.service.list(user.organizationId, memberId);
  }

  @Get(':id')
  @RequirePermissions('pt-packages.read')
  getOne(@Param('id') id: string, @CurrentUser() user: CurrentUserType) {
    return this.service.getOne(user.organizationId, id);
  }

  @Post()
  @RequirePermissions('pt-packages.create')
  create(
    @Body() dto: CreatePtPackageDto,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.service.create(user.organizationId, dto, user.id);
  }
}
