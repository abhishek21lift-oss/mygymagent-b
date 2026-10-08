/**
 * Pure matching for P4 staff rules + bot commands: no DB, no I/O, so the
 * spec pins behavior without fakes. Ordering: EXACT, then CONTAINS, then
 * REGEX; within a tier, lower `priority` first.
 */
export interface StaffRule {
  id: string;
  keyword: string;
  matchType: 'EXACT' | 'CONTAINS' | 'REGEX';
  scope: 'ALL' | 'PRIVATE' | 'GROUP';
  answer: string;
  enabled: boolean;
  priority: number;
}

export function matchRule(
  rules: StaffRule[],
  text: string | null | undefined,
  isGroup: boolean,
): StaffRule | null {
  const body = (text ?? '').trim();
  if (!body) return null;
  const live = rules.filter(
    (r) =>
      r.enabled &&
      (r.scope === 'ALL' ||
        (isGroup ? r.scope === 'GROUP' : r.scope === 'PRIVATE')),
  );
  const byPriority = (a: StaffRule, b: StaffRule) => a.priority - b.priority;
  const lowered = body.toLowerCase();
  for (const tier of ['EXACT', 'CONTAINS', 'REGEX'] as const) {
    for (const rule of live
      .filter((r) => r.matchType === tier)
      .sort(byPriority)) {
      if (tier === 'EXACT') {
        if (lowered === rule.keyword.toLowerCase()) return rule;
      } else if (tier === 'CONTAINS') {
        if (lowered.includes(rule.keyword.toLowerCase())) return rule;
      } else {
        let re: RegExp;
        try {
          re = new RegExp(rule.keyword, 'i');
        } catch {
          // A staff typo must never break the reply chain.
          continue;
        }
        if (re.test(body)) return rule;
      }
    }
  }
  return null;
}

export type BotCommand = 'help' | 'stop' | 'start';

/** `#help`, case-insensitive, first token only. */
export function parseBotCommand(
  text: string | null | undefined,
): BotCommand | null {
  const first = (text ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (first === '#help') return 'help';
  if (first === '#stop') return 'stop';
  if (first === '#start') return 'start';
  return null;
}
