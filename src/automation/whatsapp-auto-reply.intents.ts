/**
 * What a member's WhatsApp message is asking for, read from its words.
 *
 * Deliberately plain keyword matching, not a language model: it costs
 * nothing per message, answers in the same way every time, and a message
 * it does not understand is left for the gym's staff rather than guessed
 * at. Hinglish spellings members actually type are included.
 */
export type AutoReplyIntent =
  'MENU' | 'PLANS' | 'CLASSES' | 'MY_PLAN' | 'CONTACT' | 'THANKS' | 'UNKNOWN';

const WORDS: Array<[Exclude<AutoReplyIntent, 'UNKNOWN'>, string[]]> = [
  // Asked about their own membership: checked before PLANS, since "my
  // membership" also contains "membership".
  [
    'MY_PLAN',
    [
      'my plan',
      'my membership',
      'mera plan',
      'meri membership',
      'renew',
      'renewal',
      'expiry',
      'expire',
      'expires',
      'expired',
      'validity',
      'valid till',
      'kab tak',
      'khatam',
      'status',
    ],
  ],
  [
    'PLANS',
    [
      'plan',
      'plans',
      'membership',
      'memberships',
      'price',
      'prices',
      'pricing',
      'fee',
      'fees',
      'cost',
      'charges',
      'rate',
      'rates',
      'package',
      'packages',
      'kitna',
      'kitne',
      'kitni',
      'paise',
      'join',
      'joining',
    ],
  ],
  [
    'CLASSES',
    [
      'class',
      'classes',
      'schedule',
      'schedules',
      'timetable',
      'timing',
      'timings',
      'batch',
      'batches',
      'session',
      'sessions',
      'yoga',
      'zumba',
      'aerobics',
    ],
  ],
  [
    'CONTACT',
    [
      'address',
      'location',
      'where',
      'kahan',
      'kaha',
      'contact',
      'phone',
      'call',
      'number',
      'direction',
      'directions',
      'map',
    ],
  ],
  [
    'MENU',
    [
      'hi',
      'hii',
      'hiii',
      'hello',
      'helo',
      'hey',
      'help',
      'menu',
      'start',
      'info',
      'namaste',
      'namaskar',
      'options',
    ],
  ],
  [
    'THANKS',
    [
      'thanks',
      'thank you',
      'thankyou',
      'thx',
      'ty',
      'ok',
      'okay',
      'shukriya',
      'dhanyavad',
    ],
  ],
];

/** Lower-case words, punctuation and emoji dropped, single-spaced. */
function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

export function detectIntent(text: string): AutoReplyIntent {
  const words = normalise(text);
  if (words.trim() === '') return 'UNKNOWN';
  // A long message is a real question for a person, not a keyword.
  if (words.trim().split(' ').length > 12) return 'UNKNOWN';
  for (const [intent, keywords] of WORDS) {
    if (keywords.some((keyword) => words.includes(` ${keyword} `))) {
      return intent;
    }
  }
  return 'UNKNOWN';
}

/** "30 days" read the way a gym sells it: "1 month", "3 months", "1 year". */
export function readableDuration(days: number): string {
  if (days === 365 || days === 366) return '1 year';
  if (days % 365 === 0) return `${days / 365} years`;
  if (days === 30 || days === 31) return '1 month';
  if (days % 30 === 0) return `${days / 30} months`;
  if (days === 7) return '1 week';
  if (days % 7 === 0) return `${days / 7} weeks`;
  return days === 1 ? '1 day' : `${days} days`;
}
