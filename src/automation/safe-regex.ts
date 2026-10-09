import * as vm from 'vm';

/**
 * Staff write the REGEX auto-reply rules and any WhatsApp sender writes
 * the text they run against, on the API's one event loop. A pattern that
 * backtracks catastrophically (`(a+)+$` against thirty a's and a `!`)
 * would stall every gym's requests, so a rule is matched under a
 * deadline and against a bounded slice of the message.
 */
export const REGEX_TIMEOUT_MS = 50;
export const REGEX_MAX_INPUT = 1000;

const context = vm.createContext({ re: null, s: '' });
const run = new vm.Script('re.test(s)');

/**
 * `true`/`false` for a match, `null` when the pattern ran out of time --
 * which the caller treats as no match.
 */
export function boundedTest(re: RegExp, input: string): boolean | null {
  context.re = re;
  context.s = input.slice(0, REGEX_MAX_INPUT);
  try {
    return run.runInContext(context, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    return null;
  } finally {
    context.re = null;
    context.s = '';
  }
}

// A group with a quantifier inside that is itself quantified: `(a+)+`,
// `(\w*\s?)*`, `(x{1,3})+`. The shape behind nearly all exponential
// backtracking.
const NESTED_QUANTIFIER =
  /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;

// Inputs that make a backtracking pattern show itself.
const PROBES = ['a', '1', ' ', 'x', 'aa', 'ab', '0 '].flatMap((unit) => [
  unit.repeat(400) + '!',
  unit.repeat(400) + '\n',
]);

/** Why a pattern can't be saved, or null when it can. */
export function unsafeRegexReason(pattern: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return 'keyword is not a valid regular expression';
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return 'keyword repeats a group that already repeats, e.g. (a+)+; write it without the outer repeat';
  }
  for (const probe of PROBES) {
    if (boundedTest(re, probe) === null) {
      return 'keyword takes too long to match; simplify the pattern';
    }
  }
  return null;
}
