import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BranchesService } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Controller('branches')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @RequirePermissions('branches.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.branchesService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('branches.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.branchesService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('branches.create')
  @Audited({ resource: 'branch', action: 'create' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBranchDto) {
    return this.branchesService.create(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('branches.update')
  @Audited({ resource: 'branch', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchesService.update(user.organizationId!, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('branches.delete')
  @Audited({ resource: 'branch', action: 'delete' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.branchesService.remove(user.organizationId!, id);
  }
}
