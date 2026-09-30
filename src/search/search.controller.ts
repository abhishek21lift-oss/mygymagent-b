import { Controller, Get, Query } from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermissions('search.read')
  searchAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
    @Query('limit') limit = '20',
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.search.search(
      user.organizationId!,
      q,
      Math.min(50, Math.max(1, Number(limit) || 20)),
      branchScope,
    );
  }
}
