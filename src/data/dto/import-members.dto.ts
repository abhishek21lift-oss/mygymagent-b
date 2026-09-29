import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One uploaded CSV row.
 *
 * The columns the member export writes are all declared, including
 * `id` and `createdAt`, which the import ignores. That is deliberate: the
 * app's own export has to survive a round trip back through the import,
 * and the global `ValidationPipe` runs with `forbidNonWhitelisted`, so a
 * column that is not declared here turns a legitimate
 * export-then-reimport into a 400 for the whole file.
 *
 * `primaryBranchId` and `assignedTrainerId` stay plain optional strings
 * rather than `@IsUUID()`. A malformed value in either is a row-level
 * problem, and this importer's established contract is to reject a bad
 * row into its `errors` array and carry on with the rest of the file —
 * a request-level 400 would throw away up to 1,999 good rows over one
 * typo. `DataService.importMembers` runs both through
 * `TenantReferenceValidator`, so an id belonging to another organization
 * is refused either way.
 */
export class ImportMemberRowDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  memberCode?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  primaryBranchId?: string;

  @IsOptional()
  @IsString()
  assignedTrainerId?: string;

  /** Present on rows produced by the export; never read on import. */
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  createdAt?: string;
}

export class ImportMembersDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportMemberRowDto)
  rows!: ImportMemberRowDto[];
}
