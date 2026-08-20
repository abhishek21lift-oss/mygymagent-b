import { IsIn } from 'class-validator';
import type { OrganizationStatus } from '@prisma/client';

const STATUSES: OrganizationStatus[] = [
  'TRIAL',
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
];

export class UpdateOrganizationStatusDto {
  @IsIn(STATUSES)
  status: OrganizationStatus;
}
