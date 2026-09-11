import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** WON is deliberately excluded -- it's set only via POST
 * /leads/:id/convert, never directly, so "WON" and "has a linked Member"
 * can never drift apart. See the Lead model's schema comment. */
const DIRECTLY_SETTABLE_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL',
  'LOST',
] as const;

export class UpdateLeadStatusDto {
  @IsIn(DIRECTLY_SETTABLE_STATUSES)
  status!: (typeof DIRECTLY_SETTABLE_STATUSES)[number];

  /**
   * Required when status is LOST (the frontend lost-lead dialog enforces
   * this too) -- persisted to Lead.lostReason and surfaced via
   * GET /analytics/sales/lost-reasons. Ignored for other statuses.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
