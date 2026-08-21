import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const CONSENT_TYPES = [
  'WAIVER',
  'MARKETING',
  'PHOTO_RELEASE',
  'DATA_PROCESSING',
  'OTHER',
] as const;

/// No update DTO -- consents are append-only (see the model comment in
/// schema.prisma). Recording a member's decision again (e.g. revoking)
/// means POSTing a new row with the same type and granted=false, never
/// PATCHing an existing one.
export class CreateMemberConsentDto {
  @IsIn(CONSENT_TYPES)
  type!: (typeof CONSENT_TYPES)[number];

  @IsBoolean()
  granted!: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}
