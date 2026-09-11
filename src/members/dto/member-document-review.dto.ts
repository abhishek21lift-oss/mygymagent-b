import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitMemberDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeNotes?: string;
}

export class ReviewMemberDocumentDto {
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string;
}

export class UploadDocumentVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeNotes?: string;
}
