import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  IsDateString,
  IsArray,
} from 'class-validator';
import { MemberStatus, MemberType } from '@prisma/client';

export class ListMembersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  orderBy?: 'firstName' | 'lastName' | 'createdAt' | 'memberCode';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  status?: MemberStatus[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberType?: MemberType[];

  @IsOptional()
  @IsUUID('4', { each: true })
  trainerId?: string[];

  @IsOptional()
  @IsUUID('4', { each: true })
  branchId?: string[];

  @IsOptional()
  @IsUUID('4', { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsDateString()
  joinedFrom?: string;

  @IsOptional()
  @IsDateString()
  joinedTo?: string;

  @IsOptional()
  @IsString()
  hasOutstandingBalance?: string;

  @IsOptional()
  @IsString()
  assignedToMe?: string;
}
