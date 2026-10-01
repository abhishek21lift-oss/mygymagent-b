/**
 * What a member's WhatsApp message is asking for, read from its words.
 *
 * Deliberately plain keyword matching, not a language model: it costs
 * nothing per message, answers in the same way every time, and a message
 * it does not understand is left for the gym's staff rather than guessed
 * at. Hinglish spellings members actually type are included, and the
 * same words in Hindi script.
 */
export type AutoReplyIntent =
  | 'MENU'
  | 'PLANS'
  | 'CLASSES'
  | 'HOURS'
  | 'MY_PLAN'
  | 'CONTACT'
  | 'THANKS'
  | 'UNKNOWN';

/**
 * Questions only a person can answer, though they contain a keyword:
 * "diet plan" is not about membership plans, "PT fees" is not the
 * membership price list, "payment baaki hai" is not a menu. Any of these
 * leaves the message to staff (with the once-a-day "our team will reply").
 */
const FOR_STAFF = [
  'diet',
  'diet chart',
  'nutrition',
  'pt',
  'personal trainer',
  'personal training',
  'trainer',
  'freeze',
  'pause',
  'hold',
  'refund',
  'cancel',
  'complaint',
  'payment',
  'paid',
  'pay',
  'due',
  'dues',
  'baaki',
  'baki',
  'pending',
  'डाइट',
  'ट्रेनर',
  'पेमेंट',
  'बाकी',
];

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
      'मेरा प्लान',
      'मेरी मेंबरशिप',
      'रिन्यू',
      'कब तक',
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
      'batch',
      'batches',
      'session',
      'sessions',
      'yoga',
      'zumba',
      'aerobics',
      'क्लास',
      'योगा',
      'योग',
      'ज़ुम्बा',
      'जुम्बा',
    ],
  ],
  // The gym's own hours. After CLASSES, so "class timings" is about
  // classes; before PLANS, so "kitne baje khulta hai" is not about price.
  [
    'HOURS',
    [
      'timing',
      'timings',
      'hours',
      'open',
      'opens',
      'opening',
      'close',
      'closes',
      'closing',
      'closed',
      'khulta',
      'khulti',
      'khulega',
      'khulte',
      'baje',
      'टाइम',
      'टाइमिंग',
      'समय',
      'खुलता',
      'खुलेगा',
      'बजे',
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
      'फीस',
      'प्लान',
      'मेंबरशिप',
      'कीमत',
      'कितना',
      'कितने',
      'पैसे',
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
      'पता',
      'कहाँ',
      'कहां',
      'लोकेशन',
      'नंबर',
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
      'नमस्ते',
      'हेलो',
      'हाय',
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
      'धन्यवाद',
      'शुक्रिया',
      'ठीक है',
    ],
  ],
];

/** Lower-case words, punctuation and emoji dropped, single-spaced.
 * `\p{M}` is kept: Hindi vowel signs are marks, and dropping them split
 * "फीस" into pieces no keyword matches. */
function normalise(text: string): string {
  return ` ${text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()} `;
}

const has = (words: string, keyword: string) =>
  words.includes(` ${keyword.normalize('NFC')} `);

export function detectIntent(text: string): AutoReplyIntent {
  const words = normalise(text);
  if (words.trim() === '') return 'UNKNOWN';
  // A long message is a real question for a person, not a keyword.
  if (words.trim().split(' ').length > 12) return 'UNKNOWN';
  if (FOR_STAFF.some((keyword) => has(words, keyword))) return 'UNKNOWN';
  for (const [intent, keywords] of WORDS) {
    if (keywords.some((keyword) => has(words, keyword))) {
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
