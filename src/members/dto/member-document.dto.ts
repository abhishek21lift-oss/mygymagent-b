import { IsIn, IsOptional, IsString } from 'class-validator';

const DOCUMENT_CATEGORIES = [
  'DOCUMENT',
  'PROGRESS_PHOTO',
  'ID_SCAN',
  'OTHER',
] as const;

/// The file itself arrives as multipart form data (see
/// MemberDocumentsController's @UseInterceptors(FileInterceptor('file')))
/// -- this DTO only validates the accompanying fields.
export class CreateMemberDocumentDto {
  @IsIn(DOCUMENT_CATEGORIES)
  category!: (typeof DOCUMENT_CATEGORIES)[number];

  @IsOptional()
  @IsString()
  description?: string;
}
