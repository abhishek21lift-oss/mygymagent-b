import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * The query `GET /pt-sessions` actually accepts.
 *
 * The handler used to take `@Query() PaginationQueryDto` and then read
 * `memberId`, `trainerId`, `branchId`, `startFrom` and `endTo` as five
 * separate `@Query('...')` params. The global pipe runs with
 * `forbidNonWhitelisted: true`, and it validates the whole query object
 * against the DTO -- which declares none of those five. So the request
 * was rejected before the handler ever ran: `GET /pt-sessions?memberId=x`
 * answered 400 every time, in production, which is every PT panel on
 * every member's page.
 *
 * Extending the pagination DTO rather than adding the fields to it keeps
 * the filters where they belong and, as a side effect, means they are now
 * validated at all -- `memberId` was an unchecked string reaching a
 * Prisma `where`.
 */
export class ListPtSessionsDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  trainerId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsDateString()
  startFrom?: string;

  @IsOptional()
  @IsDateString()
  endTo?: string;
}
