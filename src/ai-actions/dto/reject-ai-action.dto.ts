import { IsOptional, IsString } from 'class-validator';

export class RejectAiActionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
