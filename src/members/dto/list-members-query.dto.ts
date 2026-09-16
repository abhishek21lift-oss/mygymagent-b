import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { MemberStatus, MemberType } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const toArray = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

export class ListMembersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['firstName', 'lastName', 'createdAt', 'memberCode'])
  orderBy?: 'firstName' | 'lastName' | 'createdAt' | 'memberCode';

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(MemberStatus, { each: true })
  status?: MemberStatus[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(MemberType, { each: true })
  memberType?: MemberType[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  trainerId?: string[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  branchId?: string[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];

  @IsOptional()
  @IsDateString()
  joinedFrom?: string;

  @IsOptional()
  @IsDateString()
  joinedTo?: string;
}
