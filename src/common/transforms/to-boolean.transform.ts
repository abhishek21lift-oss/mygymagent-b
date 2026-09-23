import { Transform } from 'class-transformer';

/**
 * Converts the string form of a boolean that a query string necessarily
 * carries (`?overdue=true`) into a real boolean, and leaves **everything
 * else untouched** so `@IsBoolean()` is the one that decides.
 *
 * That last part is the whole point. The two obvious alternatives are both
 * the bug this exists to prevent (B-P0-7):
 *
 *  - `enableImplicitConversion` and `@Type(() => Boolean)` both apply
 *    `Boolean(value)`, under which the strings "false" and "0" are `true`.
 *    A client opting *out* was silently opted *in*, and `@IsBoolean()`
 *    never saw a value it could reject.
 *  - `value === 'true'` quietly maps anything unrecognised to `false`,
 *    which turns a typo into a silent, wrong answer instead of a 400.
 *
 * Only `true`/`false` and their case-insensitive string forms convert.
 * `"1"`, `"yes"` and `"nope"` alike fall through to `@IsBoolean()` and
 * earn an explicit 400 -- guessing at intent is what got us here.
 *
 * Always pair it with `@IsBoolean()`; on its own it validates nothing.
 *
 * **Query DTOs only.** A JSON body carries real types, so a string there
 * is a client bug and plain `@IsBoolean()` should reject it -- adding this
 * would quietly accept `{"isTrainer": "false"}`, which is leniency of the
 * same family as the bug above, just in the other direction.
 */
export const ToBoolean = () =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    // Read from `obj` rather than `value`: `value` has already been
    // through any conversion class-transformer chose to apply, and the
    // untouched input is exactly what this needs to judge.
    const raw = obj[key];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return raw;
  });
