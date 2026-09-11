import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateMemberTagDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a hex code like #6366f1',
  })
  color?: string;
}

export class UpdateMemberTagDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a hex code like #6366f1',
  })
  color?: string;
}

export class AssignMemberTagsDto {
  @IsString({ each: true })
  tagIds!: string[];
}
