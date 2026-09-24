/**
 * Turning a "Customer Enquiry" export into members and leads.
 *
 * Kept separate from the service, and free of Prisma, because the part
 * that goes wrong here is the mapping, not the writing -- and the
 * mapping is worth testing against the real file without a database.
 *
 * Every decision below exists because the previous version got it
 * wrong on the actual 1342-row export:
 *
 * - Dates arrive as `DD-MM-YYYY` and were parsed with `new Date(v)`.
 *   V8 reads that as American `MM-DD-YYYY`, so `11-05-2026` became
 *   5 November instead of 11 May -- silently, with no error. Where the
 *   day exceeded 12 it was simply invalid and the caller fell back to
 *   "now". Of 952 member rows, 22 join dates would have been right,
 *   272 silently wrong and 655 replaced by the import timestamp.
 * - The phone was stored as the bare 10-digit local number while the
 *   country code sat in a column that was dropped into a notes blob.
 *   `Member.phone` is what the WhatsApp provider passes to Meta as
 *   `to:`, and Meta needs the country code, so every message to an
 *   imported record would have failed.
 * - `"None"`, `"UNKNOWN"` and `"0"` are how this export spells "empty".
 *   They were being stored as if they were values.
 */

export interface EnquiryRow {
  [column: string]: string | null | undefined;
}

/** How this export spells "no value". Applied to descriptive columns
 * only -- never to a phone number or a source code, where a literal
 * "0" would be a different kind of problem. */
const PLACEHOLDERS = new Set(['NONE', 'UNKNOWN', 'N/A', 'NA', '-', '0', 'NIL']);

export function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v ? v : null;
}

/** `clean`, plus the export's placeholder vocabulary. */
export function meaningful(value: unknown): string | null {
  const v = clean(value);
  if (!v) return null;
  return PLACEHOLDERS.has(v.toUpperCase()) ? null : v;
}

export function normalizeName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * `Member.lastName` is NOT NULL and 183 of these people are recorded
 * under a single word. Repeating the first name is the least-bad way
 * to satisfy the column, but it does produce "Amiy Amiy" on screen, so
 * the caller is told which rows it happened to rather than finding out
 * from the members list.
 */
export function splitName(
  value: string | null | undefined,
): { firstName: string; lastName: string; singleWord: boolean } | null {
  const name = clean(value);
  if (!name) return null;
  const parts = name.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: parts[0], singleWord: true };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    singleWord: false,
  };
}

/**
 * `DD-MM-YYYY`, parsed as written.
 *
 * Explicitly not `new Date(string)`: that reads `11-05-2026` as
 * 5 November 2026. Rollover is rejected too, so `31-02-2025` is an
 * error rather than 3 March.
 */
export function parseDayFirstDate(value: unknown): Date | null {
  const v = clean(value);
  if (!v) return null;
  const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export const DEFAULT_COUNTRY_CODE = '91';

/**
 * The stored phone, in E.164.
 *
 * `Member.phone` and `Lead.phone` are handed straight to Meta as the
 * WhatsApp recipient, and Meta needs the country code. The export
 * carries it in a separate column -- in this file it is exactly
 * `91 + Number` on all 1342 rows -- so that column is preferred and
 * any row where the two disagree is reported rather than guessed at.
 */
export function toE164(
  localNumber: unknown,
  withCountryCode: unknown,
  countryCode = DEFAULT_COUNTRY_CODE,
): { phone: string | null; disagreement: string | null } {
  const local = clean(localNumber)?.replace(/\D/g, '') ?? null;
  const full = clean(withCountryCode)?.replace(/\D/g, '') ?? null;

  if (full && local && full !== `${countryCode}${local}`) {
    return {
      phone: full.length >= 11 ? `+${full}` : null,
      disagreement: `${local} vs ${full}`,
    };
  }
  if (full && full.length >= 11)
    return { phone: `+${full}`, disagreement: null };
  if (local && local.length === 10) {
    return { phone: `+${countryCode}${local}`, disagreement: null };
  }
  return { phone: null, disagreement: null };
}

/** Compares numbers by their last ten digits, so a record stored as
 * `+916393786886` still matches one typed in as `6393786886`. */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = clean(value)?.replace(/\D/g, '') ?? null;
  if (!digits || digits.length < 10) return null;
  return digits.slice(-10);
}

export function validEmail(value: unknown): string | null {
  const v = clean(value)?.toLowerCase() ?? null;
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function mapGender(value: unknown): 'MALE' | 'FEMALE' | 'OTHER' | null {
  const v = clean(value)?.toUpperCase();
  if (v === 'MALE' || v === 'M') return 'MALE';
  if (v === 'FEMALE' || v === 'F') return 'FEMALE';
  if (v === 'OTHER') return 'OTHER';
  return null;
}

/**
 * What the export knows that the schema has no column for.
 *
 * Only values that survive `meaningful()` are written, so the notes do
 * not fill up with "Source Notes: None" -- which is what 33 rows in
 * this file would otherwise have produced.
 */
export function sourceNotes(row: EnquiryRow, code: string | null): string {
  const pairs: Array<[string, string | null]> = [
    ['Source Code', code],
    ['Date of Enquiry', meaningful(row['Date of Enquiry'])],
    ['Conversion Date', meaningful(row['Conversion Date'])],
    ['Lead Type', meaningful(row['Lead Type'])],
    ['Source of Promo', meaningful(row['Source of Promo'])],
    ['Employment Type', meaningful(row['Employment Type'])],
    ['App Installed', meaningful(row['App Installed'])],
    ['Handled By', meaningful(row['Handled By'])],
    ['Reference No', meaningful(row['Reference No'])],
    ['Emergency Contact No', meaningful(row['Emergency Contact No'])],
    ['Source Assigned Trainer', meaningful(row['Assigned Trainer'])],
    ['Source Notes', meaningful(row['Notes'])],
  ];
  return [
    '[Imported from Customer Enquiry export]',
    ...pairs
      .filter(([, value]) => value !== null)
      .map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
}

/**
 * Member or lead.
 *
 * A row is a member when the gym's own system says it has a membership
 * status; "Not assigned" with no conversion date is still a prospect.
 * "Not assigned" *with* a conversion date is neither under the old
 * rule, and was dropped without a word -- it is now reported.
 */
export type RowKind = 'member' | 'lead' | 'ambiguous';

export function classifyRow(row: EnquiryRow): RowKind {
  const status = clean(row['Membership Status']);
  if (status && status !== 'Not assigned') return 'member';
  if (!clean(row['Conversion Date'])) return 'lead';
  return 'ambiguous';
}
