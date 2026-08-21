import { IsIn } from 'class-validator';

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
}
