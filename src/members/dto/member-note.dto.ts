import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateMemberNoteDto {
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateMemberNoteDto extends PartialType(CreateMemberNoteDto) {}
