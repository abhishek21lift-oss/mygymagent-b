import { IsDateString, IsString } from 'class-validator';

export class CreateFollowupArgsDto {
  @IsString()
  leadId!: string;

  @IsString()
  note!: string;

  @IsDateString()
  dueAt!: string;
}
