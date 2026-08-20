import { IsIn, IsOptional } from 'class-validator';
import type { OrganizationStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const STATUSES: OrganizationStatus[] = [
  'TRIAL',
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
];

export class ListPlatformOrganizationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OrganizationStatus;
}
