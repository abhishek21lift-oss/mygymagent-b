/**
 * Variable names allowed in message templates. Must follow the real data
 * models: every name here is either injected by CommunicationsService
 * (organizationName, salutation) or passed by a scanner/listener that
 * reads it from Member/Membership/Invoice/Payment/Lead rows.
 */
export const ALLOWED_TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  'firstName',
  'lastName',
  'organizationName',
  'salutation',
  'planName',
  'expiryDate',
  'amount',
  'currency',
  'invoiceNumber',
  'paymentId',
  'dueState',
  'dueDate',
  'daysInactive',
  'packageName',
  'remainingSessions',
  'leadName',
  'note',
  'productName',
  'sku',
  'quantityOnHand',
  'reorderLevel',
  'token',
  'resetUrl',
  '1',
  '2',
  '3',
  '4',
  '5',
]);

/** Variables a gym may use in its customized bill message. */
export const BILL_MESSAGE_VARIABLES: ReadonlySet<string> = new Set([
  'firstName',
  'organizationName',
  'salutation',
  'invoiceNumber',
  'amount',
  'currency',
  'dueState',
  'dueDate',
]);

const VARIABLE_RE = /\{\{(\w+)\}\}/g;

/** Placeholder names in `text` that no sender can resolve. */
export function findUnknownVariables(
  text: string,
  allowed: ReadonlySet<string> = ALLOWED_TEMPLATE_VARIABLES,
): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(VARIABLE_RE)) {
    if (!allowed.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown];
}

/** True when rendering left a `{{placeholder}}` behind -- such a body
 * must never go to a customer. */
export function hasUnresolvedVariables(text: string): boolean {
  VARIABLE_RE.lastIndex = 0;
  return VARIABLE_RE.test(text);
}
