import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Filters for the audit trail.
 *
 * One whole-query DTO rather than named @Query() params beside it: the
 * global pipe runs `forbidNonWhitelisted` and validates the entire query
 * object against this class, so a param declared separately would be
 * rejected before the handler ran.
 */
export class ListAuditLogsDto extends PaginationQueryDto {
  /** The kind of thing that changed -- 'member', 'payment', 'user'. */
  @IsOptional()
  @IsString()
  resource?: string;

  /** What was done to it -- 'create', 'update', 'delete', 'assign_role'. */
  @IsOptional()
  @IsString()
  action?: string;

  /** One record's whole history, when paired with `resource`. */
  @IsOptional()
  @IsString()
  resourceId?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Whether to include the before/after snapshots. Off by default: the
   * list is read as a timeline, and shipping two JSON blobs per row for a
   * screen that shows neither is wasted on every request. */
  @IsOptional()
  @IsIn(['true', 'false'])
  withState?: 'true' | 'false';
}
