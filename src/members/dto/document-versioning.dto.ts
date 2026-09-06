import { IsOptional, IsString, IsUUID } from 'class-validator';

export class SubmitDocumentDto {
  @IsOptional()
  @IsString()
  changeNotes?: string;
}

export class ReviewDocumentDto {
  @IsOptional()
  @IsUUID('4')
  reviewedByUserId?: string;

  @IsString()
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

export class CreateDocumentVersionDto {
  @IsOptional()
  @IsString()
  changeNotes?: string;
}
