/** Customer salutations for WhatsApp sends (single-select). The list is
 * closed on purpose: free-text greetings produce inconsistent casing and
 * duplicate greetings ("Dear Hi Rahul") once templates change. */
export const SALUTATIONS = [
  'Dear',
  'Hello',
  'Respected',
  'Hi',
  'Hey',
  'Greetings',
] as const;

export type Salutation = (typeof SALUTATIONS)[number];

export function isSalutation(value: unknown): value is Salutation {
  return (
    typeof value === 'string' &&
    (SALUTATIONS as readonly string[]).includes(value)
  );
}

/** Leading greeting words the system templates start with ("Hi {{1}}",
 * "Hello {{1}}"). Anything else -- "Happy birthday, ..." -- is left
 * alone: forcing a salutation there would read worse, not better. */
const LEADING_GREETING_RE = /^(Hi|Hello|Dear|Hey|Greetings|Respected)([ ,])/;

/**
 * Applies the gym's greeting without duplication: a body that already
 * starts with a greeting word gets it swapped, any other body is
 * returned unchanged.
 */
export function applySalutation(body: string, salutation: string): string {
  if (!isSalutation(salutation)) return body;
  if (!LEADING_GREETING_RE.test(body)) return body;
  return body.replace(LEADING_GREETING_RE, `${salutation}$2`);
}
