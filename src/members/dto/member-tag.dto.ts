import {
  IsHexColor,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateMemberTagDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateMemberTagDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class AssignMemberTagsDto {
  @IsUUID('4', { each: true })
  tagIds!: string[];
}
