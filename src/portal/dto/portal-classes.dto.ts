import { IsISO8601, IsOptional } from 'class-validator';

/** The window of class sessions a member is looking at. Defaults are
 * applied in the service, which shares them with the staff listing. */
export class ListPortalClassesDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
