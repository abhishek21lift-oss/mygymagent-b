/**
 * D-DB02 (F-DB02): single home for member contact normalization.
 *
 * Identity comparisons (duplicate detection, OTP lookup) must compare
 * like with like: `Rahul@Gym.com` and `rahul@gym.com` are the same mailbox,
 * and `+91 98765 43210` and `9876543210` are the same handset. Writers
 * normalize through these helpers so stored values converge to one form
 * (lowercase email, raw-digit phones) and readers compare normalized
 * values instead of raw input. Blank/whitespace-only input normalizes to
 * null so "no contact given" is always NULL in the database -- never an
 * empty string -- which keeps future partial unique indexes clean.
 *
 * Pure functions: no database, no framework. Covered by
 * contact-normalization.spec.ts.
 */

/** Trim + lowercase an email; blank becomes null (never ''). */
export function normalizeEmail(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim().toLowerCase();
  return v === '' ? null : v;
}

/** Strip a phone number to digits only; blank becomes null (never ''). */
export function normalizePhoneDigits(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const v = value.replace(/\D/g, '');
  return v === '' ? null : v;
}

/**
 * Last-ten-digits lookup key, matching the OTP service's phoneKey
 * convention (data/customer-enquiry-mapping.ts): a member typing
 * 9876543210 finds the record stored as +919876543210. Returns null
 * when there are fewer than 10 digits (too short to match on safely).
 */
export function phoneLookupKey(
  value: string | null | undefined,
): string | null {
  const digits = normalizePhoneDigits(value);
  if (!digits || digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Normalize the identity fields of a member create/update payload in
 * place (request-scoped DTO objects only). `undefined` stays `undefined`
 * (field untouched on PATCH) and explicit `null` stays `null` (field
 * cleared -- the clear semantic pinned by members-contact-fields.spec.ts);
 * blank strings become `undefined` so empty input never persists as ''.
 */
export function normalizeMemberContact<
  T extends {
    email?: string | null;
    phone?: string | null;
    alternatePhone?: string | null;
    emergencyContactEmail?: string | null;
  },
>(dto: T): void {
  if (dto.email !== undefined && dto.email !== null)
    dto.email = normalizeEmail(dto.email) ?? undefined;
  if (dto.phone !== undefined && dto.phone !== null)
    dto.phone = normalizePhoneDigits(dto.phone) ?? undefined;
  if (dto.alternatePhone !== undefined && dto.alternatePhone !== null)
    dto.alternatePhone = normalizePhoneDigits(dto.alternatePhone) ?? undefined;
  if (
    dto.emergencyContactEmail !== undefined &&
    dto.emergencyContactEmail !== null
  )
    dto.emergencyContactEmail =
      normalizeEmail(dto.emergencyContactEmail) ?? undefined;
}
